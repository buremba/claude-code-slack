#!/usr/bin/env bun

import PgBoss from "pg-boss";
import { WebClient } from "@slack/web-api";
// Simple blockkit detection and conversion for now
function handleBlockkitContent(content: string): { text: string; blocks?: any[] } {
  // Look for blockkit pattern: ```blockkit { action: "...", ... }\n{JSON}\n```
  const blockKitRegex = /```blockkit\s*\{([^}]+)\}\s*\n([\s\S]*?)\n```/g;
  let processedContent = content;
  const actionButtons: any[] = [];
  let hasBlockKit = false;

  let match;
  while ((match = blockKitRegex.exec(content)) !== null) {
    hasBlockKit = true;
    const metadataStr = match[1];
    const jsonContent = match[2];
    
    try {
      // Parse metadata
      const metadata: any = {};
      if (metadataStr) {
        metadataStr.split(',').forEach(pair => {
          const [key, value] = pair.split(':').map(s => s.trim());
          if (key && value) {
            const cleanKey = key.replace(/"/g, '');
            let cleanValue: any = value.replace(/"/g, '');
            if (cleanValue === 'true') cleanValue = true;
            if (cleanValue === 'false') cleanValue = false;
            metadata[cleanKey] = cleanValue;
          }
        });
      }

      // Parse JSON blocks
      const parsed = jsonContent ? JSON.parse(jsonContent.trim()) : { blocks: [] };
      const blocks = parsed.blocks || [parsed];
      
      if (metadata.action) {
        // Create button for the blockkit form
        actionButtons.push({
          type: "button",
          text: {
            type: "plain_text",
            text: metadata.action
          },
          action_id: `blockkit_form_${Date.now()}`,
          value: JSON.stringify({ blocks })
        });
        
        // Remove the blockkit from text content
        processedContent = processedContent.replace(match[0], '');
      } else if (metadata.show) {
        // Show blocks directly - but for now, remove from text to avoid duplication
        processedContent = processedContent.replace(match[0], `[Interactive form: ${metadata.action || 'Form'}]`);
      }
    } catch (error) {
      console.error('Failed to parse blockkit:', error);
      // Keep original content on error
    }
  }

  // Convert basic markdown
  const text = processedContent
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')
    .trim();

  if (!hasBlockKit || actionButtons.length === 0) {
    // No blockkit, return simple format
    return {
      text,
      blocks: text ? [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: text
        }
      }] : undefined
    };
  }

  // Has blockkit - create blocks with action buttons
  const blocks: any[] = [];
  
  if (text) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: text
      }
    });
  }

  // Add action buttons
  if (actionButtons.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionButtons
    });
  }

  return { text, blocks };
}
import logger from "../logger";

interface ThreadResponsePayload {
  messageId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  content?: string;
  isDone: boolean;
  reaction?: string;
  error?: string;
  timestamp: number;
  originalMessageTs?: string; // User's original message timestamp for reactions
}

/**
 * Consumer that listens to thread_response queue and updates Slack messages
 * This handles all Slack communication that was previously done by the worker
 */
export class ThreadResponseConsumer {
  private pgBoss: PgBoss;
  private slackClient: WebClient;
  private isRunning = false;

  constructor(
    connectionString: string,
    slackToken: string
  ) {
    this.pgBoss = new PgBoss(connectionString);
    this.slackClient = new WebClient(slackToken);
  }

  /**
   * Start consuming thread_response messages
   */
  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      
      // Create the thread_response queue if it doesn't exist
      await this.pgBoss.createQueue('thread_response');
      
      // Register job handler for thread response messages
      await this.pgBoss.work(
        'thread_response',
        this.handleThreadResponse.bind(this)
      );

