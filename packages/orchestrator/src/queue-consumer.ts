import PgBoss from 'pg-boss';
import { 
  OrchestratorConfig, 
  WorkerDeploymentRequest, 
  OrchestratorError,
  ErrorCode 
} from './types';
import { DeploymentManager } from './deployment-manager';

export class QueueConsumer {
  private pgBoss: PgBoss;
  private deploymentManager: DeploymentManager;
  private config: OrchestratorConfig;
  private isRunning = false;

  constructor(config: OrchestratorConfig, deploymentManager: DeploymentManager) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    
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

      // Create the messages queue if it doesn't exist
      await this.pgBoss.createQueue('messages');
      console.log('✅ Created/verified messages queue');

      // Subscribe to the single messages queue for all messages
      await this.pgBoss.work('messages', async (job) => {
        console.log('=== PG-BOSS JOB RECEIVED ===');
        console.log('Raw job:', JSON.stringify(job, null, 2));
        return this.handleMessage(job);
      });

      console.log('✅ Queue consumer started - listening for messages');

      // Start background cleanup task
      this.startCleanupTask();

    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to start queue consumer: ${error instanceof Error ? error.message : String(error)}`,
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
   * Handle all messages - creates deployment for new threads or routes to existing thread queues
   */
  private async handleMessage(job: any): Promise<void> {
    console.log('=== ORCHESTRATOR RECEIVED JOB ===');
    
    // pgBoss passes job as array sometimes, get the first item
    const actualJob = Array.isArray(job) ? job[0] : job;
    const data = actualJob?.data || actualJob;
    const jobId = actualJob?.id || 'unknown';
    
    console.log('Processing job:', jobId);
    console.log('Job data:', JSON.stringify(data, null, 2));
    
    console.log(`Processing message job ${jobId} for user ${data?.userId}, thread ${data?.threadId}`);

    try {
      const deploymentName = `peerbot-worker-${data.threadId}`;
      const isNewThread = !data.routingMetadata?.targetThreadId; // New thread if no parent thread
      const teamId = data.platformMetadata?.teamId;
      
      if (isNewThread) {
        // New thread - create deployment
        console.log(`New thread ${data.threadId} - creating deployment ${deploymentName}`);
        
        await this.deploymentManager.createWorkerDeployment(data.userId, data.threadId, teamId, data);
        console.log(`✅ Created deployment: ${deploymentName}`);

      } else {
        // Existing thread - ensure deployment is scaled to 1
        console.log(`Existing thread ${data.threadId} - ensuring deployment ${deploymentName} is running`);
        
        try {
          await this.deploymentManager.scaleDeployment(deploymentName, 1);
          console.log(`✅ Scaled deployment ${deploymentName} to 1`);
        } catch (error) {
          // Deployment doesn't exist, recreate it
          console.log(`Deployment ${deploymentName} doesn't exist, recreating...`);
          await this.deploymentManager.createWorkerDeployment(data.userId, data.threadId, teamId, data);
          console.log(`✅ Recreated deployment: ${deploymentName}`);
        }
      }

      // Send message to worker queue
      await this.sendToWorkerQueue(data, deploymentName);

      console.log(`✅ Message job ${jobId} completed successfully`);
      
    } catch (error) {
      console.error(`❌ Message job ${jobId} failed:`, error);

      // Re-throw for pgboss retry handling
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to process message job: ${error instanceof Error ? error.message : String(error)}`,
        { jobId, data, error },
        true
      );
    }
  }

  /**
   * Send message to worker queue for the worker to consume
   */
  private async sendToWorkerQueue(data: any, deploymentName: string): Promise<void> {
    try {
      // Create thread-specific queue name: thread_message_[deploymentid]
      const threadQueueName = `thread_message_${deploymentName}`;
      
      console.log(`🚀 [DEBUG] About to send message to thread queue: ${threadQueueName}`);
      console.log(`🚀 [DEBUG] Message data:`, JSON.stringify({
        userId: data.userId,
        threadId: data.threadId,
        messageText: data.messageText
      }, null, 2));
      
      // Create the thread-specific queue if it doesn't exist
      console.log(`🚀 [DEBUG] Creating/verifying thread queue: ${threadQueueName}`);
      await this.pgBoss.createQueue(threadQueueName);
      console.log(`✅ [DEBUG] Thread queue created/verified: ${threadQueueName}`);
      
      // Send message to thread-specific queue
      const jobId = await this.pgBoss.send(threadQueueName, {
        ...data,
        // Add routing metadata
        routingMetadata: {
          deploymentName,
          threadId: data.threadId,
          userId: data.userId,
          timestamp: new Date().toISOString()
        }
      }, {
        expireInHours: this.config.queues.expireInHours,
        retryLimit: this.config.queues.retryLimit,
        retryDelay: this.config.queues.retryDelay,
        priority: 10 // Thread messages have high priority
      });

      console.log(`🚀 [DEBUG] pgBoss.send() returned: ${JSON.stringify(jobId)} (type: ${typeof jobId})`);
      
      if (!jobId) {
        throw new Error(`pgBoss.send() returned null/undefined for queue: ${threadQueueName}`);
      }

      console.log(`✅ Sent message to thread queue ${threadQueueName} for thread ${data.threadId}, jobId: ${jobId}`);
    } catch (error) {
      console.error(`❌ [ERROR] sendToWorkerQueue failed:`, error);
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to send message to thread queue: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, data, error },
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

      // Cleanup logic removed - using simple thread-based deployments now
      console.log('Cleanup task running (no-op for thread-based deployments)');
    }, 10 * 60 * 1000); // Run every 10 minutes
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<any> {
    try {
      const stats = await this.pgBoss.getQueueSize('messages');
      return {
        messages: stats,
        isRunning: this.isRunning
      };
    } catch (error) {
      console.error('Failed to get queue stats:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}