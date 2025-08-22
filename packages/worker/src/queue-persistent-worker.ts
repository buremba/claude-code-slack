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
  private botId: string;
  private sessionKey: string;
  private lastActivity: number = Date.now();
  private timeoutMinutes: number = 30; // Longer timeout for queue-based workers
  private isInitialized = false;

  constructor() {
    // Load initial configuration from environment
    this.config = this.loadConfigFromEnv();
    this.botId = process.env.BOT_ID || "default-slack-bot";
    this.sessionKey = process.env.SESSION_KEY!;
    this.timeoutMinutes = parseInt(process.env.SESSION_TIMEOUT_MINUTES || "30");
    
    // Initialize queue consumer
    const connectionString = this.buildConnectionString();
    this.queueConsumer = new WorkerQueueConsumer(
      connectionString,
      this.botId,
      this.sessionKey
    );
    
    logger.info(`🚀 Starting Queue-based Persistent Claude Worker`);
    logger.info(`- Bot ID: ${this.botId}`);
    logger.info(`- Session Key: ${this.sessionKey}`);
    logger.info(`- Session timeout: ${this.timeoutMinutes} minutes`);
  }

  private buildConnectionString(): string {
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
      username: process.env.USERNAME!,
      channelId: process.env.CHANNEL_ID!,
      threadTs: process.env.THREAD_ID || undefined,
      repositoryUrl: process.env.REPOSITORY_URL!,
      userPrompt: "", // Will be populated from queue messages
      slackResponseChannel: process.env.CHANNEL_ID!,
      slackResponseTs: "", // Will be populated from queue messages
      claudeOptions: "{}",
      resumeSessionId: undefined,
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
      
      // Don't timeout if we're currently processing or not fully initialized
      if (timeSinceLastActivity > timeoutMs && 
          this.queueConsumer.isHealthy() && 
          this.isInitialized) {
        logger.info(`Worker timed out after ${this.timeoutMinutes} minutes of inactivity`);
        this.shutdown();
      }
    }, checkInterval);
    
    logger.info(`Started timeout monitor (${this.timeoutMinutes} minutes)`);
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
 */
async function main() {
  try {
    const persistentWorker = new QueuePersistentClaudeWorker();
    await persistentWorker.start();
    
    // Setup graceful shutdown
    process.on("SIGTERM", async () => {
      logger.info("Received SIGTERM, shutting down gracefully...");
      process.exit(0);
    });

    process.on("SIGINT", async () => {
      logger.info("Received SIGINT, shutting down gracefully...");
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
if (import.meta.main) {
  main();
}

export { QueuePersistentClaudeWorker };