#!/usr/bin/env bun

/**
 * Main orchestrator service entry point
 * Processes direct_message queue and creates Kubernetes worker deployments
 */

import { QueueConsumer } from "./queue-consumer";
import type { OrchestratorConfig } from "./types";

// Load configuration from environment
function loadConfig(): OrchestratorConfig {
  return {
    kubernetes: {
      namespace: process.env.KUBERNETES_NAMESPACE || "peerbot",
      workerImage: process.env.WORKER_IMAGE || "claude-worker:latest",
      cpu: process.env.WORKER_CPU || "1",
      memory: process.env.WORKER_MEMORY || "2Gi",
      kubeconfig: process.env.KUBECONFIG,
    },
    database: {
      host: process.env.DATABASE_HOST || "peerbot-postgresql",
      port: parseInt(process.env.DATABASE_PORT || "5432"),
      database: process.env.DATABASE_NAME || "peerbot",
      username: process.env.DATABASE_USER || "postgres",
      password: process.env.DATABASE_PASSWORD || "",
      ssl: process.env.DATABASE_SSL === "true",
    },
    pgboss: {
      connectionString: process.env.PGBOSS_CONNECTION_STRING || 
        `postgres://${process.env.DATABASE_USER}:${process.env.DATABASE_PASSWORD}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT}/${process.env.DATABASE_NAME}`,
      retryLimit: parseInt(process.env.PGBOSS_RETRY_LIMIT || "3"),
      retryDelay: parseInt(process.env.PGBOSS_RETRY_DELAY || "30"),
      expireInHours: parseInt(process.env.PGBOSS_EXPIRE_HOURS || "24"),
    },
    queues: {
      directMessage: process.env.QUEUE_DIRECT_MESSAGE || "direct_message",
      threadMessage: process.env.QUEUE_THREAD_MESSAGE || "thread_message",
    },
  };
}

async function main() {
  console.log("🚀 Starting Claude Code Orchestrator...");
  
  try {
    const config = loadConfig();
    const consumer = new QueueConsumer(config);
    
    // Start the queue consumer
    await consumer.start();
    
    // Setup graceful shutdown
    process.on("SIGTERM", async () => {
      console.log("Received SIGTERM, shutting down gracefully...");
      await consumer.stop();
      process.exit(0);
    });

    process.on("SIGINT", async () => {
      console.log("Received SIGINT, shutting down gracefully...");
      await consumer.stop();
      process.exit(0);
    });

    // Setup health check endpoint (basic HTTP server)
    const server = Bun.serve({
      port: process.env.PORT || 8080,
      fetch(req) {
        const url = new URL(req.url);
        
        if (url.pathname === "/health") {
          const isHealthy = consumer.isHealthy();
          return new Response(
            JSON.stringify({ 
              status: isHealthy ? "healthy" : "unhealthy",
              timestamp: new Date().toISOString()
            }),
            { 
              status: isHealthy ? 200 : 503,
              headers: { "Content-Type": "application/json" }
            }
          );
        }
        
        if (url.pathname === "/stats") {
          return consumer.getQueueStats().then(stats => 
            new Response(JSON.stringify(stats), {
              headers: { "Content-Type": "application/json" }
            })
          );
        }
        
        return new Response("Not Found", { status: 404 });
      },
    });

    console.log(`✅ Orchestrator started successfully`);
    console.log(`- Health check: http://localhost:${server.port}/health`);
    console.log(`- Queue stats: http://localhost:${server.port}/stats`);
    console.log(`- Processing queue: ${config.queues.directMessage}`);
    
    // Keep the process running
    await new Promise(() => {});
    
  } catch (error) {
    console.error("❌ Failed to start orchestrator:", error);
    process.exit(1);
  }
}

// Start the orchestrator
main();

export * from "./types";
export * from "./queue-consumer";
export * from "./kubernetes-orchestrator";