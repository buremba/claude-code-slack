#!/usr/bin/env bun

import * as k8s from "@kubernetes/client-node";
import logger from "../logger";
import type { 
  KubernetesConfig,
  WorkerJobRequest
} from "../types";
import { KubernetesError } from "../types";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class KubernetesJobManager {
  private k8sApi: k8s.BatchV1Api;
  private k8sCoreApi: k8s.CoreV1Api;
  private k8sAppsApi: k8s.AppsV1Api;
  private activeJobs = new Map<string, string>(); // sessionKey -> deploymentName
  private rateLimitMap = new Map<string, RateLimitEntry>(); // userId -> rate limit data
  private config: KubernetesConfig;
  
  // Rate limiting configuration
  private readonly RATE_LIMIT_MAX_JOBS = process.env.DISABLE_RATE_LIMIT === 'true' ? 999 : 5; // Max jobs per user per window
  private readonly RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes window

  constructor(config: KubernetesConfig) {
    this.config = config;

    // Initialize Kubernetes client
    const kc = new k8s.KubeConfig();
    
    // Check if we're running in a Kubernetes pod
    const inCluster = process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT;
    
    if (config.kubeconfig) {
      // Explicit kubeconfig path provided
      kc.loadFromFile(config.kubeconfig);
      logger.info(`✅ Loaded Kubernetes configuration from ${config.kubeconfig}`);
    } else {
      
      if (inCluster) {
        try {
          kc.loadFromCluster();
          logger.info("✅ Successfully loaded in-cluster Kubernetes configuration");
        } catch (error) {
          logger.error("❌ Failed to load in-cluster config:", error);
          throw new Error("Failed to load in-cluster Kubernetes configuration: " + (error as Error).message);
        }
      } else {
        // Running locally, use default kubeconfig
        try {
          kc.loadFromDefault();
          logger.info("✅ Loaded Kubernetes configuration from default kubeconfig");
        } catch (error) {
          logger.error("❌ Failed to load default kubeconfig:", error);
          logger.error("   Make sure you have kubectl configured or set KUBECONFIG environment variable");
          throw new Error("Failed to load Kubernetes configuration. Please ensure kubectl is configured.");
        }
      }
    }

    // For local development with Docker Desktop, we may need to skip TLS verification
    // This is safe for local development but should not be used in production
    if (!inCluster && process.env.NODE_ENV !== 'production') {
      const clusters = kc.getClusters();
      clusters.forEach(cluster => {
        if (cluster.server && (cluster.server.includes('127.0.0.1') || cluster.server.includes('localhost'))) {
          // Use type assertion to modify the readonly property
          (cluster as any).skipTLSVerify = true;
          logger.info(`⚠️  Skipping TLS verification for cluster: ${cluster.name}`);
        }
      });
    }
    
    this.k8sApi = kc.makeApiClient(k8s.BatchV1Api);
    this.k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
    
    // Start cleanup timer for rate limit entries
    this.startRateLimitCleanup();
    
    // Restore active jobs from Kubernetes on startup
    this.restoreActiveJobs().catch(error => {
      logger.error("Failed to restore active jobs on startup:", error);
    });
  }

  /**
   * Check if user is within rate limits
   */
  private checkRateLimit(userId: string | undefined): boolean {
    // Use a default ID for undefined users to prevent them from bypassing rate limits
    const effectiveUserId = userId || "anonymous";
    
    const now = Date.now();
    const entry = this.rateLimitMap.get(effectiveUserId);
    
    if (!entry) {
      // First request for this user
      this.rateLimitMap.set(effectiveUserId, { count: 1, windowStart: now });
      return true;
    }
    
    // Check if we're in a new window
    if (now - entry.windowStart >= this.RATE_LIMIT_WINDOW_MS) {
      // Reset for new window
      entry.count = 1;
      entry.windowStart = now;
      return true;
    }
    
    // Check if under limit
    if (entry.count < this.RATE_LIMIT_MAX_JOBS) {
      entry.count++;
      return true;
    }
    
    // Rate limit exceeded
    logger.warn(`Rate limit exceeded for user ${effectiveUserId}: ${entry.count} jobs in current window`);
    return false;
  }

  /**
   * Start periodic cleanup of expired rate limit entries
   */
  private startRateLimitCleanup(): void {
    const cleanupInterval = 5 * 60 * 1000; // Clean up every 5 minutes
    
    setInterval(() => {
      const now = Date.now();
      for (const [userId, entry] of this.rateLimitMap.entries()) {
        if (now - entry.windowStart >= this.RATE_LIMIT_WINDOW_MS) {
          this.rateLimitMap.delete(userId);
        }
      }
    }, cleanupInterval);
  }

  /**
   * Restore active jobs from Kubernetes on startup
   */
  private async restoreActiveJobs(): Promise<void> {
    try {
      logger.info("Restoring active jobs from Kubernetes...");
      
      // List all claude-worker jobs
      const jobsResponse = await this.k8sApi.listNamespacedJob({
        namespace: this.config.namespace,
        labelSelector: "app=claude-worker"
      });
      
      let activeCount = 0;
      for (const job of jobsResponse.items) {
        const jobName = job.metadata?.name;
        const status = job.status;
        const annotations = job.metadata?.annotations || {};
        const sessionKey = annotations["claude.ai/session-key"];
        
        // Check if job is still active (not completed or failed)
        if (jobName && sessionKey && !status?.succeeded && !status?.failed) {
          this.activeJobs.set(sessionKey, jobName);
          activeCount++;
          logger.info(`Restored active job ${jobName} for session ${sessionKey}`);
        }
      }
      
      logger.info(`✅ Restored ${activeCount} active jobs from Kubernetes on startup`);
    } catch (error) {
      logger.error("Error restoring active jobs:", error);
    }
  }

  /**
   * Find an existing worker deployment for a session by checking Kubernetes labels
   */
  private async findExistingWorkerForSession(sessionKey: string): Promise<string | null> {
    try {
      // Create a safe label value from the session key
      const labelValue = sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      
      // List deployments with the session-key label
      const deploymentsResponse = await this.k8sAppsApi.listNamespacedDeployment({
        namespace: this.config.namespace,
        labelSelector: `session-key=${labelValue}`
      });
      
      // Find active deployments
      for (const deployment of deploymentsResponse.items) {
        const deploymentName = deployment.metadata?.name;
        const status = deployment.status;
        
        // Check if deployment is active and ready
        if (deploymentName && status?.readyReplicas && status?.readyReplicas > 0) {
          // Also check the annotation to verify it's the exact session
          const annotations = deployment.metadata?.annotations || {};
          if (annotations["claude.ai/session-key"] === sessionKey) {
            logger.info(`Found existing active worker ${deploymentName} for session ${sessionKey}`);
            return deploymentName;
          }
        }
      }
      
      return null;
    } catch (error) {
      logger.error(`Error checking for existing worker for session ${sessionKey}:`, error);
      return null;
    }
  }

  /**
   * Create or get a persistent worker for the user request
   */
  async createWorkerJob(request: WorkerJobRequest): Promise<string> {
    // Check rate limits first
    if (!this.checkRateLimit(request.userId)) {
      throw new KubernetesError(
        "createWorkerJob",
        `Rate limit exceeded for user ${request.userId}. Maximum ${this.RATE_LIMIT_MAX_JOBS} jobs per ${this.RATE_LIMIT_WINDOW_MS / 1000 / 60} minutes`,
        new Error("Rate limit exceeded")
      );
    }

    const workerName = this.generateWorkerName(request.sessionKey);
    
    try {
      // Check if worker already exists in memory
      const existingWorkerName = this.activeJobs.get(request.sessionKey);
      if (existingWorkerName) {
        logger.info(`Worker already exists for session ${request.sessionKey}: ${existingWorkerName}`);
        // Send message to existing worker via ConfigMap
        await this.sendMessageToWorker(existingWorkerName, request);
        return existingWorkerName;
      }

      // Check if a worker already exists in Kubernetes for this session
      // This handles the case where the dispatcher was restarted
      const existingWorker = await this.findExistingWorkerForSession(request.sessionKey);
      if (existingWorker) {
        logger.info(`Found existing Kubernetes worker for session ${request.sessionKey}: ${existingWorker}`);
        // Track it in memory for this instance
        this.activeJobs.set(request.sessionKey, existingWorker);
        // Send message to existing worker via ConfigMap
        await this.sendMessageToWorker(existingWorker, request);
        return existingWorker;
      }

      // Create worker deployment manifest
      const deploymentManifest = this.createWorkerDeploymentManifest(workerName, request);

      // Create the deployment
      await this.k8sAppsApi.createNamespacedDeployment({
        namespace: this.config.namespace,
        body: deploymentManifest
      });
      
      // Track the worker
      this.activeJobs.set(request.sessionKey, workerName);
      
      logger.info(`Created Kubernetes worker deployment: ${workerName} for session ${request.sessionKey}`);
      
      // Start monitoring the worker
      this.monitorWorker(workerName, request.sessionKey);
      
      return workerName;

    } catch (error) {
      throw new KubernetesError(
        "createWorkerJob",
        `Failed to create worker for session ${request.sessionKey}`,
        error as Error
      );
    }
  }

  /**
   * Generate worker name based on session key (thread timestamp)
   */
  private generateWorkerName(sessionKey: string): string {
    // Use the session key (thread timestamp) directly for persistent worker
    // Replace dots with dashes for Kubernetes naming conventions
    const safeSessionKey = sessionKey.replace(/\./g, "-").toLowerCase();
    
    // No timestamp suffix needed since we want one worker per thread
    return `claude-worker-${safeSessionKey}`;
  }

  /**
   * Send message to existing worker via ConfigMap
   */
  private async sendMessageToWorker(workerName: string, request: WorkerJobRequest): Promise<void> {
    try {
      const messageId = `msg-${Date.now()}`;
      const configMapName = `${workerName}-message-${messageId}`;
      
      const configMap: k8s.V1ConfigMap = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: configMapName,
          namespace: this.config.namespace,
          labels: {
            "claude.ai/worker": workerName,
            "claude.ai/message-type": "user-request"
          },
          annotations: {
            "claude.ai/session-key": request.sessionKey,
            "claude.ai/message-id": messageId,
            "claude.ai/created-at": new Date().toISOString(),
          }
        },
        data: {
          userPrompt: request.userPrompt,
          slackResponseChannel: request.slackResponseChannel,
          slackResponseTs: request.slackResponseTs,
          originalMessageTs: request.originalMessageTs || "",
          claudeOptions: JSON.stringify(request.claudeOptions),
          resumeSessionId: request.resumeSessionId || "",
        }
      };

      await this.k8sCoreApi.createNamespacedConfigMap({
        namespace: this.config.namespace,
        body: configMap
      });

      logger.info(`Sent message ${messageId} to worker ${workerName} via ConfigMap ${configMapName}`);
    } catch (error) {
      logger.error(`Failed to send message to worker ${workerName}:`, error);
      throw error;
    }
  }

  /**
   * Create Kubernetes Deployment manifest for persistent worker
   */
  private createWorkerDeploymentManifest(workerName: string, request: WorkerJobRequest): k8s.V1Deployment {
    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: workerName,
        namespace: this.config.namespace,
        labels: {
          app: "claude-worker",
          "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
          "user-id": request.userId,
          component: "worker",
        },
        annotations: {
          "claude.ai/session-key": request.sessionKey,
          "claude.ai/user-id": request.userId,
          "claude.ai/username": request.username,
          "claude.ai/created-at": new Date().toISOString(),
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: "claude-worker",
            "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
          },
        },
        template: {
          metadata: {
            labels: {
              app: "claude-worker",
              "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
              component: "worker",
            },
          },
          spec: {
            restartPolicy: "Always",
            priorityClassName: "worker-priority",
            serviceAccountName: "claude-worker",
            // Prefer spot instances but allow running on any node
            tolerations: [
              {
                key: "cloud.google.com/gke-spot",
                operator: "Equal",
                value: "true",
                effect: "NoSchedule",
              },
            ],
            containers: [
              {
                name: "claude-worker",
                image: this.config.workerImage,
                imagePullPolicy: "Always",
                command: ["bun", "run", "dist/persistent-worker.js"],
                resources: {
                  requests: {
                    cpu: this.config.cpu,
                    memory: this.config.memory,
                  },
                  limits: {
                    cpu: this.config.cpu,
                    memory: this.config.memory,
                  },
                },
                env: [
                  {
                    name: "SESSION_KEY",
                    value: request.sessionKey,
                  },
                  {
                    name: "USER_ID",
                    value: request.userId,
                  },
                  {
                    name: "USERNAME",
                    value: request.username,
                  },
                  {
                    name: "CHANNEL_ID",
                    value: request.channelId,
                  },
                  {
                    name: "THREAD_TS",
                    value: request.threadTs || "",
                  },
                  {
                    name: "REPOSITORY_URL",
                    value: request.repositoryUrl,
                  },
                  {
                    name: "WORKER_NAME",
                    value: workerName,
                  },
                  {
                    name: "SESSION_TIMEOUT_MINUTES",
                    value: "5", // 5 minute timeout for inactive sessions
                  },
                  // Initial message for the first request
                  {
                    name: "INITIAL_USER_PROMPT",
                    value: Buffer.from(request.userPrompt).toString("base64"),
                  },
                  {
                    name: "INITIAL_SLACK_RESPONSE_CHANNEL",
                    value: request.slackResponseChannel,
                  },
                  {
                    name: "INITIAL_SLACK_RESPONSE_TS",
                    value: request.slackResponseTs,
                  },
                  {
                    name: "INITIAL_ORIGINAL_MESSAGE_TS",
                    value: request.originalMessageTs || "",
                  },
                  {
                    name: "INITIAL_CLAUDE_OPTIONS",
                    value: JSON.stringify(request.claudeOptions),
                  },
                  {
                    name: "INITIAL_RESUME_SESSION_ID",
                    value: request.resumeSessionId || "",
                  },
                  // Worker needs Slack token to send progress updates
                  {
                    name: "SLACK_BOT_TOKEN",
                    valueFrom: {
                      secretKeyRef: {
                        name: "peerbot-secrets",
                        key: "slack-bot-token",
                      },
                    },
                  },
                  {
                    name: "GITHUB_TOKEN",
                    valueFrom: {
                      secretKeyRef: {
                        name: "peerbot-secrets",
                        key: "github-token",
                      },
                    },
                  },
                  {
                    name: "CLAUDE_CODE_OAUTH_TOKEN",
                    valueFrom: {
                      secretKeyRef: {
                        name: "peerbot-secrets",
                        key: "claude-code-oauth-token",
                      },
                    },
                  },
                  {
                    name: "CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS",
                    value: "1",
                  },
                  {
                    name: "K8S_SKIP_TLS_VERIFY",
                    value: "true",
                  },
                ],
                volumeMounts: [
                  {
                    name: "workspace",
                    mountPath: "/workspace",
                  },
                ],
                workingDir: "/app/packages/worker",
              },
            ],
            volumes: [
              {
                name: "workspace",
                persistentVolumeClaim: {
                  claimName: "peerbot-worker-pvc",
                },
              },
            ],
          },
        },
      },
    };
  }

  
  /**
   * Monitor worker deployment status
   */
  private async monitorWorker(workerName: string, sessionKey: string): Promise<void> {
    const maxAttempts = 60; // Monitor for up to 10 minutes (10s intervals)
    let attempts = 0;

    const checkStatus = async () => {
      try {
        attempts++;
        
        const deploymentResponse = await this.k8sAppsApi.readNamespacedDeployment({
          name: workerName,
          namespace: this.config.namespace
        });
        const deployment = deploymentResponse;
        
        const status = deployment.status;
        
        if (status?.readyReplicas && status.readyReplicas > 0) {
          logger.info(`Worker ${workerName} is ready and running`);
          return; // Worker is ready, stop monitoring initial startup
        }
        
        // Check if deployment failed
        if (status?.conditions) {
          const failedCondition = status.conditions.find(c => 
            c.type === "Progressing" && c.status === "False"
          );
          if (failedCondition) {
            logger.error(`Worker ${workerName} failed to deploy: ${failedCondition.reason} - ${failedCondition.message}`);
            this.activeJobs.delete(sessionKey);
            return;
          }
        }
        
        // Check if max attempts reached
        if (attempts >= maxAttempts) {
          logger.warn(`Worker ${workerName} monitoring timed out after ${maxAttempts} attempts`);
          return;
        }
        
        // Continue monitoring
        setTimeout(checkStatus, 10000); // Check every 10 seconds
        
      } catch (error) {
        logger.error(`Error monitoring worker ${workerName}:`, error);
        if (attempts < maxAttempts) {
          setTimeout(checkStatus, 10000);
        }
      }
    };

    // Start monitoring
    setTimeout(checkStatus, 5000); // Initial delay of 5 seconds
  }


  /**
   * Delete a job
   */
  async deleteJob(jobName: string): Promise<void> {
    try {
      await this.k8sApi.deleteNamespacedJob({
        name: jobName,
        namespace: this.config.namespace,
        body: {
          propagationPolicy: "Background"
        }
      });
      
      logger.info(`Deleted job: ${jobName}`);
    } catch (error) {
      logger.error(`Failed to delete job ${jobName}:`, error);
    }
  }

  /**
   * Get job status
   */
  async getJobStatus(jobName: string): Promise<string> {
    try {
      const response = await this.k8sApi.readNamespacedJob({
        name: jobName,
        namespace: this.config.namespace
      });
      const job = response;
      
      if (job.status?.succeeded) return "succeeded";
      if (job.status?.failed) return "failed";
      if (job.status?.active) return "running";
      
      return "pending";
    } catch (error) {
      return "unknown";
    }
  }

  /**
   * Get job name for a session
   */
  async getJobForSession(sessionKey: string): Promise<string | null> {
    return this.activeJobs.get(sessionKey) || null;
  }

  /**
   * Get logs from a worker pod
   */
  async getJobLogs(jobName: string): Promise<string | null> {
    try {
      // Find pods for this job
      const podsResponse = await this.k8sCoreApi.listNamespacedPod({
        namespace: this.config.namespace,
        labelSelector: `job-name=${jobName}`
      });
      
      if (!podsResponse.items || podsResponse.items.length === 0) {
        logger.info(`No pods found for job ${jobName}`);
        return null;
      }
      
      const pod = podsResponse.items[0];
      const podName = pod?.metadata?.name;
      
      if (!podName) {
        logger.info(`Pod name not found for job ${jobName}`);
        return null;
      }
      
      // Get logs from the pod
      const logsResponse = await this.k8sCoreApi.readNamespacedPodLog({
        name: podName,
        namespace: this.config.namespace,
        container: "claude-worker",
        tailLines: 10000 // Get last 10k lines
      });
      
      return logsResponse;
    } catch (error) {
      logger.error(`Failed to get logs for job ${jobName}:`, error);
      return null;
    }
  }

  /**
   * Extract session data from pod logs
   */
  extractSessionFromLogs(logs: string): any | null {
    try {
      // Look for session data markers in logs
      const sessionMarker = "SESSION_DATA_START";
      const sessionEndMarker = "SESSION_DATA_END";
      
      const startIndex = logs.indexOf(sessionMarker);
      const endIndex = logs.indexOf(sessionEndMarker);
      
      if (startIndex === -1 || endIndex === -1) {
        return null;
      }
      
      const sessionJson = logs.substring(
        startIndex + sessionMarker.length,
        endIndex
      ).trim();
      
      return JSON.parse(sessionJson);
    } catch (error) {
      logger.error("Failed to extract session from logs:", error);
      return null;
    }
  }

  /**
   * List active jobs
   */
  async listActiveJobs(): Promise<Array<{ name: string; sessionKey: string; status: string }>> {
    const jobs = [];
    
    for (const [sessionKey, jobName] of this.activeJobs.entries()) {
      const status = await this.getJobStatus(jobName);
      jobs.push({ name: jobName, sessionKey, status });
    }
    
    return jobs;
  }

  /**
   * Get active job count
   */
  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Cleanup all jobs
   */
  async cleanup(): Promise<void> {
    logger.info(`Cleaning up ${this.activeJobs.size} active jobs...`);
    
    const promises = Array.from(this.activeJobs.values()).map(jobName =>
      this.deleteJob(jobName).catch(error => 
        logger.error(`Failed to delete job ${jobName}:`, error)
      )
    );
    
    await Promise.allSettled(promises);
    this.activeJobs.clear();
    
    logger.info("Job cleanup completed");
  }
}