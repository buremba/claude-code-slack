#!/usr/bin/env bun

import { WebClient } from "@slack/web-api";
import type { SlackConfig } from "./types";
import { SlackError } from "./types";
import { markdownToSlackWithBlocks } from "./slack/blockkit-parser";
import logger from "./logger";

export class SlackIntegration {
  private client: WebClient;
  private responseChannel: string;
  private responseTs: string;
  private lastUpdateTime = 0;
  private updateQueue: string[] = [];
  private isProcessingQueue = false;
  private contextBlock: any = null; // Store the context header block

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
      // Only stream certain types of updates to avoid spam
      if (this.shouldStreamUpdate(data)) {
        // Simple working status - no need to show details
        await this.updateProgress(`💭 Working...`);
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
      
      // Convert markdown to Slack format with blocks support
      const slackMessage = markdownToSlackWithBlocks(content);
      
      // Build blocks array with context header if available
      let blocks: any[] = [];
      
      // Add context block if it exists (preserve it from dispatcher)
      if (this.contextBlock) {
        blocks.push(this.contextBlock);
        blocks.push({ type: "divider" });
      }
      
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
        text: blocks.length > 0 ? "Claude is updating..." : (slackMessage.text || content),
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
   * Determine if we should stream this update
   */
  private shouldStreamUpdate(data: any): boolean {
    // Stream significant updates but not every tiny piece of output
    if (typeof data === "object" && data.type) {
      return ["tool_use", "completion", "error"].includes(data.type);
    }
    
    if (typeof data === "string") {
      // Stream text that looks like significant output
      return data.length > 10 && data.length < 500;
    }
    
    return false;
  }


  /**
   * Post a new message (for errors or additional info)
   */
  async postMessage(content: string, threadTs?: string): Promise<void> {
    try {
      // Convert markdown to Slack format with blocks support
      const slackMessage = markdownToSlackWithBlocks(content);
      
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
      // Post a temporary "typing" message that we'll update
      await this.updateProgress("💭 Claude is thinking...");

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
   * Cleanup Slack integration
   */
  cleanup(): void {
    // Clear any pending updates
    this.updateQueue = [];
    this.isProcessingQueue = false;
  }
}