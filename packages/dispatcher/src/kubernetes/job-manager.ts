#!/usr/bin/env bun

import * as k8s from "@kubernetes/client-node";
import logger from "../logger";
import type { 
  KubernetesConfig,
  WorkerJobRequest,
  JobTemplateData
} from "../types";
import { KubernetesError } from "../types";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class KubernetesJobManager {
  private k8sApi: k8s.BatchV1Api;
  private k8sCoreApi: k8s.CoreV1Api;
  private activeJobs = new Map<string, string>(); // sessionKey -> jobName
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

      // Create user-specific PostgreSQL credentials if DATABASE_URL is configured
      await this.ensureUserCredentials(request.userId, request.channelId);

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
        "createWorkerJob",
        `Failed to create job for session ${request.sessionKey}`,
        error as Error
      );
    }
  }

  /**
   * Ensure user-specific PostgreSQL credentials exist
   */
  private async ensureUserCredentials(userId: string, channelId: string): Promise<void> {
    // Only create user credentials if DATABASE_URL is configured
    if (!process.env.DATABASE_URL) {
      return;
    }

    const secretName = this.getUserSecretName(userId, channelId);
    
    try {
      // Check if secret already exists
      await this.k8sCoreApi.readNamespacedSecret({
        name: secretName,
        namespace: this.config.namespace
      });
      logger.info(`User secret already exists: ${secretName}`);
      return;
    } catch (error) {
      // Secret doesn't exist, create it
      if ((error as any).response?.statusCode !== 404) {
        throw error;
      }
    }

    // Generate credentials
    const username = this.generateDbUsername(userId, channelId);
    const password = this.generateSecurePassword();
    
    // Determine if this is a DM or channel for metadata
    const isDM = channelId.startsWith('D');
    
    // Create user-specific secret
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: secretName,
        namespace: this.config.namespace,
        labels: {
          app: "peerbot",
          component: "postgresql-user",
          "conversation-type": isDM ? "direct-message" : "channel",
          ...(isDM ? { "user-id": userId } : { "channel-id": channelId }),
        },
        annotations: {
          "peerbot.ai/conversation-type": isDM ? "direct-message" : "channel",
          "peerbot.ai/user-id": userId,
          "peerbot.ai/channel-id": channelId,
          "peerbot.ai/db-username": username,
          "peerbot.ai/created-at": new Date().toISOString(),
        },
      },
      type: "Opaque",
      data: {
        username: Buffer.from(username).toString("base64"),
        password: Buffer.from(password).toString("base64"),
        "database-url": Buffer.from(this.buildUserDatabaseUrl(username, password)).toString("base64"),
      },
    };

    await this.k8sCoreApi.createNamespacedSecret({
      namespace: this.config.namespace,
      body: secret
    });

    logger.info(`Created user secret: ${secretName} for user ${username}`);

    // Create PostgreSQL user via Job
    await this.createPostgreSQLUser(username, password);
  }

  /**
   * Generate database username based on conversation context
   * - For channel conversations: channel_{channelId}
   * - For direct messages: user_{userId}
   */
  private generateDbUsername(userId: string, channelId: string): string {
    // Determine if this is a DM or channel based on channelId format
    // Slack DM channels start with 'D' and group channels start with 'C'
    const isDM = channelId.startsWith('D');
    
    if (isDM) {
      // For DMs, use user-based naming
      const sanitizedUserId = userId.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      return `user_${sanitizedUserId}`.substring(0, 63);
    } else {
      // For channels, use channel-based naming
      const sanitizedChannelId = channelId.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      return `channel_${sanitizedChannelId}`.substring(0, 63);
    }
  }

  /**
   * Generate secure password
   */
  private generateSecurePassword(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Get secret name for user credentials based on conversation context
   * - For channel conversations: peerbot-postgresql-channel-{channelId}
   * - For direct messages: peerbot-postgresql-user-{userId}
   */
  private getUserSecretName(userId: string, channelId: string): string {
    // Determine if this is a DM or channel based on channelId format
    const isDM = channelId.startsWith('D');
    
    if (isDM) {
      // For DMs, use user-based naming
      const sanitized = userId.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      return `peerbot-postgresql-user-${sanitized}`.substring(0, 253);
    } else {
      // For channels, use channel-based naming
      const sanitized = channelId.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      return `peerbot-postgresql-channel-${sanitized}`.substring(0, 253);
    }
  }

  /**
   * Build database URL for specific user
   */
  private buildUserDatabaseUrl(username: string, password: string): string {
    // Parse the admin DATABASE_URL to get connection details
    const adminDbUrl = process.env.DATABASE_URL!;
    const url = new URL(adminDbUrl);
    return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${url.host}${url.pathname}`;
  }

  /**
   * Create PostgreSQL user via Kubernetes Job
   */
  private async createPostgreSQLUser(username: string, password: string): Promise<void> {
    const jobName = `create-pg-user-${username.replace(/[^a-z0-9]/g, '-')}-${Date.now().toString(36)}`;
    
    const job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace: this.config.namespace,
        labels: {
          app: "peerbot",
          component: "postgresql-user-manager",
        },
      },
      spec: {
        activeDeadlineSeconds: 300, // 5 minute timeout
        ttlSecondsAfterFinished: 600, // Clean up after 10 minutes
        template: {
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "create-user",
                image: "postgres:15-alpine",
                command: ["/scripts/create-user.sh"],
                env: [
                  {
                    name: "POSTGRES_HOST",
                    value: `${this.config.namespace.startsWith('peerbot') ? this.config.namespace : 'peerbot'}-postgresql`,
                  },
                  {
                    name: "POSTGRES_PORT",
                    value: "5432",
                  },
                  {
                    name: "POSTGRES_DB",
                    value: "conversations",
                  },
                  {
                    name: "POSTGRES_ADMIN_USER",
                    value: "peerbot",
                  },
                  {
                    name: "POSTGRES_ADMIN_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: `${this.config.namespace.startsWith('peerbot') ? this.config.namespace : 'peerbot'}-postgresql-auth`,
                        key: "postgres-password",
                      },
                    },
                  },
                  {
                    name: "NEW_USERNAME",
                    value: username,
                  },
                  {
                    name: "NEW_PASSWORD",
                    value: password,
                  },
                ],
                volumeMounts: [
                  {
                    name: "user-manager-scripts",
                    mountPath: "/scripts",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "user-manager-scripts",
                configMap: {
                  name: `${this.config.namespace.startsWith('peerbot') ? this.config.namespace : 'peerbot'}-postgresql-user-manager`,
                  defaultMode: 0o755,
                },
              },
            ],
          },
        },
      },
    };

    await this.k8sApi.createNamespacedJob({
      namespace: this.config.namespace,
      body: job
    });

    logger.info(`Created PostgreSQL user creation job: ${jobName}`);
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
      resumeSessionId: request.resumeSessionId,
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
                imagePullPolicy: "Always",
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
                    name: "USER_PROMPT",
                    value: templateData.userPrompt,
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
                    name: "RESUME_SESSION_ID",
                    value: templateData.resumeSessionId || "",
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
                  // Optional PostgreSQL database URL for conversation persistence
                  ...(process.env.DATABASE_URL ? [{
                    name: "DATABASE_URL",
                    valueFrom: {
                      secretKeyRef: {
                        name: this.getUserSecretName(templateData.userId, templateData.channelId),
                        key: "database-url",
                        optional: true,
                      },
                    },
                  }] : []),
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
            serviceAccountName: "claude-worker",
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