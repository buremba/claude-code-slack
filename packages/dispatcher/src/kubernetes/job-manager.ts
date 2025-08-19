#!/usr/bin/env bun

import * as k8s from "@kubernetes/client-node";
import fetch from "node-fetch";
import logger from "../logger";
import type { 
  KubernetesConfig,
  WorkerJobRequest,
  JobTemplateData,
  WorkerInfo,
  WorkerStatus,
  TaskSubmissionRequest
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
  private activeJobs = new Map<string, string>(); // sessionKey -> jobName
  private activeWorkers = new Map<string, WorkerInfo>(); // sessionKey -> WorkerInfo for persistent workers
  private workerTimeouts = new Map<string, NodeJS.Timeout>(); // sessionKey -> timeout timer
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
   * Find an existing job for a session by checking Kubernetes labels
   */
  private async findExistingJobForSession(sessionKey: string): Promise<string | null> {
    try {
      // Create a safe label value from the session key
      const labelValue = sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      
      // List jobs with the session-key label
      const jobsResponse = await this.k8sApi.listNamespacedJob({
        namespace: this.config.namespace,
        labelSelector: `session-key=${labelValue}`
      });
      
      // Find active jobs (not completed or failed)
      for (const job of jobsResponse.items) {
        const jobName = job.metadata?.name;
        const status = job.status;
        
        // Check if job is still active (not completed or failed)
        if (jobName && !status?.succeeded && !status?.failed) {
          // Also check the annotation to verify it's the exact session
          const annotations = job.metadata?.annotations || {};
          if (annotations["claude.ai/session-key"] === sessionKey) {
            logger.info(`Found existing active job ${jobName} for session ${sessionKey}`);
            return jobName;
          }
        }
      }
      
      return null;
    } catch (error) {
      logger.error(`Error checking for existing job for session ${sessionKey}:`, error);
      return null;
    }
  }

  /**
   * Find an available worker for the session key
   */
  private findAvailableWorker(sessionKey: string): WorkerInfo | null {
    const worker = this.activeWorkers.get(sessionKey);
    if (worker && worker.status === WorkerStatus.idle) {
      return worker;
    }
    return null;
  }

  /**
   * Submit a task to an existing worker
   */
  private async submitTaskToWorker(workerInfo: WorkerInfo, taskRequest: TaskSubmissionRequest): Promise<boolean> {
    try {
      const response = await fetch(`${workerInfo.endpoint}/task`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(taskRequest),
        timeout: 5000 // 5 second timeout
      });

      if (response.ok) {
        // Update worker status and reset timeout
        workerInfo.status = WorkerStatus.busy;
        workerInfo.lastActivity = Date.now();
        this.resetWorkerTimeout(workerInfo.sessionKey);
        logger.info(`Successfully submitted task to worker ${workerInfo.podName}`);
        return true;
      } else {
        logger.warn(`Failed to submit task to worker ${workerInfo.podName}: ${response.status}`);
        return false;
      }
    } catch (error) {
      logger.error(`Error submitting task to worker ${workerInfo.podName}:`, error);
      return false;
    }
  }

  /**
   * Create a persistent worker deployment
   */
  private async createPersistentWorker(request: WorkerJobRequest): Promise<string> {
    const deploymentName = this.generateDeploymentName(request.sessionKey);
    
    try {
      // Create deployment manifest
      const deploymentManifest = this.createDeploymentManifest(deploymentName, request);

      // Create the deployment
      await this.k8sAppsApi.createNamespacedDeployment({
        namespace: this.config.namespace,
        body: deploymentManifest
      });
      
      // Wait for deployment to be ready and get endpoint
      const endpoint = await this.waitForDeploymentReady(deploymentName);
      
      // Track the worker
      const workerInfo: WorkerInfo = {
        sessionKey: request.sessionKey,
        podName: deploymentName,
        status: WorkerStatus.busy,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        endpoint: endpoint
      };
      
      this.activeWorkers.set(request.sessionKey, workerInfo);
      this.startWorkerTimeout(request.sessionKey);
      
      logger.info(`Created persistent worker deployment: ${deploymentName} for session ${request.sessionKey}`);
      
      return deploymentName;

    } catch (error) {
      throw new KubernetesError(
        "createPersistentWorker",
        `Failed to create persistent worker for session ${request.sessionKey}`,
        error as Error
      );
    }
  }

  /**
   * Start worker timeout
   */
  private startWorkerTimeout(sessionKey: string): void {
    // Clear existing timeout if any
    this.clearWorkerTimeout(sessionKey);
    
    const timeoutMs = this.config.workerReusabilityConfig.timeoutMinutes * 60 * 1000;
    const timeout = setTimeout(() => {
      this.cleanupWorker(sessionKey);
    }, timeoutMs);
    
    this.workerTimeouts.set(sessionKey, timeout);
    logger.info(`Started ${this.config.workerReusabilityConfig.timeoutMinutes}min timeout for worker ${sessionKey}`);
  }

  /**
   * Reset worker timeout
   */
  private resetWorkerTimeout(sessionKey: string): void {
    this.clearWorkerTimeout(sessionKey);
    this.startWorkerTimeout(sessionKey);
    logger.info(`Reset timeout for worker ${sessionKey}`);
  }

  /**
   * Clear worker timeout
   */
  private clearWorkerTimeout(sessionKey: string): void {
    const timeout = this.workerTimeouts.get(sessionKey);
    if (timeout) {
      clearTimeout(timeout);
      this.workerTimeouts.delete(sessionKey);
    }
  }

  /**
   * Cleanup worker
   */
  private async cleanupWorker(sessionKey: string): Promise<void> {
    try {
      const worker = this.activeWorkers.get(sessionKey);
      if (worker) {
        // Delete the deployment
        await this.k8sAppsApi.deleteNamespacedDeployment({
          name: worker.podName,
          namespace: this.config.namespace
        });
        
        // Clear timeout
        this.clearWorkerTimeout(sessionKey);
        
        // Remove from tracking
        this.activeWorkers.delete(sessionKey);
        
        logger.info(`Cleaned up worker ${worker.podName} for session ${sessionKey}`);
      }
    } catch (error) {
      logger.error(`Error cleaning up worker for session ${sessionKey}:`, error);
    }
  }

  /**
   * Create a worker job for the user request
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

    // Check for available worker first (worker reuse)
    const availableWorker = this.findAvailableWorker(request.sessionKey);
    if (availableWorker) {
      logger.info(`Found available worker for session ${request.sessionKey}: ${availableWorker.podName}`);
      
      // Submit task to existing worker
      const taskRequest: TaskSubmissionRequest = {
        sessionKey: request.sessionKey,
        userId: request.userId,
        username: request.username,
        channelId: request.channelId,
        threadTs: request.threadTs,
        userPrompt: request.userPrompt,
        repositoryUrl: request.repositoryUrl,
        slackResponseChannel: request.slackResponseChannel,
        slackResponseTs: request.slackResponseTs,
        originalMessageTs: request.originalMessageTs,
        claudeOptions: request.claudeOptions,
        conversationHistory: request.conversationHistory
      };
      
      const submitted = await this.submitTaskToWorker(availableWorker, taskRequest);
      if (submitted) {
        return availableWorker.podName;
      } else {
        // If submission failed, cleanup the worker and create a new one
        await this.cleanupWorker(request.sessionKey);
      }
    }

    // Check if we're under the concurrent worker limit
    if (this.activeWorkers.size >= this.config.workerReusabilityConfig.maxConcurrentWorkers) {
      logger.info(`Maximum concurrent workers reached (${this.config.workerReusabilityConfig.maxConcurrentWorkers}), creating one-shot job`);
      // Fall back to creating a regular job
      return this.createRegularJob(request);
    }

    // Create new persistent worker
    return this.createPersistentWorker(request);
  }

  /**
   * Create a regular one-shot job (fallback)
   */
  private async createRegularJob(request: WorkerJobRequest): Promise<string> {
    const jobName = this.generateJobName(request.sessionKey);
    
    try {
      // Check if job already exists in memory
      const existingJobName = this.activeJobs.get(request.sessionKey);
      if (existingJobName) {
        logger.info(`Job already exists for session ${request.sessionKey}: ${existingJobName}`);
        return existingJobName;
      }

      // Check if a job already exists in Kubernetes for this session
      // This handles the case where the dispatcher was restarted
      const existingJob = await this.findExistingJobForSession(request.sessionKey);
      if (existingJob) {
        logger.info(`Found existing Kubernetes job for session ${request.sessionKey}: ${existingJob}`);
        // Track it in memory for this instance
        this.activeJobs.set(request.sessionKey, existingJob);
        return existingJob;
      }

      // Create job manifest
      const jobManifest = this.createJobManifest(jobName, request);

      // Create the job
      await this.k8sApi.createNamespacedJob({
        namespace: this.config.namespace,
        body: jobManifest
      });
      
      // Track the job
      this.activeJobs.set(request.sessionKey, jobName);
      
      logger.info(`Created Kubernetes job: ${jobName} for session ${request.sessionKey}`);
      
      // Start monitoring the job
      this.monitorJob(jobName, request.sessionKey);
      
      return jobName;

    } catch (error) {
      throw new KubernetesError(
        "createRegularJob",
        `Failed to create job for session ${request.sessionKey}`,
        error as Error
      );
    }
  }

  /**
   * Generate unique deployment name for persistent workers
   */
  private generateDeploymentName(sessionKey: string): string {
    // Use the session key directly for persistent workers
    // Replace dots with dashes for Kubernetes naming conventions
    const safeSessionKey = sessionKey.replace(/\./g, "-").toLowerCase();
    return `claude-worker-persistent-${safeSessionKey}`;
  }

  /**
   * Generate unique job name
   */
  private generateJobName(sessionKey: string): string {
    // Use the session key (which is now the thread timestamp) directly
    // Replace dots with dashes for Kubernetes naming conventions
    const safeSessionKey = sessionKey.replace(/\./g, "-").toLowerCase();
    
    // For Kubernetes job names, we need to ensure uniqueness even if the same thread is processed multiple times
    // Add a short timestamp suffix to handle multiple executions in the same thread
    const timestamp = Date.now().toString(36).slice(-4);
    
    return `claude-worker-${safeSessionKey}-${timestamp}`;
  }

  /**
   * Create Kubernetes Deployment manifest for persistent workers
   */
  private createDeploymentManifest(deploymentName: string, request: WorkerJobRequest): k8s.V1Deployment {
    const templateData: JobTemplateData = {
      jobName: deploymentName,
      namespace: this.config.namespace,
      workerImage: this.config.workerImage,
      cpu: this.config.cpu,
      memory: this.config.memory,
      timeoutSeconds: this.config.timeoutSeconds,
      sessionKey: request.sessionKey,
      userId: request.userId,
      username: request.username,
      channelId: request.channelId,
      threadTs: request.threadTs || "",
      repositoryUrl: request.repositoryUrl,
      userPrompt: Buffer.from(request.userPrompt).toString("base64"),
      slackResponseChannel: request.slackResponseChannel,
      slackResponseTs: request.slackResponseTs,
      originalMessageTs: request.originalMessageTs,
      claudeOptions: JSON.stringify(request.claudeOptions),
      conversationHistory: JSON.stringify(request.conversationHistory || []),
      slackToken: "",
      githubToken: "",
    };

    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deploymentName,
        namespace: this.config.namespace,
        labels: {
          app: "claude-worker-persistent",
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
            app: "claude-worker-persistent",
            "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
          },
        },
        template: {
          metadata: {
            labels: {
              app: "claude-worker-persistent",
              "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
              component: "worker",
            },
          },
          spec: {
            restartPolicy: "Always",
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
                imagePullPolicy: process.env.NODE_ENV === 'production' ? "Always" : "IfNotPresent",
                ports: [
                  {
                    containerPort: this.config.workerReusabilityConfig.httpPort,
                    name: "http",
                  },
                ],
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
                    value: templateData.sessionKey,
                  },
                  {
                    name: "USER_ID",
                    value: templateData.userId,
                  },
                  {
                    name: "USERNAME",
                    value: templateData.username,
                  },
                  {
                    name: "CHANNEL_ID",
                    value: templateData.channelId,
                  },
                  {
                    name: "THREAD_TS",
                    value: templateData.threadTs,
                  },
                  {
                    name: "REPOSITORY_URL",
                    value: templateData.repositoryUrl,
                  },
                  {
                    name: "WORKER_MODE",
                    value: "persistent",
                  },
                  {
                    name: "WORKER_TIMEOUT_MINUTES",
                    value: this.config.workerReusabilityConfig.timeoutMinutes.toString(),
                  },
                  {
                    name: "WORKER_HTTP_PORT",
                    value: this.config.workerReusabilityConfig.httpPort.toString(),
                  },
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
                ],
                volumeMounts: [
                  {
                    name: "workspace",
                    mountPath: "/workspace",
                  },
                ],
                livenessProbe: {
                  httpGet: {
                    path: "/health",
                    port: this.config.workerReusabilityConfig.httpPort,
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                },
                readinessProbe: {
                  httpGet: {
                    path: "/health",
                    port: this.config.workerReusabilityConfig.httpPort,
                  },
                  initialDelaySeconds: 10,
                  periodSeconds: 5,
                },
                workingDir: "/app/packages/worker",
                command: ["bun", "run", "dist/index.js"],
              },
            ],
            volumes: [
              {
                name: "workspace",
                emptyDir: {
                  sizeLimit: "10Gi",
                },
              },
            ],
            serviceAccountName: "peerbot",
          },
        },
      },
    };
  }

  /**
   * Wait for deployment to be ready and return endpoint
   */
  private async waitForDeploymentReady(deploymentName: string): Promise<string> {
    const maxAttempts = 30; // Wait up to 5 minutes
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        attempts++;
        
        // Check deployment status
        const deploymentResponse = await this.k8sAppsApi.readNamespacedDeployment({
          name: deploymentName,
          namespace: this.config.namespace
        });
        
        const deployment = deploymentResponse.body;
        const status = deployment.status;
        
        if (status?.readyReplicas && status.readyReplicas > 0) {
          // Get pod IP
          const podsResponse = await this.k8sCoreApi.listNamespacedPod({
            namespace: this.config.namespace,
            labelSelector: `app=claude-worker-persistent,session-key=${deploymentName.split('-').slice(-1)[0]}`
          });
          
          if (podsResponse.body.items && podsResponse.body.items.length > 0) {
            const pod = podsResponse.body.items[0];
            const podIP = pod.status?.podIP;
            
            if (podIP) {
              const endpoint = `http://${podIP}:${this.config.workerReusabilityConfig.httpPort}`;
              logger.info(`Deployment ${deploymentName} is ready with endpoint: ${endpoint}`);
              return endpoint;
            }
          }
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
        
      } catch (error) {
        logger.error(`Error waiting for deployment ${deploymentName}:`, error);
        throw error;
      }
    }
    
    throw new Error(`Deployment ${deploymentName} failed to become ready within timeout`);
  }

  /**
   * Create Kubernetes Job manifest
   */
  private createJobManifest(jobName: string, request: WorkerJobRequest): k8s.V1Job {
    const templateData: JobTemplateData = {
      jobName,
      namespace: this.config.namespace,
      workerImage: this.config.workerImage,
      cpu: this.config.cpu,
      memory: this.config.memory,
      timeoutSeconds: this.config.timeoutSeconds,
      sessionKey: request.sessionKey,
      userId: request.userId,
      username: request.username,
      channelId: request.channelId,
      threadTs: request.threadTs || "",
      repositoryUrl: request.repositoryUrl,
      userPrompt: Buffer.from(request.userPrompt).toString("base64"), // Base64 encode for safety
      slackResponseChannel: request.slackResponseChannel,
      slackResponseTs: request.slackResponseTs,
      originalMessageTs: request.originalMessageTs,
      claudeOptions: JSON.stringify(request.claudeOptions),
      conversationHistory: JSON.stringify(request.conversationHistory || []),
      // These will be injected from secrets/configmaps
      slackToken: "", 
      githubToken: "",
    };

    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
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
        activeDeadlineSeconds: this.config.timeoutSeconds,
        ttlSecondsAfterFinished: 300, // Clean up job 5 minutes after completion
        template: {
          metadata: {
            labels: {
              app: "claude-worker",
              "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
              component: "worker",
            },
          },
          spec: {
            restartPolicy: "Never",
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
                imagePullPolicy: process.env.NODE_ENV === 'production' ? "Always" : "IfNotPresent",
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
                    value: templateData.sessionKey,
                  },
                  {
                    name: "USER_ID",
                    value: templateData.userId,
                  },
                  {
                    name: "USERNAME",
                    value: templateData.username,
                  },
                  {
                    name: "CHANNEL_ID",
                    value: templateData.channelId,
                  },
                  {
                    name: "THREAD_TS",
                    value: templateData.threadTs,
                  },
                  {
                    name: "REPOSITORY_URL",
                    value: templateData.repositoryUrl,
                  },
                  {
                    name: "SLACK_RESPONSE_CHANNEL",
                    value: templateData.slackResponseChannel,
                  },
                  {
                    name: "SLACK_RESPONSE_TS",
                    value: templateData.slackResponseTs,
                  },
                  {
                    name: "ORIGINAL_MESSAGE_TS",
                    value: templateData.originalMessageTs || "",
                  },
                  {
                    name: "CLAUDE_OPTIONS",
                    value: templateData.claudeOptions,
                  },
                  {
                    name: "USER_PROMPT",
                    value: templateData.userPrompt,
                  },
                  {
                    name: "CONVERSATION_HISTORY",
                    value: templateData.conversationHistory,
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
                ],
                volumeMounts: [
                  {
                    name: "workspace",
                    mountPath: "/workspace",
                  },
                ],
                workingDir: "/app/packages/worker",
                command: ["bun", "run", "dist/index.js"],
              },
            ],
            volumes: [
              {
                name: "workspace",
                emptyDir: {
                  sizeLimit: "10Gi",
                },
              },
            ],
            serviceAccountName: "peerbot",
          },
        },
      },
    };
  }
  
  /**
   * Monitor job status
   */
  private async monitorJob(jobName: string, sessionKey: string): Promise<void> {
    const maxAttempts = 60; // Monitor for up to 10 minutes (10s intervals)
    let attempts = 0;

    const checkStatus = async () => {
      try {
        attempts++;
        
        const jobResponse = await this.k8sApi.readNamespacedJob({
          name: jobName,
          namespace: this.config.namespace
        });
        const job = jobResponse;
        
        const status = job.status;
        
        if (status?.succeeded) {
          logger.info(`Job ${jobName} completed successfully`);
          this.activeJobs.delete(sessionKey);
          return;
        }
        
        if (status?.failed) {
          logger.info(`Job ${jobName} failed`);
          this.activeJobs.delete(sessionKey);
          return;
        }
        
        // Check if job timed out
        if (attempts >= maxAttempts) {
          logger.info(`Job ${jobName} monitoring timed out`);
          this.activeJobs.delete(sessionKey);
          return;
        }
        
        // Continue monitoring
        setTimeout(checkStatus, 10000); // Check every 10 seconds
        
      } catch (error) {
        logger.error(`Error monitoring job ${jobName}:`, error);
        this.activeJobs.delete(sessionKey);
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
   * Cleanup all jobs and workers
   */
  async cleanup(): Promise<void> {
    logger.info(`Cleaning up ${this.activeJobs.size} active jobs and ${this.activeWorkers.size} active workers...`);
    
    // Cleanup regular jobs
    const jobPromises = Array.from(this.activeJobs.values()).map(jobName =>
      this.deleteJob(jobName).catch(error => 
        logger.error(`Failed to delete job ${jobName}:`, error)
      )
    );
    
    // Cleanup persistent workers
    const workerPromises = Array.from(this.activeWorkers.keys()).map(sessionKey =>
      this.cleanupWorker(sessionKey).catch(error => 
        logger.error(`Failed to cleanup worker for session ${sessionKey}:`, error)
      )
    );
    
    await Promise.allSettled([...jobPromises, ...workerPromises]);
    
    this.activeJobs.clear();
    this.activeWorkers.clear();
    
    // Clear all timeouts
    for (const timeout of this.workerTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.workerTimeouts.clear();
    
    logger.info("Job and worker cleanup completed");
  }
}