#!/usr/bin/env bun

import PgBoss from "pg-boss";
import { Pool, PoolClient } from "pg";
import logger from "../logger";

/**
 * Queue producer for dispatching messages to pgboss queues
 * Handles both direct_message and thread_message queues with bot isolation
 */

export interface BotContext {
  botId: string;
  platform: string;
}

export interface WorkerDeploymentPayload {
  userId: string;
  botId: string;
  agentSessionId: string;
  threadId: string;
  platform: string;
  platformUserId: string;
  messageId: string;
  messageText: string;
  channelId: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
  environmentVariables?: Record<string, string>;
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
  // Routing metadata for thread-specific processing
  routingMetadata?: {
    targetThreadId: string;
    agentSessionId: string;
    userId: string;
  };
}

export class QueueProducer {
  private pgBoss: PgBoss;
  private pool: Pool;
  private isConnected = false;

  constructor(connectionString: string, databaseConfig?: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    ssl?: boolean;
  }) {
    this.pgBoss = new PgBoss(connectionString);
    
    // Create separate pool for RLS context management
    if (databaseConfig) {
      this.pool = new Pool({
        host: databaseConfig.host,
        port: databaseConfig.port,
        database: databaseConfig.database,
        user: databaseConfig.username,
        password: databaseConfig.password,
        ssl: databaseConfig.ssl,
        max: 10,
        min: 1,
        idleTimeoutMillis: 30000,
      });
    }
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
      if (this.pool) {
        await this.pool.end();
      }
      logger.info("✅ Queue producer stopped");
    } catch (error) {
      logger.error("Error stopping queue producer:", error);
      throw error;
    }
  }

  /**
   * Enqueue a worker deployment request (for new conversations/threads)
   */
  async enqueueWorkerDeployment(
    payload: WorkerDeploymentPayload,
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
      const jobId = await this.pgBoss.send('direct_message', payload, {
        priority: options?.priority || 0,
        retryLimit: options?.retryLimit || 3,
        retryDelay: options?.retryDelay || 30,
        expireInHours: options?.expireInHours || 24,
        singletonKey: `deployment-${payload.userId}-${payload.threadId}-${payload.agentSessionId}`, // Prevent duplicates
      });

      logger.info(`Enqueued worker deployment job ${jobId} for user ${payload.userId}, thread ${payload.threadId}`);
      return jobId;

    } catch (error) {
      logger.error(`Failed to enqueue worker deployment for user ${payload.userId}:`, error);
      throw error;
    }
  }

  /**
   * Enqueue a thread message job to user-specific queue
   */
  async enqueueThreadMessage(
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
      // Send to user-specific queue
      const userQueueName = this.getUserQueueName(payload.userId);
      
      const jobId = await this.pgBoss.send(userQueueName, payload, {
        priority: options?.priority || 10, // Higher priority for user queue messages
        retryLimit: options?.retryLimit || 3,
        retryDelay: options?.retryDelay || 30,
        expireInHours: options?.expireInHours || 24,
        singletonKey: `thread-${payload.userId}-${payload.threadId}-${payload.messageId}`, // Prevent duplicates
      });

      logger.info(`Enqueued thread message job ${jobId} to user queue ${userQueueName}, thread ${payload.threadId}`);
      return jobId;

    } catch (error) {
      logger.error(`Failed to enqueue thread message for user ${payload.userId}:`, error);
      throw error;
    }
  }

  /**
   * Get user-specific queue name
   */
  private getUserQueueName(userId: string): string {
    const sanitizedUserId = userId.replace(/[^a-z0-9]/gi, "_");
    return `user_${sanitizedUserId}_queue`;
  }

  /**
   * Execute a query with user context for RLS
   */
  async queryWithUserContext<T>(
    userId: string,
    query: string,
    params?: any[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    if (!this.pool) {
      throw new Error("Database pool not available - queue producer not configured with database config");
    }

    const client = await this.pool.connect();
    
    try {
      // Set user context for RLS policies using PostgreSQL session configuration
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      
      const result = await client.query(query, params);
      return {
        rows: result.rows,
        rowCount: result.rowCount || 0
      };
    } finally {
      client.release();
    }
  }

  /**
   * Update job status using the database function
   */
  async updateJobStatus(
    jobId: string,
    status: 'pending' | 'active' | 'completed' | 'failed',
    retryCount?: number
  ): Promise<void> {
    if (!this.pool) {
      logger.warn(`Cannot update job status for ${jobId} - database pool not available`);
      return;
    }

    try {
      const query = 'SELECT update_job_status($1, $2, $3)';
      const params = [jobId, status, retryCount || null];
      
      await this.pool.query(query, params);
      logger.debug(`Updated job ${jobId} status to: ${status}`);
    } catch (error) {
      logger.error(`Failed to update job status for ${jobId}:`, error);
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