      this.isRunning = true;
      logger.info("✅ Thread response consumer started");
      
    } catch (error) {
      logger.error("Failed to start thread response consumer:", error);
      throw error;
    }
  }

  /**
   * Stop the consumer
   */
  async stop(): Promise<void> {
    try {
      this.isRunning = false;
      await this.pgBoss.stop();
      logger.info("✅ Thread response consumer stopped");
    } catch (error) {
      logger.error("Error stopping thread response consumer:", error);
      throw error;
    }
  }

  /**
   * Handle thread response message jobs
   */
  private async handleThreadResponse(job: any): Promise<void> {
    let data;
    
    try {
      logger.info(`Received thread response job structure: ${JSON.stringify({
        type: typeof job,
        keys: Object.keys(job || {}),
        hasNumericKeys: Object.keys(job || {}).some(k => !isNaN(Number(k)))
      })}`);
      
      // Handle PgBoss serialized format (similar to worker queue consumer)
      if (typeof job === 'object' && job !== null) {
        const keys = Object.keys(job);
        const numericKeys = keys.filter(key => !isNaN(Number(key)));
        
        if (numericKeys.length > 0) {
          // PgBoss passes jobs as an array, get the first element
          const firstKey = numericKeys[0];
          const firstJob = firstKey ? job[firstKey] : null;
          
          if (typeof firstJob === 'object' && firstJob !== null && firstJob.data) {
            // This is the actual job object from PgBoss
            data = firstJob.data;
            logger.info(`Successfully extracted thread response job data for job ${firstJob.id}`);
          } else {
            throw new Error('Invalid job format: expected job object with data field');
          }
        } else {
          // Fallback - might be normal job format
          data = job.data || job;
        }
      } else {
        data = job;
      }
      
      if (!data || !data.messageId) {
        throw new Error(`Invalid thread response data: ${JSON.stringify(data)}`);
      }
      
      logger.info(`Processing thread response job for message ${data.messageId}`);

      // Handle different types of responses and manage reactions based on isDone status
      // Use originalMessageTs for reactions (user's message), not the bot's message
      const reactionTimestamp = data.originalMessageTs || data.messageId;
      
      if (data.content) {
        await this.handleMessageUpdate(data);
        
        // Handle reactions based on isDone status
        if (!data.isDone) {
          // Worker is processing - add gear reaction to user's message
          try {
            await this.slackClient.reactions.add({
              channel: data.channelId,
              timestamp: reactionTimestamp,
              name: "gear",
            });
            logger.info(`Added gear reaction to message ${reactionTimestamp}`);
          } catch (error) {
            logger.warn(`Failed to add gear reaction:`, error);
          }
        } else {
          // Processing completed - replace gear with checkmark on user's message
          try {
            await this.slackClient.reactions.remove({
              channel: data.channelId,
              timestamp: reactionTimestamp,
              name: "gear",
            });
            await this.slackClient.reactions.add({
              channel: data.channelId,
              timestamp: reactionTimestamp,
              name: "white_check_mark",
            });
            logger.info(`Replaced gear with checkmark on message ${reactionTimestamp}`);
          } catch (error) {
            logger.warn(`Failed to update reactions to checkmark:`, error);
          }
        }
      } else if (data.error) {
        await this.handleError(data);
        
        // Add error reaction to user's message
        try {
          await this.slackClient.reactions.remove({
            channel: data.channelId,
            timestamp: reactionTimestamp,
            name: "gear",
          });
          await this.slackClient.reactions.add({
            channel: data.channelId,
            timestamp: reactionTimestamp,
            name: "x",
          });
          logger.info(`Added error reaction to message ${reactionTimestamp}`);
        } catch (error) {
          logger.warn(`Failed to add error reaction:`, error);
        }
      }

      // Log completion
      if (data.isDone) {
        logger.info(`Thread processing completed for message ${data.messageId}`);
      }

    } catch (error) {
      logger.error(`Failed to process thread response job ${job.id}:`, error);
      throw error; // Let pgboss handle retry logic
    }
  }


  /**
   * Handle message content updates
   */
  private async handleMessageUpdate(data: ThreadResponsePayload): Promise<void> {
    const { content, channelId, threadTs } = data;
    
    if (!content) return;

    try {
      logger.info(`Updating message in channel ${channelId}, thread ${threadTs}`);
      
      // Convert markdown to Slack format with blockkit support
      const slackMessage = handleBlockkitContent(content);
      
      const updateOptions: any = {
        channel: channelId,
        ts: threadTs,
        text: slackMessage.text || content,
        mrkdwn: true,
      };
      
      // Add blocks if we have them (blockkit parser handles all the complexity)
      if (slackMessage.blocks && slackMessage.blocks.length > 0) {
        updateOptions.blocks = slackMessage.blocks;
      }
      
      const result = await this.slackClient.chat.update(updateOptions);
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
        logger.error(`Failed to update Slack message: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Handle error messages
   */
  private async handleError(data: ThreadResponsePayload): Promise<void> {
    const { error, channelId, threadTs } = data;
    
    if (!error) return;

    try {
      logger.info(`Sending error message to channel ${channelId}, thread ${threadTs}`);
      
      const errorContent = `❌ **Error occurred**\n\n**Error:** \`${error}\``;
      
      // Convert markdown to Slack format with blockkit support
      const slackMessage = handleBlockkitContent(errorContent);
      
      const updateOptions: any = {
        channel: channelId,
        ts: threadTs,
        text: slackMessage.text || errorContent,
        mrkdwn: true,
      };
      
      if (slackMessage.blocks && slackMessage.blocks.length > 0) {
        updateOptions.blocks = slackMessage.blocks;
      }
      
      const result = await this.slackClient.chat.update(updateOptions);
      logger.info(`Error message update result: ${result.ok}`);

    } catch (updateError: any) {
      logger.error(`Failed to send error message to Slack: ${updateError.message}`);
      throw updateError;
    }
  }

  /**
   * Check if consumer is running and healthy
   */
  isHealthy(): boolean {
    return this.isRunning;
  }

  /**
   * Get current status
   */
  getStatus(): {
    isRunning: boolean;
  } {
    return {
      isRunning: this.isRunning,
    };
  }
}