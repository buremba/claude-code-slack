import * as k8s from "@kubernetes/client-node";
import { Operator } from "k8s-operator-node";
import { ClaudeSession, ClaudeSessionSpec, RateLimitEntry } from "../types/claude-session";
import winston from "winston";

interface JobTemplateData {
  jobName: string;
  namespace: string;
  workerImage: string;
  cpu: string;
  memory: string;
  timeoutSeconds: number;
  sessionKey: string;
  userId: string;
  username: string;
  channelId: string;
  threadTs: string;
  repositoryUrl: string;
  userPrompt: string;
  slackResponseChannel: string;
  slackResponseTs: string;
  originalMessageTs: string;
  claudeOptions: string;
  resumeSessionId: string;
}

export class ClaudeSessionController {
  private k8sApi: k8s.BatchV1Api;
  private k8sCoreApi: k8s.CoreV1Api;
  private customObjectsApi: k8s.CustomObjectsApi;
  private logger: winston.Logger;
  private namespace: string;
  private workerImage: string;
  private rateLimitMap = new Map<string, RateLimitEntry>();

  // Rate limiting configuration
  private readonly RATE_LIMIT_MAX_JOBS = process.env.DISABLE_RATE_LIMIT === 'true' ? 999 : 5;
  private readonly RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  constructor(
    k8sApi: k8s.BatchV1Api,
    k8sCoreApi: k8s.CoreV1Api,
    customObjectsApi: k8s.CustomObjectsApi,
    logger: winston.Logger,
    namespace: string = "peerbot",
    workerImage: string = "claude-worker:latest"
  ) {
    this.k8sApi = k8sApi;
    this.k8sCoreApi = k8sCoreApi;
    this.customObjectsApi = customObjectsApi;
    this.logger = logger;
    this.namespace = namespace;
    this.workerImage = workerImage;

    this.startRateLimitCleanup();
  }

  /**
   * Main reconciliation logic for ClaudeSession resources
   */
  async reconcile(resource: ClaudeSession): Promise<void> {
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace || this.namespace;

    this.logger.info(`Reconciling ClaudeSession ${name} in namespace ${namespace}`);

    try {
      // Check if resource is being deleted
      if (resource.metadata?.deletionTimestamp) {
        await this.handleDeletion(resource);
        return;
      }

      // Check rate limits
      if (!this.checkRateLimit(resource.spec.userId)) {
        await this.updateStatus(resource, "Failed", "Rate limit exceeded");
        return;
      }

      // Check if job already exists
      const existingJob = await this.findExistingJob(resource);
      if (existingJob) {
        await this.syncJobStatus(resource, existingJob);
        return;
      }

      // Create new job
      const job = await this.createJob(resource);
      await this.updateStatus(resource, "Running", `Created job ${job.metadata?.name}`, job.metadata?.name);

    } catch (error) {
      this.logger.error(`Error reconciling ClaudeSession ${name}:`, error);
      await this.updateStatus(resource, "Failed", `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle cleanup when ClaudeSession is deleted
   */
  private async handleDeletion(resource: ClaudeSession): Promise<void> {
    const jobName = resource.status?.jobName;
    if (jobName) {
      try {
        await this.k8sApi.deleteNamespacedJob({
          name: jobName,
          namespace: resource.metadata?.namespace || this.namespace,
          body: { propagationPolicy: "Background" }
        });
        this.logger.info(`Deleted job ${jobName} for ClaudeSession ${resource.metadata?.name}`);
      } catch (error) {
        this.logger.warn(`Failed to delete job ${jobName}:`, error);
      }
    }
  }

  /**
   * Check if user is within rate limits
   */
  private checkRateLimit(userId: string): boolean {
    const effectiveUserId = userId || "anonymous";
    const now = Date.now();
    const entry = this.rateLimitMap.get(effectiveUserId);

    if (!entry) {
      this.rateLimitMap.set(effectiveUserId, { count: 1, windowStart: now });
      return true;
    }

    // Check if we're in a new window
    if (now - entry.windowStart >= this.RATE_LIMIT_WINDOW_MS) {
      entry.count = 1;
      entry.windowStart = now;
      return true;
    }

    // Check if under limit
    if (entry.count < this.RATE_LIMIT_MAX_JOBS) {
      entry.count++;
      return true;
    }

    this.logger.warn(`Rate limit exceeded for user ${effectiveUserId}: ${entry.count} jobs in current window`);
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
   * Find existing job for a ClaudeSession
   */
  private async findExistingJob(resource: ClaudeSession): Promise<k8s.V1Job | null> {
    try {
      const namespace = resource.metadata?.namespace || this.namespace;
      const sessionKey = resource.spec.sessionKey;
      
      // Create a safe label value from the session key
      const labelValue = sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      
      const jobsResponse = await this.k8sApi.listNamespacedJob({
        namespace: namespace,
        labelSelector: `session-key=${labelValue}`
      });

      // Find active jobs (not completed or failed)
      for (const job of jobsResponse.items) {
        const status = job.status;
        if (!status?.succeeded && !status?.failed) {
          // Verify exact session match via annotation
          const annotations = job.metadata?.annotations || {};
          if (annotations["claude.ai/session-key"] === sessionKey) {
            return job;
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Error finding existing job for session ${resource.spec.sessionKey}:`, error);
      return null;
    }
  }

