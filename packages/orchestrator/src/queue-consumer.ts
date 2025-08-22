#!/usr/bin/env bun

import PgBoss from "pg-boss";
import { KubernetesOrchestrator } from "./kubernetes-orchestrator";
import { DatabasePool } from "./database-pool";
import { OrchestratorError, ErrorCode } from "./types";
import type { 
  OrchestratorConfig, 
  DirectMessageJob,
  WorkerDeploymentRequest
} from "./types";

/**
 * Queue consumer that processes direct_message jobs and creates worker deployments
 */
export class QueueConsumer {
  private pgBoss: PgBoss;
  private orchestrator: KubernetesOrchestrator;
  private database: DatabasePool;
  private config: OrchestratorConfig;
  private isRunning = false;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.pgBoss = new PgBoss(config.pgboss.connectionString);
    this.orchestrator = new KubernetesOrchestrator(config);
    this.database = new DatabasePool(config);
  }

  /**
   * Start consuming jobs from the direct_message queue
   */
  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      
      // Register job handler for direct messages
      await this.pgBoss.work(
        this.config.queues.directMessage,
        {
          teamSize: 5, // Process up to 5 jobs concurrently
          teamConcurrency: 1 // One job per worker
        },
        this.handleDirectMessage.bind(this)
      );

      this.isRunning = true;
      console.log(`✅ Queue consumer started, listening to '${this.config.queues.directMessage}' queue`);
      
    } catch (error) {
      console.error("Failed to start queue consumer:", error);
      throw error;
    }
  }

  /**
   * Stop the queue consumer
   */
  async stop(): Promise<void> {
    try {
      this.isRunning = false;
      await this.pgBoss.stop();
      await this.orchestrator.cleanup();
      await this.database.close();
      console.log("✅ Queue consumer stopped");
    } catch (error) {
      console.error("Error stopping queue consumer:", error);
      throw error;
    }
  }

  /**
   * Handle direct message jobs by creating worker deployments
   */
  private async handleDirectMessage(job: PgBoss.Job<DirectMessageJob>): Promise<void> {
    const data = job.data;
    console.log(`Processing direct message job ${data.jobId} for bot ${data.botId}`);

    try {
      // Update job status to active
      await this.database.updateJobStatus(data.jobId, 'active');

      // Create session key from thread info
      const sessionKey = this.generateSessionKey(data);

      // Create worker deployment request
      const deploymentRequest: WorkerDeploymentRequest = {
        sessionKey,
        botId: data.botId,
        userId: data.userId,
        channelId: data.channelId,
        threadId: data.threadId || data.messageId, // Use messageId as threadId for new conversations
        repositoryUrl: data.repositoryUrl,
        initialMessage: data
      };

      // Create the worker deployment
      const deploymentName = await this.orchestrator.createWorkerDeployment(deploymentRequest);
      
      console.log(`✅ Created worker deployment ${deploymentName} for job ${data.jobId}`);

      // Update job status in database
      await this.database.updateJobStatus(data.jobId, 'completed');

    } catch (error) {
      const orchestratorError = error instanceof OrchestratorError 
        ? error 
        : new OrchestratorError(
            'handleDirectMessage',
            ErrorCode.JOB_PROCESSING_FAILED,
            `Failed to process direct message job: ${(error as Error).message}`,
            error as Error,
            true // Most job processing errors are retryable
          );

      console.error(`❌ Failed to process direct message job ${data.jobId}:`, {
        operation: orchestratorError.operation,
        errorCode: orchestratorError.errorCode,
        message: orchestratorError.message,
        retryable: orchestratorError.retryable,
        cause: orchestratorError.cause?.message
      });
      
      // Update job status as failed (but don't fail the whole job if this fails)
      try {
        await this.database.updateJobStatus(data.jobId, 'failed');
      } catch (statusError) {
        console.error(`Failed to update job status for ${data.jobId}:`, statusError);
      }
      
      // Re-throw to let pgboss handle retry logic
      throw orchestratorError;
    }
  }

  /**
   * Generate session key for worker deployment
   */
  private generateSessionKey(data: DirectMessageJob): string {
    // Generate session key similar to the original implementation
    const threadTs = data.threadId || data.messageId;
    return `${data.platform}-${data.channelId}-${data.userId}-${threadTs}`;
  }


  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    try {
      const stats = await this.pgBoss.getQueueSize(this.config.queues.directMessage);
      return {
        waiting: stats.waiting,
        active: stats.active, 
        completed: stats.completed,
        failed: stats.failed
      };
    } catch (error) {
      console.error("Failed to get queue stats:", error);
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
  }

  /**
   * Check if consumer is running
   */
  isHealthy(): boolean {
    return this.isRunning;
  }
}