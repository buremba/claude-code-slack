#!/usr/bin/env bun

import PgBoss from "pg-boss";
import type { Pool } from "pg";
import logger from "../logger";

/**
 * Queue producer for dispatching messages to pgboss queues
 * Handles both direct_message and thread_message queues with bot isolation
 */

export interface BotContext {
  botId: string;
  platform: string;
}

export interface DirectMessagePayload {
  botId: string;
  userId: string;
  platform: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  messageText: string;
  githubUsername: string;
  repositoryUrl: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
}

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

export class QueueProducer {
  private pgBoss: PgBoss;
  private isConnected = false;

  constructor(connectionString: string) {
    this.pgBoss = new PgBoss(connectionString);
  }

  /**
   * Start the queue producer
   */
  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      this.isConnected = true;
      logger.info("✅ Queue producer started successfully");
    } catch (error) {
      logger.error("Failed to start queue producer:", error);
      throw error;
    }
  }

  /**
   * Stop the queue producer
   */
  async stop(): Promise<void> {
    try {
      this.isConnected = false;
      await this.pgBoss.stop();
      logger.info("✅ Queue producer stopped");
    } catch (error) {
      logger.error("Error stopping queue producer:", error);
      throw error;
    }
  }

  /**
   * Enqueue a direct message job (for new conversations)
   */
  async enqueueDirectMessage(
    queueName: string,
    payload: DirectMessagePayload,
    options?: {
      priority?: number;
      retryLimit?: number;
      retryDelay?: number;
      expireInHours?: number;
    }
  ): Promise<string> {
    if (!this.isConnected) {
      throw new Error("Queue producer is not connected");
    }

    try {
      // Set bot context for RLS
      await this.setBotContext(payload.botId);

      const jobId = await this.pgBoss.send(queueName, payload, {
        priority: options?.priority || 0,
        retryLimit: options?.retryLimit || 3,
        retryDelay: options?.retryDelay || 30,
        expireInHours: options?.expireInHours || 24,
        singletonKey: `direct-${payload.botId}-${payload.channelId}-${payload.messageId}`, // Prevent duplicates
      });

      logger.info(`Enqueued direct message job ${jobId} for bot ${payload.botId}`);
      return jobId;

    } catch (error) {
      logger.error(`Failed to enqueue direct message for bot ${payload.botId}:`, error);
      throw error;
    }
  }

  /**
   * Enqueue a thread message job (for continuing conversations)
   */
  async enqueueThreadMessage(
    queueName: string,
    payload: ThreadMessagePayload,
    options?: {
      priority?: number;
      retryLimit?: number;
      retryDelay?: number;
      expireInHours?: number;
    }
  ): Promise<string> {
    if (!this.isConnected) {
      throw new Error("Queue producer is not connected");
    }

    try {
      // Set bot context for RLS
      await this.setBotContext(payload.botId);

      const jobId = await this.pgBoss.send(queueName, payload, {
        priority: options?.priority || 0,
        retryLimit: options?.retryLimit || 3,
        retryDelay: options?.retryDelay || 30,
        expireInHours: options?.expireInHours || 24,
        singletonKey: `thread-${payload.botId}-${payload.threadId}-${payload.messageId}`, // Prevent duplicates
      });

      logger.info(`Enqueued thread message job ${jobId} for bot ${payload.botId}, thread ${payload.threadId}`);
      return jobId;

    } catch (error) {
      logger.error(`Failed to enqueue thread message for bot ${payload.botId}:`, error);
      throw error;
    }
  }

  /**
   * Set bot context for Row Level Security
   * This should be called before any database operations that require bot isolation
   */
  private async setBotContext(botId: string): Promise<void> {
    try {
      // pgboss doesn't expose the underlying pool directly, 
      // so we set this in process environment for the worker to use
      process.env.CURRENT_BOT_ID = botId;
      logger.debug(`Set bot context: ${botId}`);
    } catch (error) {
      logger.error(`Failed to set bot context for ${botId}:`, error);
      throw error;
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(queueName: string): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    try {
      const stats = await this.pgBoss.getQueueSize(queueName);
      return {
        waiting: stats.waiting,
        active: stats.active,
        completed: stats.completed,
        failed: stats.failed
      };
    } catch (error) {
      logger.error(`Failed to get queue stats for ${queueName}:`, error);
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
  }

  /**
   * Cancel a job by ID
   */
  async cancelJob(jobId: string): Promise<void> {
    try {
      await this.pgBoss.cancel(jobId);
      logger.info(`Cancelled job ${jobId}`);
    } catch (error) {
      logger.error(`Failed to cancel job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Get job status by ID
   */
  async getJobStatus(jobId: string): Promise<any> {
    try {
      const job = await this.pgBoss.getJobById(jobId);
      return job;
    } catch (error) {
      logger.error(`Failed to get job status for ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Check if producer is connected
   */
  isHealthy(): boolean {
    return this.isConnected;
  }
}