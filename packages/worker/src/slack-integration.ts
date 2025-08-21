#!/usr/bin/env bun

import { WebClient } from "@slack/web-api";
import type { SlackConfig } from "./types";
import { SlackError } from "./types";
import { markdownToSlackWithBlocks } from "./slack/blockkit-parser";
import logger from "./logger";

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export class SlackIntegration {
  private client: WebClient;
  private responseChannel: string;
  private responseTs: string;
  private lastUpdateTime = 0;
  private updateQueue: string[] = [];
  private isProcessingQueue = false;
  private contextBlock: any = null; // Store the context header block
  private currentTodos: TodoItem[] = []; // Store the current todo list

  constructor(config: SlackConfig) {
    
    // Initialize with static token, will refresh if needed
    this.client = new WebClient(config.token);
    
    // Get response location from environment
    this.responseChannel = process.env.SLACK_RESPONSE_CHANNEL!;
    this.responseTs = process.env.SLACK_RESPONSE_TS!;
  }

  /**
   * Set the context block that should persist across updates
   */
  setContextBlock(block: any): void {
    this.contextBlock = block;
  }

  /**
   * Update progress message in Slack
   */
  async updateProgress(content: string): Promise<void> {
    try {
      // Rate limiting: don't update more than once every 2 seconds
      const now = Date.now();
      if (now - this.lastUpdateTime < 2000) {
        // Queue the update
        this.updateQueue.push(content);
        this.processQueue();
        return;
      }

      await this.performUpdate(content);
      this.lastUpdateTime = now;

    } catch (error) {
      logger.error("Failed to update Slack progress:", error);
      // Don't throw - worker should continue even if Slack updates fail
    }
  }

  /**
   * Stream progress updates (for real-time Claude output)
   */
  async streamProgress(data: any): Promise<void> {
    try {
      // Handle both string and object data
      let dataToCheck: string;
      
      if (typeof data === "string" && data.trim()) {
        dataToCheck = data;
      } else if (typeof data === "object") {
        dataToCheck = JSON.stringify(data);
      } else {
        return;
      }
      
      // Check if this contains TodoWrite tool usage
      const todoData = this.extractTodoList(dataToCheck);
      if (todoData) {
        this.currentTodos = todoData;
        await this.updateProgressWithTodos();
        return;
      }
      
      // Stream the content normally
      if (typeof data === "string") {
        await this.updateProgress(data);
      } else if (typeof data === "object" && data.content) {
        await this.updateProgress(data.content);
      }
    } catch (error) {
      logger.error("Failed to stream progress:", error);
    }
  }

  /**
   * Process queued updates
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.updateQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      // Wait for rate limit, then send the latest update
      const delay = Math.max(0, 2000 - (Date.now() - this.lastUpdateTime));
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Get the latest update from queue
      const latestUpdate = this.updateQueue.pop();
      this.updateQueue = []; // Clear queue

      if (latestUpdate) {
        await this.performUpdate(latestUpdate);
        this.lastUpdateTime = Date.now();
      }

    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Perform the actual Slack update
   */
  private async performUpdate(content: string): Promise<void> {
    try {
      logger.info(`performUpdate called with content length: ${content.length}`);
      logger.info(`Response channel: ${this.responseChannel}, TS: ${this.responseTs}`);
      
      // Extract context info from context block if available
      let contextInfo: string | undefined;
      if (this.contextBlock && this.contextBlock.elements) {
        // Context block is a "context" type with elements array
        contextInfo = this.contextBlock.elements
          .map((element: any) => element.text || '')
          .join(' ');
      } else if (this.contextBlock && this.contextBlock.text && this.contextBlock.text.text) {
        // Fallback for other block types
        contextInfo = this.contextBlock.text.text;
      }
      
      // Convert markdown to Slack format with blocks support and context info
      const slackMessage = markdownToSlackWithBlocks(content, contextInfo);
      
      // Build blocks array (no longer adding context block at the top)
      let blocks: any[] = [];
      
      // Add content blocks from the message
      if (slackMessage.blocks && slackMessage.blocks.length > 0) {
        blocks.push(...slackMessage.blocks);
      } else if (slackMessage.text) {
        // If no blocks, create a section with the text
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: slackMessage.text
          }
        });
      }
      
      const updateOptions: any = {
        channel: this.responseChannel,
        ts: this.responseTs,
        text: slackMessage.text || content,
        mrkdwn: true,
      };
      
      // Only add blocks if we have them
      if (blocks.length > 0) {
        updateOptions.blocks = blocks;
      }
      
      logger.info(`Updating Slack message with ${blocks.length} blocks`);
      const result = await this.client.chat.update(updateOptions);
      logger.info(`Slack update result: ${result.ok}`);
      if (!result.ok) {
        logger.error(`Slack update failed with error: ${result.error}`);
      }

    } catch (error: any) {
      // Handle specific Slack errors
      if (error.code === "message_not_found") {
        logger.error("Slack message not found - it may have been deleted");
      } else if (error.code === "channel_not_found") {
        logger.error("Slack channel not found - bot may not have access");
      } else if (error.code === "not_in_channel") {
        logger.error("Bot is not in the channel");
      } else {
        throw new SlackError(
          "updateMessage",
          `Failed to update Slack message: ${error.message}`,
          error
        );
      }
    }
  }



  /**
   * Post a new message (for errors or additional info)
   */
  async postMessage(content: string, threadTs?: string): Promise<void> {
    try {
      // Extract context info from context block if available
      let contextInfo: string | undefined;
      if (this.contextBlock && this.contextBlock.elements) {
        // Context block is a "context" type with elements array
        contextInfo = this.contextBlock.elements
          .map((element: any) => element.text || '')
          .join(' ');
      } else if (this.contextBlock && this.contextBlock.text && this.contextBlock.text.text) {
        // Fallback for other block types
        contextInfo = this.contextBlock.text.text;
      }
      
      // Convert markdown to Slack format with blocks support
      const slackMessage = markdownToSlackWithBlocks(content, contextInfo);
      
      await this.client.chat.postMessage({
        channel: this.responseChannel,
        thread_ts: threadTs || this.responseTs,
        text: slackMessage.text,
        blocks: slackMessage.blocks,
      });

    } catch (error) {
      throw new SlackError(
        "postMessage",
        `Failed to post Slack message`,
        error as Error
      );
    }
  }

  /**
   * Add reaction to original message
   */
  async addReaction(emoji: string, timestamp?: string): Promise<void> {
    try {
      await this.client.reactions.add({
        channel: this.responseChannel,
        timestamp: timestamp || this.responseTs,
        name: emoji,
      });

    } catch (error: any) {
      // Ignore "already_reacted" errors - they're expected
      if (error?.data?.error === 'already_reacted') {
        logger.info(`Reaction ${emoji} already present`);
      } else {
        logger.error(`Failed to add reaction ${emoji}:`, error?.data?.error || error?.message || error);
      }
      // Don't throw - reactions are not critical
    }
  }

  /**
   * Remove reaction from original message
   */
  async removeReaction(emoji: string, timestamp?: string): Promise<void> {
    try {
      await this.client.reactions.remove({
        channel: this.responseChannel,
        timestamp: timestamp || this.responseTs,
        name: emoji,
      });

    } catch (error: any) {
      // Ignore "no_reaction" errors - reaction might not be there
      if (error?.data?.error === 'no_reaction') {
        logger.info(`Reaction ${emoji} not present to remove`);
      } else {
        logger.error(`Failed to remove reaction ${emoji}:`, error?.data?.error || error?.message || error);
      }
      // Don't throw - reactions are not critical
    }
  }

  /**
   * Get channel information
   */
  async getChannelInfo(): Promise<any> {
    try {
      const response = await this.client.conversations.info({
        channel: this.responseChannel,
      });
      return response.channel;

    } catch (error) {
      throw new SlackError(
        "getChannelInfo",
        "Failed to get channel information",
        error as Error
      );
    }
  }

  /**
   * Get user information
   */
  async getUserInfo(userId: string): Promise<any> {
    try {
      const response = await this.client.users.info({
        user: userId,
      });
      return response.user;

    } catch (error) {
      throw new SlackError(
        "getUserInfo",
        `Failed to get user information for ${userId}`,
        error as Error
      );
    }
  }

  /**
   * Send typing indicator
   */
  async sendTyping(): Promise<void> {
    try {
      // Show current todos if available, otherwise show thinking message
      if (this.currentTodos.length > 0) {
        await this.updateProgressWithTodos();
      } else {
        // Post a temporary "typing" message that we'll update
        await this.updateProgress("💭 Claude is thinking...");
      }

    } catch (error) {
      logger.error("Failed to send typing indicator:", error);
    }
  }

  /**
   * Format error message for Slack
   */
  formatError(error: Error, context?: string): string {
    const parts = ["❌ **Error occurred**"];
    
    if (context) {
      parts.push(`**Context:** ${context}`);
    }
    
    parts.push(`**Error:** \`${error.message}\``);
    
    if (error.stack) {
      parts.push(`**Stack trace:**\n\`\`\`\n${error.stack.substring(0, 500)}\n\`\`\``);
    }
    
    return parts.join("\n\n");
  }

  /**
   * Format success message for Slack
   */
  formatSuccess(message: string, details?: Record<string, any>): string {
    const parts = [`✅ **${message}**`];
    
    if (details) {
      for (const [key, value] of Object.entries(details)) {
        parts.push(`**${key}:** \`${value}\``);
      }
    }
    
    return parts.join("\n");
  }

  /**
   * Extract todo list from Claude's JSON output
   */
  private extractTodoList(data: string): TodoItem[] | null {
    try {
      const lines = data.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          const parsed = JSON.parse(line);
          
          // Check if this is a tool_use for TodoWrite
          if (parsed.type === "assistant" && parsed.message?.content) {
            for (const content of parsed.message.content) {
              if (content.type === "tool_use" && content.name === "TodoWrite" && content.input?.todos) {
                return content.input.todos;
              }
            }
          }
          
          // Check if this is a tool_result from TodoWrite
          if (parsed.type === "user" && parsed.message?.content) {
            for (const content of parsed.message.content) {
              if (content.type === "tool_result" && content.content?.includes("Todos have been modified successfully")) {
                // Try to extract todos from previous context
                return null; // Let the assistant message handle this
              }
            }
          }
        }
      }
    } catch (error) {
      // Not JSON or parsing failed
    }
    return null;
  }

  /**
   * Update progress with todo list display
   */
  private async updateProgressWithTodos(): Promise<void> {
    if (this.currentTodos.length === 0) {
      await this.updateProgress("📝 Task list updated");
      return;
    }

    const todoDisplay = this.formatTodoList(this.currentTodos);
    await this.updateProgress(todoDisplay);
  }

  /**
   * Format todo list for Slack display
   */
  private formatTodoList(todos: TodoItem[]): string {
    const todoLines = todos.map(todo => {
      const checkbox = todo.status === "completed" ? "☑️" : "☐";
      const status = todo.status === "in_progress" ? " (in progress)" : "";
      return `${checkbox} ${todo.content}${status}`;
    });

    return `📝 **Task Progress**\n\n${todoLines.join('\n')}`;
  }

  /**
   * Cleanup Slack integration
   */
  cleanup(): void {
    // Clear any pending updates
    this.updateQueue = [];
    this.isProcessingQueue = false;
    this.currentTodos = [];
  }
}