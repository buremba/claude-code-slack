#!/usr/bin/env bun

import { readFile, watch } from "fs/promises";
import type { SlackMessageManager } from "./operations/message";
import type { SlackReactionManager } from "./operations/reactions";
import type { SlackContext } from "./types";
import { formatIncrementalUpdate } from "../core/formatter";

export interface StreamingConfig {
  updateIntervalMs?: number;
  maxUpdateFrequency?: number; // Max updates per minute to avoid rate limits
  enableProgressUpdates?: boolean;
  bufferUpdates?: boolean; // Buffer multiple updates before sending
  bufferTimeMs?: number;
}

export interface StreamingUpdate {
  content: string;
  isComplete: boolean;
  metadata?: {
    cost?: number;
    duration?: number;
    success?: boolean;
  };
}

export class SlackStreamingManager {
  private messageManager: SlackMessageManager;
  private reactionManager: SlackReactionManager;
  private config: StreamingConfig;
  private updateQueue: any[] = [];
  private lastUpdateTime: number = 0;
  private updateCount: number = 0;
  private bufferTimer: NodeJS.Timeout | null = null;

  constructor(
    messageManager: SlackMessageManager,
    reactionManager: SlackReactionManager,
    config: StreamingConfig = {},
  ) {
    this.messageManager = messageManager;
    this.reactionManager = reactionManager;
    this.config = {
      updateIntervalMs: config.updateIntervalMs || 3000, // 3 seconds
      maxUpdateFrequency: config.maxUpdateFrequency || 20, // 20 updates per minute
      enableProgressUpdates: config.enableProgressUpdates !== false,
      bufferUpdates: config.bufferUpdates !== false,
      bufferTimeMs: config.bufferTimeMs || 2000, // 2 seconds
    };
  }

  /**
   * Start monitoring Claude execution for streaming updates
   */
  async startStreaming(
    context: SlackContext,
    messageTs: string,
    executionFilePath?: string,
  ): Promise<void> {
    if (!this.config.enableProgressUpdates) {
      return;
    }

    // Reset tracking
    this.updateCount = 0;
    this.lastUpdateTime = Date.now();

    if (executionFilePath) {
      await this.monitorExecutionFile(context, messageTs, executionFilePath);
    }
  }

  /**
   * Monitor Claude execution file for new content
   */
  private async monitorExecutionFile(
    context: SlackContext,
    messageTs: string,
    filePath: string,
  ): Promise<void> {
    let lastContent = "";
    let watcherActive = true;

    // Set up file watcher
    const watcher = watch(filePath);
    
    // Also poll periodically as backup
    const pollInterval = setInterval(async () => {
      if (!watcherActive) {
        clearInterval(pollInterval);
        return;
      }
      
      await this.checkFileForUpdates(context, messageTs, filePath, lastContent);
    }, this.config.updateIntervalMs);

    try {
      for await (const event of watcher) {
        if (!watcherActive) break;
        
        if (event.eventType === "change") {
          const newContent = await this.checkFileForUpdates(
            context, 
            messageTs, 
            filePath, 
            lastContent
          );
          if (newContent !== null) {
            lastContent = newContent;
          }
        }
      }
    } catch (error) {
      console.error("Error monitoring execution file:", error);
    } finally {
      watcherActive = false;
      clearInterval(pollInterval);
    }
  }

  /**
   * Check file for updates and process them
   */
  private async checkFileForUpdates(
    context: SlackContext,
    messageTs: string,
    filePath: string,
    lastContent: string,
  ): Promise<string | null> {
    try {
      const content = await readFile(filePath, "utf-8");
      
      if (content !== lastContent && content.trim()) {
        await this.processExecutionUpdate(context, messageTs, content);
        return content;
      }
    } catch (error) {
      // File might not exist yet or be partially written
      console.debug("Could not read execution file:", error);
    }
    
    return null;
  }

  /**
   * Process updates from Claude execution
   */
  private async processExecutionUpdate(
    context: SlackContext,
    messageTs: string,
    executionContent: string,
  ): Promise<void> {
    try {
      // Parse execution JSON
      const executionData = JSON.parse(executionContent);
      
      if (!Array.isArray(executionData)) {
        return;
      }

      // Format the latest updates for Slack
      const formattedContent = formatIncrementalUpdate(executionData, "slack");
      
      // Check if this is a completion
      const isComplete = this.isExecutionComplete(executionData);
      const metadata = isComplete ? this.extractExecutionMetadata(executionData) : undefined;

      // Queue or send update
      if (this.config.bufferUpdates && !isComplete) {
        this.queueUpdate(context, messageTs, formattedContent, isComplete, metadata);
      } else {
        await this.sendUpdate(context, messageTs, formattedContent, isComplete, metadata);
      }
    } catch (error) {
      console.error("Error processing execution update:", error);
    }
  }

  /**
   * Queue update for batching
   */
  private queueUpdate(
    context: SlackContext,
    messageTs: string,
    content: string,
    isComplete: boolean,
    metadata?: any,
  ): void {
    this.updateQueue.push({ context, messageTs, content, isComplete, metadata });

    // Clear existing timer
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
    }

