#!/usr/bin/env bun

// Set TLS verification before any imports that might use HTTPS
if (process.env.K8S_SKIP_TLS_VERIFY === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import { ClaudeWorker } from "./claude-worker";
import type { WorkerConfig } from "./types";
import logger from "./logger";
import * as k8s from "@kubernetes/client-node";

export class PersistentClaudeWorker {
  private worker: ClaudeWorker | null = null;
  private config: WorkerConfig;
  private k8sCoreApi: k8s.CoreV1Api;
  private workerName: string;
  private namespace: string;
  private lastActivity: number = Date.now();
  private timeoutMinutes: number = 5;
  private isProcessing: boolean = false;

  constructor() {
    // Initialize Kubernetes client
    const kc = new k8s.KubeConfig();
    const inCluster = process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT;
    
    if (inCluster) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    
    // TLS verification is configured at the top of the file
    
    this.k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.workerName = process.env.WORKER_NAME!;
    this.namespace = process.env.KUBERNETES_NAMESPACE || "peerbot";
    this.timeoutMinutes = parseInt(process.env.SESSION_TIMEOUT_MINUTES || "5");
    
    // Load initial configuration from environment
    this.config = this.loadConfigFromEnv();
    
    logger.info(`🚀 Starting Persistent Claude Worker: ${this.workerName}`);
    logger.info(`- Session timeout: ${this.timeoutMinutes} minutes`);
    logger.info(`- Session key: ${this.config.sessionKey}`);
  }

  private loadConfigFromEnv(): WorkerConfig {
    // DEBUG: Log environment variables for debugging
    logger.info(`[DEBUG] ENV - INITIAL_SLACK_RESPONSE_CHANNEL: ${process.env.INITIAL_SLACK_RESPONSE_CHANNEL}`);
    logger.info(`[DEBUG] ENV - INITIAL_SLACK_RESPONSE_TS: ${process.env.INITIAL_SLACK_RESPONSE_TS}`);
    
    return {
      sessionKey: process.env.SESSION_KEY!,
      userId: process.env.USER_ID!,
      username: process.env.USERNAME!,
      channelId: process.env.CHANNEL_ID!,
      threadTs: process.env.THREAD_TS || undefined,
      repositoryUrl: process.env.REPOSITORY_URL!,
      userPrompt: process.env.INITIAL_USER_PROMPT!, // Base64 encoded
      slackResponseChannel: process.env.INITIAL_SLACK_RESPONSE_CHANNEL!,
      slackResponseTs: process.env.INITIAL_SLACK_RESPONSE_TS!,
      claudeOptions: process.env.INITIAL_CLAUDE_OPTIONS!,
      resumeSessionId: process.env.INITIAL_RESUME_SESSION_ID,
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
      // Process initial message
      await this.processMessage(this.config);
      
      // Start watching for new messages
      this.startMessageWatcher();
      
      // Start timeout monitor
      this.startTimeoutMonitor();
      
      logger.info(`✅ Persistent worker ${this.workerName} started successfully`);
      
    } catch (error) {
      logger.error("Failed to start persistent worker:", error);
      process.exit(1);
    }
  }

  private async processMessage(messageConfig: WorkerConfig): Promise<void> {
    if (this.isProcessing) {
      logger.warn("Already processing a message, skipping...");
      return;
    }

    this.isProcessing = true;
    this.lastActivity = Date.now();
    
    try {
      logger.info(`Processing message: ${messageConfig.userPrompt.substring(0, 100)}...`);
      
      // Set ORIGINAL_MESSAGE_TS for reactions
      if (process.env.INITIAL_ORIGINAL_MESSAGE_TS) {
        process.env.ORIGINAL_MESSAGE_TS = process.env.INITIAL_ORIGINAL_MESSAGE_TS;
      }
      
      // Create a new worker instance for this message
      try {
        this.worker = new ClaudeWorker(messageConfig);
      } catch (workerInitError) {
        logger.error("Failed to initialize ClaudeWorker:", workerInitError);
        // Worker constructor should have already posted error to Slack
        throw workerInitError;
      }
      
      await this.worker.execute();
      logger.info("Message processed successfully");
      
    } catch (error) {
      logger.error("Error processing message:", error);
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
      
      this.isProcessing = false;
      this.lastActivity = Date.now();
    }
  }

  private startMessageWatcher(): void {
    const checkInterval = 2000; // Check every 2 seconds
    
    setInterval(async () => {
      try {
        await this.checkForNewMessages();
      } catch (error) {
        logger.error("Error checking for new messages:", error);
      }
    }, checkInterval);
    
    logger.info("Started message watcher");
  }

  private async checkForNewMessages(): Promise<void> {
    try {
      // List ConfigMaps that contain messages for this worker
      const configMapsResponse = await this.k8sCoreApi.listNamespacedConfigMap({
        namespace: this.namespace,
        labelSelector: `claude.ai/worker=${this.workerName},claude.ai/message-type=user-request`
      });

      for (const configMap of configMapsResponse.items) {
        const messageId = configMap.metadata?.annotations?.["claude.ai/message-id"];
        if (!messageId) continue;

        // Check if we've already processed this message
        const processedLabel = `claude.ai/processed-${messageId}`;
        if (configMap.metadata?.labels?.[processedLabel] === "true") {
          continue;
        }

        // Mark as processing
        try {
          await this.markMessageAsProcessed(configMap.metadata!.name!, messageId);
          
          // Extract message data and process
          const messageConfig = this.configMapToWorkerConfig(configMap);
          await this.processMessage(messageConfig);
          
        } catch (error) {
          logger.error(`Error processing message ${messageId}:`, error);
        }
      }
    } catch (error) {
      logger.error("Error checking for new messages:", error);
    }
  }

  private async markMessageAsProcessed(configMapName: string, messageId: string): Promise<void> {
    try {
      // Add processed label to prevent reprocessing
      const patch = {
        metadata: {
          labels: {
            [`claude.ai/processed-${messageId}`]: "true"
          }
        }
      };

      await this.k8sCoreApi.patchNamespacedConfigMap({
        name: configMapName,
        namespace: this.namespace,
        body: patch
      });

      logger.info(`Marked message ${messageId} as processed`);
    } catch (error) {
      logger.error(`Failed to mark message ${messageId} as processed:`, error);
      throw error;
    }
  }

  private configMapToWorkerConfig(configMap: k8s.V1ConfigMap): WorkerConfig {
    const data = configMap.data!;
    
    return {
      ...this.config, // Keep session-level config
      userPrompt: data.userPrompt!,
      slackResponseChannel: data.slackResponseChannel!,
      slackResponseTs: data.slackResponseTs!,
      claudeOptions: data.claudeOptions!,
      resumeSessionId: data.resumeSessionId || undefined,
    };
  }

  private startTimeoutMonitor(): void {
    const checkInterval = 30000; // Check every 30 seconds
    const timeoutMs = this.timeoutMinutes * 60 * 1000;
    
    setInterval(() => {
      const now = Date.now();
      const timeSinceLastActivity = now - this.lastActivity;
      
      if (timeSinceLastActivity > timeoutMs && !this.isProcessing) {
        logger.info(`Worker ${this.workerName} timed out after ${this.timeoutMinutes} minutes of inactivity`);
        this.shutdown();
      }
    }, checkInterval);
    
    logger.info(`Started timeout monitor (${this.timeoutMinutes} minutes)`);
  }

  private async shutdown(): Promise<void> {
    logger.info(`Shutting down persistent worker ${this.workerName}...`);
    
    try {
      // Cleanup current worker if processing
      if (this.worker) {
        await this.worker.cleanup();
      }
      
      // Delete the deployment to terminate this worker
      await this.deleteDeployment();
      
    } catch (error) {
      logger.error("Error during shutdown:", error);
    }
    
    process.exit(0);
  }

  private async deleteDeployment(): Promise<void> {
    try {
      const kc = new k8s.KubeConfig();
      const inCluster = process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT;
      
      if (inCluster) {
        kc.loadFromCluster();
      } else {
        kc.loadFromDefault();
      }
      
      // TLS verification is configured at the top of the file
      
      const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
      
      await k8sAppsApi.deleteNamespacedDeployment({
        name: this.workerName,
        namespace: this.namespace,
        body: {
          propagationPolicy: "Background"
        }
      });
      
      logger.info(`Deleted deployment ${this.workerName}`);
    } catch (error) {
      logger.error(`Failed to delete deployment ${this.workerName}:`, error);
    }
  }
}

/**
 * Main entry point for persistent worker
 */
async function main() {
  try {
    const persistentWorker = new PersistentClaudeWorker();
    await persistentWorker.start();
    
    // Keep the process running
    await new Promise(() => {}); // Run forever
    
  } catch (error) {
    logger.error("❌ Persistent worker failed:", error);
    process.exit(1);
  }
}

// Handle process signals
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