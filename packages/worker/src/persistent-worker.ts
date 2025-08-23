#!/usr/bin/env bun

// Set TLS verification before any imports that might use HTTPS
if (process.env.K8S_SKIP_TLS_VERIFY === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import { QueuePersistentClaudeWorker } from "./queue-persistent-worker";
import logger from "./logger";

/**
 * Main entry point for persistent worker - Queue mode only
 * ConfigMap communication has been removed in favor of PostgreSQL queues
 */
async function main() {
  try {
    // Always use queue-based worker (PostgreSQL mode only)
    logger.info('Starting persistent worker in QUEUE mode');
    
    const userId = process.env.USER_ID;
    if (!userId) {
      logger.error('USER_ID environment variable is required for queue mode');
      process.exit(1);
    }
    
    const queueWorker = new QueuePersistentClaudeWorker(userId);
    await queueWorker.start();
    
    // Keep the process running
    await new Promise(() => {}); // Run forever
    
  } catch (error) {
    logger.error("❌ Persistent worker failed:", error);
    process.exit(1);
  }
}

// Graceful shutdown handlers
process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

// Start the persistent worker
main();