    // Set new timer to flush queue
    this.bufferTimer = setTimeout(() => {
      this.flushUpdateQueue();
    }, this.config.bufferTimeMs);
  }

  /**
   * Flush queued updates
   */
  private async flushUpdateQueue(): Promise<void> {
    if (this.updateQueue.length === 0) {
      return;
    }

    // Get the latest update (most recent content)
    const latestUpdate = this.updateQueue[this.updateQueue.length - 1];
    this.updateQueue = [];

    await this.sendUpdate(
      latestUpdate.context,
      latestUpdate.messageTs,
      latestUpdate.content,
      latestUpdate.isComplete,
      latestUpdate.metadata,
    );
  }

  /**
   * Send update to Slack with rate limiting
   */
  private async sendUpdate(
    context: SlackContext,
    messageTs: string,
    content: string,
    isComplete: boolean,
    metadata?: any,
  ): Promise<void> {
    // Check rate limiting
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;
    const minInterval = 60000 / this.config.maxUpdateFrequency!; // Convert to ms

    if (timeSinceLastUpdate < minInterval && !isComplete) {
      // Skip this update to avoid rate limiting
      console.debug("Skipping update due to rate limiting");
      return;
    }

    try {
      if (isComplete && metadata) {
        // Final update with metadata
        await this.messageManager.finalizeResponse(
          context.channelId,
          messageTs,
          content,
          metadata,
        );
        
        // Update reaction to completed status
        await this.reactionManager.setCompletedStatus(context);
      } else {
        // Progress update
        await this.messageManager.updateResponse(
          context.channelId,
          messageTs,
          content,
        );
      }

      this.lastUpdateTime = now;
      this.updateCount++;
    } catch (error) {
      console.error("Error sending update to Slack:", error);
    }
  }

  /**
   * Handle manual progress update
   */
  async updateProgress(
    context: SlackContext,
    messageTs: string,
    update: StreamingUpdate,
  ): Promise<void> {
    await this.sendUpdate(
      context,
      messageTs,
      update.content,
      update.isComplete,
      update.metadata,
    );
  }

  /**
   * Handle execution completion
   */
  async completeExecution(
    context: SlackContext,
    messageTs: string,
    finalContent: string,
    metadata?: {
      cost?: number;
      duration?: number;
      success?: boolean;
    },
  ): Promise<void> {
    // Flush any pending updates first
    await this.flushUpdateQueue();

    // Validate content before completing execution
    if (!finalContent || finalContent.trim().length === 0) {
      console.warn("completeExecution called with empty content, using fallback");
      finalContent = "✅ Task completed successfully";
    }

    // Send final update
    await this.messageManager.finalizeResponse(
      context.channelId,
      messageTs,
      finalContent,
      metadata,
    );

    // Update reaction to completed or error status
    if (metadata?.success !== false) {
      await this.reactionManager.setCompletedStatus(context);
    } else {
      await this.reactionManager.setErrorStatus(context);
    }
  }

  /**
   * Handle execution error
   */
  async handleExecutionError(
    context: SlackContext,
    messageTs: string,
    error: string,
  ): Promise<void> {
    console.error("Handling execution error:", error);
    
    // Provide clear error feedback
    const errorContent = `❌ **Error occurred during execution:**\n\n${error}`;
    
    await this.messageManager.updateResponse(
      context.channelId,
      messageTs,
      errorContent,
    );

    await this.reactionManager.setErrorStatus(context);
  }

  /**
   * Check if execution is complete
   */
  private isExecutionComplete(executionData: any[]): boolean {
    if (!Array.isArray(executionData) || executionData.length === 0) {
      return false;
    }

    const lastItem = executionData[executionData.length - 1];
    
    // Check for explicit completion markers
    if (lastItem?.type === "result") {
      return true;
    }
    
    // Check for assistant messages with text content
    if (lastItem?.type === "assistant" && lastItem?.message?.content?.some((c: any) => c.type === "text")) {
      return true;
    }
    
    // Also consider tool-only executions as potentially complete
    // Look for patterns indicating completion without text output
    const hasToolUsage = executionData.some(item => item.type === "tool_use");
    const hasAssistantActivity = executionData.some(item => item.type === "assistant");
    
    // If we have tool usage or assistant activity but no recent text, 
    // this might be a tool-only completion that needs special handling
    if (hasToolUsage || hasAssistantActivity) {
      // Check if there's been recent activity without text output
      const recentItems = executionData.slice(-5); // Last 5 items
      const hasRecentToolUse = recentItems.some(item => item.type === "tool_use");
      const hasRecentText = recentItems.some(item => 
        item.type === "assistant" && 
        item.message?.content?.some((c: any) => c.type === "text")
      );
      
      // If recent tool use but no recent text, this might be complete
      return hasRecentToolUse && !hasRecentText;
    }
    
    return false;
  }

  /**
   * Extract metadata from execution data
   */
  private extractExecutionMetadata(executionData: any[]): any {
    const resultItem = executionData.find(item => item.type === "result");
    
    if (resultItem) {
      return {
        cost: resultItem.cost_usd,
        duration: resultItem.duration_ms,
        success: true,
      };
    }

    return { success: true };
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
    this.updateQueue = [];
  }
}