  /**
   * Create a Kubernetes job for the ClaudeSession
   */
  private async createJob(resource: ClaudeSession): Promise<k8s.V1Job> {
    const jobName = this.generateJobName(resource.spec.sessionKey);
    const namespace = resource.metadata?.namespace || this.namespace;
    const jobManifest = this.createJobManifest(jobName, resource.spec);

    const response = await this.k8sApi.createNamespacedJob({
      namespace: namespace,
      body: jobManifest
    });

    this.logger.info(`Created job ${jobName} for ClaudeSession ${resource.metadata?.name}`);
    return response;
  }

  /**
   * Generate unique job name
   */
  private generateJobName(sessionKey: string): string {
    const safeSessionKey = sessionKey.replace(/\./g, "-").toLowerCase();
    const timestamp = Date.now().toString(36).slice(-4);
    return `claude-worker-${safeSessionKey}-${timestamp}`;
  }

  /**
   * Create Kubernetes Job manifest (migrated from existing logic)
   */
  private createJobManifest(jobName: string, spec: ClaudeSessionSpec): k8s.V1Job {
    const templateData: JobTemplateData = {
      jobName,
      namespace: this.namespace,
      workerImage: this.workerImage,
      cpu: spec.resources?.cpu || "500m",
      memory: spec.resources?.memory || "1Gi", 
      timeoutSeconds: spec.timeoutSeconds || 300,
      sessionKey: spec.sessionKey,
      userId: spec.userId,
      username: spec.username,
      channelId: spec.channelId,
      threadTs: spec.threadTs || "",
      repositoryUrl: spec.repositoryUrl,
      userPrompt: spec.userPrompt, // Already base64 encoded
      slackResponseChannel: spec.slackResponseChannel,
      slackResponseTs: spec.slackResponseTs,
      originalMessageTs: spec.originalMessageTs || "",
      claudeOptions: spec.claudeOptions,
      resumeSessionId: spec.resumeSessionId || ""
    };

    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          app: "claude-worker",
          "session-key": spec.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
          "user-id": spec.userId,
          component: "worker",
        },
        annotations: {
          "claude.ai/session-key": spec.sessionKey,
          "claude.ai/user-id": spec.userId,
          "claude.ai/username": spec.username,
          "claude.ai/created-at": new Date().toISOString(),
        },
      },
      spec: {
        activeDeadlineSeconds: templateData.timeoutSeconds,
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: {
            labels: {
              app: "claude-worker",
              "session-key": spec.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
              component: "worker",
            },
          },
          spec: {
            restartPolicy: "Never",
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
                image: this.workerImage,
                imagePullPolicy: "Always",
                resources: {
                  requests: {
                    cpu: templateData.cpu,
                    memory: templateData.memory,
                  },
                  limits: {
                    cpu: templateData.cpu,
                    memory: templateData.memory,
                  },
                },
                env: [
                  { name: "SESSION_KEY", value: templateData.sessionKey },
                  { name: "USER_ID", value: templateData.userId },
                  { name: "USERNAME", value: templateData.username },
                  { name: "CHANNEL_ID", value: templateData.channelId },
                  { name: "THREAD_TS", value: templateData.threadTs },
                  { name: "REPOSITORY_URL", value: templateData.repositoryUrl },
                  { name: "USER_PROMPT", value: templateData.userPrompt },
                  { name: "SLACK_RESPONSE_CHANNEL", value: templateData.slackResponseChannel },
                  { name: "SLACK_RESPONSE_TS", value: templateData.slackResponseTs },
                  { name: "ORIGINAL_MESSAGE_TS", value: templateData.originalMessageTs },
                  { name: "CLAUDE_OPTIONS", value: templateData.claudeOptions },
                  { name: "RESUME_SESSION_ID", value: templateData.resumeSessionId },
                  {
                    name: "SLACK_BOT_TOKEN",
                    valueFrom: {
                      secretKeyRef: { name: "peerbot-secrets", key: "slack-bot-token" }
                    }
                  },
                  {
                    name: "GITHUB_TOKEN", 
                    valueFrom: {
                      secretKeyRef: { name: "peerbot-secrets", key: "github-token" }
                    }
                  },
                  {
                    name: "CLAUDE_CODE_OAUTH_TOKEN",
                    valueFrom: {
                      secretKeyRef: { name: "peerbot-secrets", key: "claude-code-oauth-token" }
                    }
                  },
                  { name: "CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS", value: "1" }
                ],
                volumeMounts: [
                  { name: "workspace", mountPath: "/workspace" }
                ],
                workingDir: "/app/packages/worker",
                command: ["bun", "run", "dist/index.js"]
              }
            ],
            volumes: [
              { name: "workspace", emptyDir: { sizeLimit: "10Gi" } }
            ],
            serviceAccountName: "claude-worker"
          }
        }
      }
    };
  }

  /**
   * Sync job status with ClaudeSession status
   */
  private async syncJobStatus(resource: ClaudeSession, job: k8s.V1Job): Promise<void> {
    const status = job.status;
    let phase: string;
    let message: string;

    if (status?.succeeded) {
      phase = "Succeeded";
      message = "Job completed successfully";
    } else if (status?.failed) {
      phase = "Failed"; 
      message = "Job failed";
    } else if (status?.active) {
      phase = "Running";
      message = "Job is running";
    } else {
      phase = "Pending";
      message = "Job is pending";
    }

    await this.updateStatus(resource, phase, message, job.metadata?.name);
  }

  /**
   * Update ClaudeSession status
   */
  private async updateStatus(
    resource: ClaudeSession,
    phase: string,
    message: string,
    jobName?: string
  ): Promise<void> {
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace || this.namespace;

    if (!name) return;

    try {
      const status = {
        phase,
        message,
        ...(jobName && { jobName }),
        ...(phase === "Running" && !resource.status?.startTime && { startTime: new Date().toISOString() }),
        ...(["Succeeded", "Failed", "Terminated"].includes(phase) && { completionTime: new Date().toISOString() })
      };

      await this.customObjectsApi.patchNamespacedCustomObjectStatus(
        "claude.ai",
        "v1", 
        namespace,
        "claudesessions",
        name,
        { status },
        undefined,
        undefined,
        undefined,
        { headers: { "Content-Type": "application/merge-patch+json" } }
      );

      this.logger.info(`Updated ClaudeSession ${name} status to ${phase}: ${message}`);
    } catch (error) {
      this.logger.error(`Failed to update status for ClaudeSession ${name}:`, error);
    }
  }
}