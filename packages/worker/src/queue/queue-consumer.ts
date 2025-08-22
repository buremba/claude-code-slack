#!/usr/bin/env bun

import PgBoss from "pg-boss";
import type { Pool } from "pg";
import { ClaudeWorker } from "../claude-worker";
import type { WorkerConfig } from "../types";
import logger from "../logger";

/**
 * Queue consumer for workers that listen to thread-specific messages
 * Replaces ConfigMap polling with queue-based message consumption
 */

export interface ThreadMessagePayload {
  botId: string;
  userId: string;
  threadId: string;
  platform: string;
  channelId: string;
  messageId: string;
  messageText: string;
  agentSessionId?: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
}

export class WorkerQueueConsumer {
  private pgBoss: PgBoss;
  private isRunning = false;
  private currentWorker: ClaudeWorker | null = null;
  private isProcessing = false;
  private botId: string;
  private sessionKey: string;

  constructor(
    connectionString: string,
    botId: string,
    sessionKey: string
  ) {
    this.pgBoss = new PgBoss(connectionString);
    this.botId = botId;
    this.sessionKey = sessionKey;
  }

  /**
   * Start consuming messages from the thread_message queue
   */
  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      
      // Generate queue name for this specific thread
      const queueName = this.getThreadQueueName();
      
      // Register job handler for this thread's messages
      await this.pgBoss.work(
        queueName,
        {
          teamSize: 1, // Only one worker processes messages for this thread
          teamConcurrency: 1, // Process messages sequentially
        },
        this.handleThreadMessage.bind(this)
      );

      this.isRunning = true;
      logger.info(`✅ Worker queue consumer started for bot ${this.botId}, session ${this.sessionKey}`);
      logger.info(`Listening to queue: ${queueName}`);
      
    } catch (error) {
      logger.error("Failed to start worker queue consumer:", error);
      throw error;
    }
  }

  /**
   * Stop the queue consumer
   */
  async stop(): Promise<void> {
    try {
      this.isRunning = false;
      
      // Cleanup current worker if processing
      if (this.currentWorker) {
        await this.currentWorker.cleanup();
        this.currentWorker = null;
      }
      
      await this.pgBoss.stop();
      logger.info("✅ Worker queue consumer stopped");
    } catch (error) {
      logger.error("Error stopping worker queue consumer:", error);
      throw error;
    }
  }

  /**
   * Handle thread message jobs
   */
  private async handleThreadMessage(job: PgBoss.Job<ThreadMessagePayload>): Promise<void> {
    if (this.isProcessing) {
      logger.warn("Already processing a message, requeueing...");
      throw new Error("Worker busy - message will be retried");
    }

    this.isProcessing = true;
    const data = job.data;

    try {
      logger.info(`Processing thread message job ${job.id} for bot ${data.botId}, thread ${data.threadId}`);

      // Set user context for any database operations
      process.env.CURRENT_USER_ID = data.userId;

      // Convert queue payload to WorkerConfig format
      const workerConfig = this.payloadToWorkerConfig(data);

      // Create and execute worker
      this.currentWorker = new ClaudeWorker(workerConfig);
      await this.currentWorker.execute();
      
      logger.info(`✅ Successfully processed thread message job ${job.id}`);

    } catch (error) {
      logger.error(`❌ Failed to process thread message job ${job.id}:`, error);
      
      // Re-throw to let pgboss handle retry logic
      throw error;
      
    } finally {
      // Cleanup worker instance
      if (this.currentWorker) {
        try {
          await this.currentWorker.cleanup();
        } catch (cleanupError) {
          logger.error("Error during worker cleanup:", cleanupError);
        }
        this.currentWorker = null;
      }
      
      this.isProcessing = false;
    }
  }

  /**
   * Generate thread-specific queue name
   * This allows each thread to have its own message queue
   */
  private getThreadQueueName(): string {
    // Use bot and session key to create unique queue name
    const sanitizedBotId = this.botId.replace(/[^a-z0-9]/gi, "_");
    const sanitizedSessionKey = this.sessionKey.replace(/[^a-z0-9]/gi, "_");
    return `thread_message_${sanitizedBotId}_${sanitizedSessionKey}`;
  }

  /**
   * Convert queue payload to WorkerConfig format
   */
  private payloadToWorkerConfig(payload: ThreadMessagePayload): WorkerConfig {
    const platformMetadata = payload.platformMetadata;
    
    return {
      sessionKey: this.sessionKey,
      userId: payload.userId,
      username: platformMetadata.githubUsername || `user-${payload.userId}`,
      channelId: payload.channelId,
      threadTs: payload.threadId,
      repositoryUrl: platformMetadata.repositoryUrl || "",
      userPrompt: Buffer.from(payload.messageText).toString("base64"), // Base64 encode for consistency
      slackResponseChannel: platformMetadata.slackResponseChannel || payload.channelId,
      slackResponseTs: platformMetadata.slackResponseTs || payload.messageId,
      claudeOptions: JSON.stringify(payload.claudeOptions),
      resumeSessionId: payload.agentSessionId,
      slack: {
        token: process.env.SLACK_BOT_TOKEN!,
        refreshToken: process.env.SLACK_REFRESH_TOKEN,
        clientId: process.env.SLACK_CLIENT_ID,
        clientSecret: process.env.SLACK_CLIENT_SECRET,
      },
      workspace: {
        baseDirectory: "/workspace",
        githubToken: process.env.GITHUB_TOKEN!,
      },
    };
  }

  /**
   * Check if consumer is running and healthy
   */
  isHealthy(): boolean {
    return this.isRunning && !this.isProcessing;
  }

  /**
   * Get current processing status
   */
  getStatus(): {
    isRunning: boolean;
    isProcessing: boolean;
    botId: string;
    sessionKey: string;
    queueName: string;
  } {
    return {
      isRunning: this.isRunning,
      isProcessing: this.isProcessing,
      botId: this.botId,
      sessionKey: this.sessionKey,
      queueName: this.getThreadQueueName(),
    };
  }
}