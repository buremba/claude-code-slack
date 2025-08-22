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
  // Routing metadata for thread-specific processing
  routingMetadata?: {
    targetThreadId: string;
    agentSessionId: string;
    userId: string;
  };
}

export class WorkerQueueConsumer {
  private pgBoss: PgBoss;
  private isRunning = false;
  private currentWorker: ClaudeWorker | null = null;
  private isProcessing = false;
  private userId: string;
  private targetThreadId?: string;

  constructor(
    connectionString: string,
    userId: string,
    targetThreadId?: string
  ) {
    this.pgBoss = new PgBoss(connectionString);
    this.userId = userId;
    this.targetThreadId = targetThreadId;
  }

  /**
   * Start consuming messages from the user queue
   * Worker listens to all messages but only processes assigned thread
   */
  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      
      // Generate user queue name - listens to all messages for this user
      const userQueueName = this.getUserQueueName();
      
      // Register job handler for user queue messages
      await this.pgBoss.work(
        userQueueName,
        {
          teamSize: 1, // Multiple workers can share the user queue
          teamConcurrency: 1, // Process messages sequentially per worker
        },
        this.handleUserQueueMessage.bind(this)
      );

      this.isRunning = true;
      logger.info(`✅ Worker queue consumer started for user ${this.userId}`);
      if (this.targetThreadId) {
        logger.info(`🎯 Targeting thread: ${this.targetThreadId}`);
      } else {
        logger.info(`🎯 Processing all threads for user`);
      }
      logger.info(`📥 Listening to queue: ${userQueueName}`);
      
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
   * Handle user queue message jobs with thread-specific routing
   */
  private async handleUserQueueMessage(job: PgBoss.Job<ThreadMessagePayload>): Promise<void> {
    const data = job.data;

    // Check if this message is for our target thread (if specified)
    if (this.targetThreadId && data.routingMetadata?.targetThreadId !== this.targetThreadId) {
      logger.debug(`Skipping message for thread ${data.routingMetadata?.targetThreadId}, expecting ${this.targetThreadId}`);
      return; // Skip this message - not for our thread
    }

    // Check if message is for our user
    if (data.userId !== this.userId) {
      logger.warn(`Received message for user ${data.userId}, but this worker is for user ${this.userId}`);
      return; // Skip this message - wrong user
    }

    if (this.isProcessing) {
      logger.warn("Already processing a message, requeueing...");
      throw new Error("Worker busy - message will be retried");
    }

    this.isProcessing = true;

    try {
      logger.info(`Processing user queue message job ${job.id} for user ${data.userId}, thread ${data.threadId}`);

      // User context should be set by orchestrator as environment variable  
      // The DATABASE_URL should already contain user-specific credentials
      if (!process.env.USER_ID) {
        logger.warn(`USER_ID not set in environment, using userId from payload: ${data.userId}`);
        process.env.USER_ID = data.userId;
      }

      // Convert queue payload to WorkerConfig format
      const workerConfig = this.payloadToWorkerConfig(data);

      // Create and execute worker
      this.currentWorker = new ClaudeWorker(workerConfig);
      await this.currentWorker.execute();
      
      logger.info(`✅ Successfully processed user queue message job ${job.id}`);

    } catch (error) {
      logger.error(`❌ Failed to process user queue message job ${job.id}:`, error);
      
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
   * Generate user-specific queue name
   * Workers listen to all messages for their assigned user
   */
  private getUserQueueName(): string {
    // Use user ID to create user-specific queue name
    const sanitizedUserId = this.userId.replace(/[^a-z0-9]/gi, "_");
    return `user_${sanitizedUserId}_queue`;
  }

  /**
   * Convert queue payload to WorkerConfig format
   */
  private payloadToWorkerConfig(payload: ThreadMessagePayload): WorkerConfig {
    const platformMetadata = payload.platformMetadata;
    
    return {
      sessionKey: payload.agentSessionId || `session-${payload.threadId}`,
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
    userId: string;
    targetThreadId?: string;
    queueName: string;
  } {
    return {
      isRunning: this.isRunning,
      isProcessing: this.isProcessing,
      userId: this.userId,
      targetThreadId: this.targetThreadId,
      queueName: this.getUserQueueName(),
    };
  }
}