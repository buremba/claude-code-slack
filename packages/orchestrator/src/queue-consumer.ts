import PgBoss from 'pgboss';
import { 
  OrchestratorConfig, 
  WorkerDeploymentRequest, 
  QueueJob,
  OrchestratorError,
  ErrorCode 
} from './types';
import { DeploymentManager } from './deployment-manager';
import { DatabasePool } from './database-pool';

export class QueueConsumer {
  private pgBoss: PgBoss;
  private deploymentManager: DeploymentManager;
  private dbPool: DatabasePool;
  private config: OrchestratorConfig;
  private isRunning = false;

  constructor(config: OrchestratorConfig, deploymentManager: DeploymentManager, dbPool: DatabasePool) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.dbPool = dbPool;
    
    this.pgBoss = new PgBoss({
      connectionString: config.queues.connectionString,
      retryLimit: config.queues.retryLimit,
      retryDelay: config.queues.retryDelay,
      expireInHours: config.queues.expireInHours,
      retentionDays: 7,
      deleteAfterDays: 30,
      monitorStateIntervalSeconds: 60,
      maintenanceIntervalSeconds: 300
    });
  }

  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      this.isRunning = true;

      // Subscribe to direct message queue for initial worker deployment requests
      await this.pgBoss.work('direct_message', {
        teamSize: 5,
        teamConcurrency: 2
      }, this.handleDirectMessage.bind(this));

      console.log('✅ Queue consumer started - listening for direct messages');

      // Start background cleanup task
      this.startCleanupTask();

    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to start queue consumer: ${error.message}`,
        { error },
        true
      );
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.pgBoss.stop();
    console.log('✅ Queue consumer stopped');
  }

  /**
   * Handle direct message jobs - these trigger worker deployment creation
   */
  private async handleDirectMessage(job: PgBoss.Job<WorkerDeploymentRequest>): Promise<void> {
    const { data } = job;
    const jobId = job.id;
    
    console.log(`Processing direct message job ${jobId} for user ${data.userId}, thread ${data.threadId}`);

    try {
      // Update job status to active
      await this.dbPool.updateJobStatus(jobId, 'active');

      // Ensure user queue exists (creates deployment with simple scaling)
      const userQueue = await this.deploymentManager.ensureUserQueue(data.userId);
      console.log(`Ensured user queue: ${userQueue.queueName}`);

      // Create thread deployment tracking
      const threadDeployment = await this.deploymentManager.createThreadDeployment(
        data.userId,
        data.threadId,
        data.agentSessionId
      );
      
      console.log(`Created thread deployment tracking for ${data.threadId}`);

      // Send actual work to user-specific queue for thread-aware processing
      await this.sendToUserQueue(data, userQueue.queueName);

      // Update job status to completed
      await this.dbPool.updateJobStatus(jobId, 'completed', {
        userQueue: userQueue.queueName,
        deployment: threadDeployment.deploymentName,
        threadId: data.threadId
      });

      console.log(`✅ Direct message job ${jobId} completed successfully`);
      
    } catch (error) {
      console.error(`❌ Direct message job ${jobId} failed:`, error);
      
      await this.dbPool.updateJobStatus(
        jobId, 
        'failed', 
        null, 
        error.message
      );

      // Re-throw for pgboss retry handling
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to process direct message job: ${error.message}`,
        { jobId, data, error },
        true
      );
    }
  }

  /**
   * Send job to user-specific queue
   */
  private async sendToUserQueue(data: WorkerDeploymentRequest, userQueueName: string): Promise<void> {
    try {
      // Send to user queue with thread-specific routing information
      await this.pgBoss.send(userQueueName, {
        ...data,
        // Add routing metadata for thread-specific processing
        routingMetadata: {
          targetThreadId: data.threadId,
          agentSessionId: data.agentSessionId,
          userId: data.userId
        }
      }, {
        // Use singleton key to prevent duplicate processing for same thread
        singletonKey: `thread-${data.userId}-${data.threadId}-${data.agentSessionId}`,
        expireInHours: this.config.queues.expireInHours,
        retryLimit: this.config.queues.retryLimit,
        retryDelay: this.config.queues.retryDelay,
        priority: 10 // User queue messages have higher priority
      });

      console.log(`Sent job to user queue ${userQueueName} for thread ${data.threadId}`);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to send job to user queue ${userQueueName}: ${error.message}`,
        { userQueueName, data, error },
        true
      );
    }
  }

  /**
   * Start background cleanup task for inactive threads
   */
  private startCleanupTask(): void {
    const cleanupInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(cleanupInterval);
        return;
      }

      try {
        await this.deploymentManager.cleanupInactiveThreads();
        
        // Also check for users with pending jobs and scale up if needed
        for (const [userId] of this.deploymentManager['activeUserQueues'].entries()) {
          await this.deploymentManager.checkUserQueueAndScale(userId);
        }
      } catch (error) {
        console.error('Cleanup task failed:', error);
      }
    }, 10 * 60 * 1000); // Run every 10 minutes
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<any> {
    try {
      const stats = await this.pgBoss.getQueueSize('direct_message');
      return {
        directMessage: stats,
        isRunning: this.isRunning,
        activeUserQueues: Array.from(this.deploymentManager['activeUserQueues'].keys()),
        activeThreads: Array.from(this.deploymentManager['activeThreadDeployments'].keys())
      };
    } catch (error) {
      console.error('Failed to get queue stats:', error);
      return { error: error.message };
    }
  }

  /**
   * Update thread heartbeat
   */
  updateThreadHeartbeat(threadId: string): void {
    this.deploymentManager.updateThreadHeartbeat(threadId);
  }

  /**
   * Get thread deployment info
   */
  getThreadDeployment(threadId: string) {
    return this.deploymentManager.getThreadDeployment(threadId);
  }

  /**
   * Get user queue info
   */
  getUserQueue(userId: string) {
    return this.deploymentManager.getUserQueue(userId);
  }
}