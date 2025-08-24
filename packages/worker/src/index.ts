#!/usr/bin/env bun

import { ClaudeWorker } from "./claude-worker";
import { QueuePersistentClaudeWorker } from "./queue-persistent-worker";
import { QueueIntegration } from "./queue-integration";
import type { WorkerConfig } from "./types";
import logger from "./logger";

// Re-export ClaudeWorker for backward compatibility
export { ClaudeWorker } from "./claude-worker";

/**
 * Main entry point - now supports both queue-based and legacy workers
 */
async function main() {
  // Check if we should use queue-based worker (KEDA mode)
  const workerMode = process.env.WORKER_MODE || "legacy";
  
  if (workerMode === "queue") {
    logger.info("🔄 Starting in queue mode (simple deployment-based persistent worker)");
    
    // Get user ID and optional target thread from environment
    const userId = process.env.USER_ID;
    const targetThreadId = process.env.TARGET_THREAD_ID; // Optional - for thread-specific workers
    
    if (!userId) {
      logger.error("❌ USER_ID environment variable is required for queue mode");
      process.exit(1);
    }
    
    try {
      const queueWorker = new QueuePersistentClaudeWorker(userId, targetThreadId);
      await queueWorker.start();
      
      // Keep the process running for persistent queue consumption
      process.on("SIGTERM", async () => {
        logger.info("Received SIGTERM, shutting down queue worker...");
        await queueWorker.stop();
        process.exit(0);
      });
      
      process.on("SIGINT", async () => {
        logger.info("Received SIGINT, shutting down queue worker...");
        await queueWorker.stop();
        process.exit(0);
      });
      
      // Keep process alive
      await new Promise(() => {}); // Wait forever
      
    } catch (error) {
      logger.error("❌ Queue worker failed:", error);
      process.exit(1);
    }
    
    return;
  }
  
  // Legacy one-shot worker mode
  logger.info("🔄 Starting in legacy mode (one-shot worker)");
  const workerStartTime = Date.now();
  let worker: ClaudeWorker | null = null;
  
  try {
    logger.info("🚀 Starting Claude Code Worker");
    logger.info(`[TIMING] Worker process started at: ${new Date(workerStartTime).toISOString()}`);

    // Load configuration from environment
    const config: WorkerConfig = {
      sessionKey: process.env.SESSION_KEY!,
      userId: process.env.USER_ID!,
      username: process.env.USERNAME!,
      channelId: process.env.CHANNEL_ID!,
      threadTs: process.env.THREAD_TS || undefined,
      repositoryUrl: process.env.REPOSITORY_URL!,
      userPrompt: process.env.USER_PROMPT!, // Base64 encoded
      slackResponseChannel: process.env.SLACK_RESPONSE_CHANNEL!,
      slackResponseTs: process.env.SLACK_RESPONSE_TS!,
      claudeOptions: process.env.CLAUDE_OPTIONS!,
      resumeSessionId: process.env.RESUME_SESSION_ID,
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

    // Validate required configuration
    const required = [
      "SESSION_KEY", "USER_ID", "USERNAME", "CHANNEL_ID", 
      "REPOSITORY_URL", "USER_PROMPT", "SLACK_RESPONSE_CHANNEL", 
      "SLACK_RESPONSE_TS", "CLAUDE_OPTIONS", "SLACK_BOT_TOKEN",
      "GITHUB_TOKEN"
    ];

    const missingVars: string[] = [];
    for (const key of required) {
      if (!process.env[key]) {
        missingVars.push(key);
      }
    }

    if (missingVars.length > 0) {
      const errorMessage = `Missing required environment variables: ${missingVars.join(", ")}`;
      logger.error(`❌ ${errorMessage}`);
      
      // Try to update via queue if we have enough config
      if (process.env.DATABASE_URL && process.env.SLACK_RESPONSE_CHANNEL && process.env.SLACK_RESPONSE_TS) {
        try {
          const queueIntegration = new QueueIntegration({
            databaseUrl: process.env.DATABASE_URL,
            responseChannel: process.env.SLACK_RESPONSE_CHANNEL,
            responseTs: process.env.SLACK_RESPONSE_TS,
            messageId: process.env.SLACK_RESPONSE_TS
          });
          
          await queueIntegration.start();
          await queueIntegration.signalError(new Error(`Worker failed to start: ${errorMessage}`));
          await queueIntegration.stop();
        } catch (queueError) {
          logger.error("Failed to send error via queue:", queueError);
        }
      }
      
      throw new Error(errorMessage);
    }

    logger.info("Configuration loaded:");
    logger.info(`- Session: ${config.sessionKey}`);
    logger.info(`- User: ${config.username}`);
    logger.info(`- Repository: ${config.repositoryUrl}`);

    // Create and execute worker
    worker = new ClaudeWorker(config);
    await worker.execute();

    logger.info("✅ Worker execution completed successfully");
    process.exit(0);

  } catch (error) {
    logger.error("❌ Worker execution failed:", error);
    
    // Try to report error via queue if possible
    if (process.env.DATABASE_URL && process.env.SLACK_RESPONSE_CHANNEL && process.env.SLACK_RESPONSE_TS) {
      try {
        const queueIntegration = new QueueIntegration({
          databaseUrl: process.env.DATABASE_URL,
          responseChannel: process.env.SLACK_RESPONSE_CHANNEL,
          responseTs: process.env.SLACK_RESPONSE_TS,
          messageId: process.env.SLACK_RESPONSE_TS
        });
        
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        
        await queueIntegration.start();
        await queueIntegration.signalError(new Error(`Worker failed: ${errorMessage}`));
        await queueIntegration.stop();
      } catch (queueError) {
        logger.error("Failed to send error via queue:", queueError);
      }
    }
    
    // Cleanup if worker was created
    if (worker) {
      try {
        await worker.cleanup();
      } catch (cleanupError) {
        logger.error("Error during cleanup:", cleanupError);
      }
    }
    
    process.exit(1);
  }
}

// Handle process signals
process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, shutting down gracefully...");
  await appendTerminationMessage("SIGTERM");
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("Received SIGINT, shutting down gracefully...");
  await appendTerminationMessage("SIGINT");
  process.exit(0);
});

/**
 * Append termination message via queue when worker is terminated
 */
async function appendTerminationMessage(signal: string): Promise<void> {
  try {
    if (process.env.DATABASE_URL && process.env.SLACK_RESPONSE_CHANNEL && process.env.SLACK_RESPONSE_TS) {
      const queueIntegration = new QueueIntegration({
        databaseUrl: process.env.DATABASE_URL,
        responseChannel: process.env.SLACK_RESPONSE_CHANNEL,
        responseTs: process.env.SLACK_RESPONSE_TS,
        messageId: process.env.SLACK_RESPONSE_TS
      });
      
      await queueIntegration.start();
      await queueIntegration.updateProgress(
        `🛑 **Worker terminated (${signal})** - The host is terminated and not processing further requests.`
      );
      await queueIntegration.signalDone();
      
      // Reactions are now handled by dispatcher based on message isDone status
      // No direct reaction calls needed here
      
      await queueIntegration.stop();
    }
  } catch (error) {
    logger.error(`Failed to send ${signal} termination message via queue:`, error);
  }
}

// Only start main() if explicitly requested via environment variable
// This prevents side effects when importing ClaudeWorker class
if (process.env.RUN_WORKER_MAIN === "true" || process.env.WORKER_MODE === "queue") {
  main();
}

export type { WorkerConfig } from "./types";