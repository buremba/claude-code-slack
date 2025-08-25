#!/usr/bin/env bun

// Set TLS verification before any imports that might use HTTPS
if (process.env.K8S_SKIP_TLS_VERIFY === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import { ClaudeWorker } from "./claude-worker";
import { WorkerQueueConsumer } from "./queue/queue-consumer";
import type { WorkerConfig } from "./types";
import logger from "./logger";

/**
 * Queue-based persistent Claude worker
 * Replaces ConfigMap polling with PostgreSQL queue consumption
 */
export class QueuePersistentClaudeWorker {
  private worker: ClaudeWorker | null = null;
  private config: WorkerConfig;
  private queueConsumer: WorkerQueueConsumer;
  private userId: string;
  private targetThreadId?: string;
  private lastActivity: number = Date.now();
  private timeoutMinutes: number = 30; // Worker can exit after inactivity, deployment stays up 5 more minutes
  private isInitialized = false;

  constructor(userId: string, targetThreadId?: string) {
    this.userId = userId;
    this.targetThreadId = targetThreadId;
    
    // Load initial configuration from environment
    this.config = this.loadConfigFromEnv();
    this.timeoutMinutes = parseInt(process.env.SESSION_TIMEOUT_MINUTES || "30");
    
    // Get deployment name from environment
    const deploymentName = process.env.DEPLOYMENT_NAME;
    if (!deploymentName) {
      throw new Error('DEPLOYMENT_NAME environment variable is required');
    }
    
    // Initialize queue consumer with thread-specific routing
    const connectionString = this.buildConnectionString();
    this.queueConsumer = new WorkerQueueConsumer(
      connectionString,
      this.userId,
      deploymentName,
      this.targetThreadId
    );
    
    logger.info(`🚀 Starting Queue-based Persistent Claude Worker`);
    logger.info(`- User ID: ${this.userId}`);
    logger.info(`- Deployment: ${deploymentName}`);
    if (this.targetThreadId) {
      logger.info(`- Target Thread: ${this.targetThreadId}`);
    }
    logger.info(`- Session timeout: ${this.timeoutMinutes} minutes`);
  }

  private buildConnectionString(): string {
    // Use DATABASE_URL from environment
    const connectionString = process.env.DATABASE_URL;
    if (connectionString) {
      return connectionString;
    }
    
    // Fallback to building from individual components
    const host = process.env.DATABASE_HOST || "localhost";
    const port = process.env.DATABASE_PORT || "5432";
    const database = process.env.DATABASE_NAME || "peerbot";
    const username = encodeURIComponent(process.env.DATABASE_USER || "postgres");
    const password = encodeURIComponent(process.env.DATABASE_PASSWORD || "");

    return `postgres://${username}:${password}@${host}:${port}/${database}`;
  }

  private loadConfigFromEnv(): WorkerConfig {
    return {
      sessionKey: process.env.SESSION_KEY!,
      userId: process.env.USER_ID!,
      channelId: process.env.CHANNEL_ID!,
      threadTs: process.env.THREAD_ID || undefined,
      repositoryUrl: process.env.REPOSITORY_URL!,
      userPrompt: "", // Will be populated from queue messages
      slackResponseChannel: process.env.CHANNEL_ID!,
      slackResponseTs: "", // Will be populated from queue messages
      claudeOptions: "{}",
      resumeSessionId: undefined,
      workspace: {
        baseDirectory: "/workspace",
        githubToken: process.env.GITHUB_TOKEN!,
      },
    };
  }

  async start(): Promise<void> {
    try {
      // Start queue consumer (this will handle message processing)
      await this.queueConsumer.start();
      
      // Process initial message if provided via environment (for first message in thread)
      if (process.env.INITIAL_USER_PROMPT) {
        await this.processInitialMessage();
      }
      
      // Start timeout monitor
      this.startTimeoutMonitor();
      
      this.isInitialized = true;
      logger.info(`✅ Queue-based persistent worker started successfully`);
      
    } catch (error) {
      logger.error("Failed to start queue-based persistent worker:", error);
      process.exit(1);
    }
  }

  /**
   * Process initial message from environment variables
   * This handles the first message that creates the worker deployment
   */
  private async processInitialMessage(): Promise<void> {
    try {
      logger.info("Processing initial message from environment...");
      
      const initialConfig = {
        ...this.config,
        userPrompt: process.env.INITIAL_USER_PROMPT!,
        slackResponseChannel: process.env.INITIAL_SLACK_RESPONSE_CHANNEL!,
        slackResponseTs: process.env.INITIAL_SLACK_RESPONSE_TS!,
        claudeOptions: process.env.INITIAL_CLAUDE_OPTIONS || "{}",
        resumeSessionId: process.env.INITIAL_RESUME_SESSION_ID,
      };

      // Set ORIGINAL_MESSAGE_TS for reactions
      if (process.env.INITIAL_ORIGINAL_MESSAGE_TS) {
        process.env.ORIGINAL_MESSAGE_TS = process.env.INITIAL_ORIGINAL_MESSAGE_TS;
      }

      // Create and execute worker for initial message
      this.worker = new ClaudeWorker(initialConfig);
      await this.worker.execute();
      
      logger.info("✅ Initial message processed successfully");
      
    } catch (error) {
      logger.error("❌ Error processing initial message:", error);
      throw error;
    } finally {
      // Cleanup worker instance
      if (this.worker) {
        try {
          await this.worker.cleanup();
        } catch (cleanupError) {
          logger.error("Error during worker cleanup:", cleanupError);
        }
        this.worker = null;
      }
      
      this.lastActivity = Date.now();
    }
  }

  /**
   * Start timeout monitor to shutdown inactive workers
   */
  private startTimeoutMonitor(): void {
    const checkInterval = 30000; // Check every 30 seconds
    const timeoutMs = this.timeoutMinutes * 60 * 1000;
    
    setInterval(() => {
      const now = Date.now();
      const timeSinceLastActivity = now - this.lastActivity;
      
      // Allow the worker to exit naturally when not processing
      // The orchestrator will handle scaling the deployment to 0 after 5 minutes
      if (timeSinceLastActivity > timeoutMs && 
          this.queueConsumer.isHealthy() && 
          this.isInitialized) {
        logger.info(`Worker finished after ${this.timeoutMinutes} minutes of inactivity`);
        logger.info('Exiting - deployment will be scaled down by orchestrator after 5-minute grace period');
        process.exit(0);
      }
    }, checkInterval);
    
    logger.info(`Started timeout monitor (${this.timeoutMinutes} minutes)`);
  }

  /**
   * Stop the worker (public method)
   */
  async stop(): Promise<void> {
    await this.shutdown();
  }

  /**
   * Graceful shutdown
   */
  private async shutdown(): Promise<void> {
    logger.info(`Shutting down queue-based persistent worker...`);
    
    try {
      // Stop queue consumer
      await this.queueConsumer.stop();
      
      // Cleanup current worker if processing
      if (this.worker) {
        await this.worker.cleanup();
      }
      
    } catch (error) {
      logger.error("Error during shutdown:", error);
    }
    
    process.exit(0);
  }

  /**
   * Get worker status
   */
  getStatus(): {
    isInitialized: boolean;
    lastActivity: Date;
    queueStatus: any;
  } {
    return {
      isInitialized: this.isInitialized,
      lastActivity: new Date(this.lastActivity),
      queueStatus: this.queueConsumer.getStatus(),
    };
  }
}

/**
 * Main entry point for queue-based persistent worker
 * @internal
 */
// @ts-ignore - Called from index.ts when WORKER_MODE is 'queue'
async function main() {
  try {
    // Get user ID from environment - required for worker
    const userId = process.env.USER_ID;
    const targetThreadId = process.env.TARGET_THREAD_ID; // Optional
    
    if (!userId) {
      logger.error("❌ USER_ID environment variable is required");
      process.exit(1);
    }
    
    const persistentWorker = new QueuePersistentClaudeWorker(userId, targetThreadId);
    await persistentWorker.start();
    
    // Setup graceful shutdown
    process.on("SIGTERM", async () => {
      logger.info("Received SIGTERM, shutting down gracefully...");
      await persistentWorker.stop();
      process.exit(0);
    });

    process.on("SIGINT", async () => {
      logger.info("Received SIGINT, shutting down gracefully...");
      await persistentWorker.stop();
      process.exit(0);
    });
    
    // Keep the process running
    await new Promise(() => {}); // Run forever
    
  } catch (error) {
    logger.error("❌ Queue-based persistent worker failed:", error);
    process.exit(1);
  }
}

// Only start if this file is run directly
// Note: import.meta.main is not supported in TypeScript with current config
// The main() function is called from index.ts instead