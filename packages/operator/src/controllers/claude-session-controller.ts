import * as k8s from "@kubernetes/client-node";
import { Operator } from "k8s-operator-node";
import { ClaudeSession, ClaudeSessionSpec, RateLimitEntry } from "../types/claude-session";
import winston from "winston";

interface ContainerTemplateData {
  containerName: string;
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

interface PodKey {
  userId: string;
  channelId: string;
}

export class ClaudeSessionController {
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
    k8sCoreApi: k8s.CoreV1Api,
    customObjectsApi: k8s.CustomObjectsApi,
    logger: winston.Logger,
    namespace: string = "peerbot",
    workerImage: string = "claude-worker:latest"
  ) {
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

      // Generate pod key for user/channel combination
      const podKey = this.generatePodKey(resource.spec.userId, resource.spec.channelId);
      
      // Check if pod already exists for this user/channel
      const existingPod = await this.findExistingPod(podKey);
      
      if (existingPod) {
        // Add container to existing pod for concurrent message
        const containerName = await this.addContainerToPod(existingPod, resource);
        await this.updateStatus(resource, "Running", `Added container ${containerName} to existing pod ${existingPod.metadata?.name}`, existingPod.metadata?.name, containerName);
      } else {
        // Create new pod for this user/channel
        const { pod, containerName } = await this.createPodWithContainer(podKey, resource);
        await this.updateStatus(resource, "Running", `Created pod ${pod.metadata?.name} with container ${containerName}`, pod.metadata?.name, containerName);
      }

    } catch (error) {
      this.logger.error(`Error reconciling ClaudeSession ${name}:`, error);
      await this.updateStatus(resource, "Failed", `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle cleanup when ClaudeSession is deleted
   */
  private async handleDeletion(resource: ClaudeSession): Promise<void> {
    const podName = resource.status?.podName;
    const containerName = resource.status?.containerName;
    
    if (podName && containerName) {
      try {
        // Remove container from pod, or delete pod if it's the last container
        await this.removeContainerFromPod(podName, containerName, resource.metadata?.namespace || this.namespace);
        this.logger.info(`Removed container ${containerName} from pod ${podName} for ClaudeSession ${resource.metadata?.name}`);
      } catch (error) {
        this.logger.warn(`Failed to remove container ${containerName} from pod ${podName}:`, error);
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
   * Generate pod key for user/channel combination
   */
  private generatePodKey(userId: string, channelId: string): PodKey {
    return { userId, channelId };
  }

  /**
   * Generate pod name from pod key
   */
  private generatePodName(podKey: PodKey): string {
    const safeUserId = podKey.userId.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const safeChannelId = podKey.channelId.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    return `claude-worker-${safeUserId}-${safeChannelId}`;
  }

  /**
   * Find existing pod for a user/channel combination
   */
  private async findExistingPod(podKey: PodKey): Promise<k8s.V1Pod | null> {
    try {
      const podName = this.generatePodName(podKey);
      
      const podResponse = await this.k8sCoreApi.readNamespacedPod({
        name: podName,
        namespace: this.namespace
      });
      
      // Check if pod is running or pending (not terminating)
      const pod = podResponse;
      if (pod.metadata?.deletionTimestamp) {
        return null; // Pod is being deleted
      }
      
      return pod;
    } catch (error) {
      if ((error as any).statusCode === 404) {
        return null; // Pod doesn't exist
      }
      this.logger.error(`Error finding existing pod for user ${podKey.userId} channel ${podKey.channelId}:`, error);
      return null;
    }
  }

  /**
   * Create a new pod with first container for the ClaudeSession
   */
  private async createPodWithContainer(podKey: PodKey, resource: ClaudeSession): Promise<{ pod: k8s.V1Pod, containerName: string }> {
    const podName = this.generatePodName(podKey);
    const containerName = this.generateContainerName(resource.spec.sessionKey);
    const namespace = resource.metadata?.namespace || this.namespace;
    const podManifest = this.createPodManifest(podName, containerName, resource.spec);

    const response = await this.k8sCoreApi.createNamespacedPod({
      namespace: namespace,
      body: podManifest
    });

    this.logger.info(`Created pod ${podName} with container ${containerName} for ClaudeSession ${resource.metadata?.name}`);
    return { pod: response, containerName };
  }

  /**
   * Generate unique container name
   */
  private generateContainerName(sessionKey: string): string {
    const safeSessionKey = sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const timestamp = Date.now().toString(36).slice(-4);
    return `worker-${safeSessionKey}-${timestamp}`;
  }

  /**
   * Create Kubernetes Pod manifest with single container
   */
  private createPodManifest(podName: string, containerName: string, spec: ClaudeSessionSpec): k8s.V1Pod {
    const templateData: ContainerTemplateData = {
      containerName,
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
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: this.namespace,
        labels: {
          app: "claude-worker",
          "user-id": spec.userId,
          "channel-id": spec.channelId,
          component: "worker",
        },
        annotations: {
          "claude.ai/user-id": spec.userId,
          "claude.ai/channel-id": spec.channelId,
          "claude.ai/username": spec.username,
          "claude.ai/created-at": new Date().toISOString(),
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
          this.createContainerSpec(containerName, templateData)
        ],
        volumes: [
          { name: "workspace", emptyDir: { sizeLimit: "10Gi" } }
        ],
        serviceAccountName: "claude-worker"
      }
    };
  }

  /**
   * Create container specification
   */
  private createContainerSpec(containerName: string, templateData: ContainerTemplateData): k8s.V1Container {
    return {
      name: containerName,
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
    };
  }

  /**
   * Add container to existing pod for concurrent message processing
   */
  private async addContainerToPod(pod: k8s.V1Pod, resource: ClaudeSession): Promise<string> {
    const containerName = this.generateContainerName(resource.spec.sessionKey);
    
    const templateData: ContainerTemplateData = {
      containerName,
      namespace: this.namespace,
      workerImage: this.workerImage,
      cpu: resource.spec.resources?.cpu || "500m",
      memory: resource.spec.resources?.memory || "1Gi", 
      timeoutSeconds: resource.spec.timeoutSeconds || 300,
      sessionKey: resource.spec.sessionKey,
      userId: resource.spec.userId,
      username: resource.spec.username,
      channelId: resource.spec.channelId,
      threadTs: resource.spec.threadTs || "",
      repositoryUrl: resource.spec.repositoryUrl,
      userPrompt: resource.spec.userPrompt,
      slackResponseChannel: resource.spec.slackResponseChannel,
      slackResponseTs: resource.spec.slackResponseTs,
      originalMessageTs: resource.spec.originalMessageTs || "",
      claudeOptions: resource.spec.claudeOptions,
      resumeSessionId: resource.spec.resumeSessionId || ""
    };

    // Create new container spec
    const newContainer = this.createContainerSpec(containerName, templateData);
    
    // Add container to pod spec
    const updatedPod = {
      ...pod,
      spec: {
        ...pod.spec!,
        containers: [...(pod.spec?.containers || []), newContainer]
      }
    };

    // Patch the pod with the new container
    await this.k8sCoreApi.patchNamespacedPod({
      name: pod.metadata!.name!,
      namespace: pod.metadata!.namespace || this.namespace,
      body: updatedPod,
      headers: { "Content-Type": "application/merge-patch+json" }
    });

    this.logger.info(`Added container ${containerName} to pod ${pod.metadata?.name} for ClaudeSession ${resource.metadata?.name}`);
    return containerName;
  }

  /**
   * Remove container from pod or delete pod if it's the last container
   */
  private async removeContainerFromPod(podName: string, containerName: string, namespace: string): Promise<void> {
    try {
      const podResponse = await this.k8sCoreApi.readNamespacedPod({
        name: podName,
        namespace: namespace
      });
      
      const pod = podResponse;
      const containers = pod.spec?.containers || [];
      
      if (containers.length <= 1) {
        // Delete the entire pod if this is the last container
        await this.k8sCoreApi.deleteNamespacedPod({
          name: podName,
          namespace: namespace,
          body: { gracePeriodSeconds: 30 }
        });
        this.logger.info(`Deleted pod ${podName} as it was the last container`);
      } else {
        // Remove just this container from the pod
        const updatedContainers = containers.filter(c => c.name !== containerName);
        const updatedPod = {
          ...pod,
          spec: {
            ...pod.spec!,
            containers: updatedContainers
          }
        };

        await this.k8sCoreApi.patchNamespacedPod({
          name: podName,
          namespace: namespace,
          body: updatedPod,
          headers: { "Content-Type": "application/merge-patch+json" }
        });
        
        this.logger.info(`Removed container ${containerName} from pod ${podName}`);
      }
    } catch (error) {
      this.logger.error(`Error removing container ${containerName} from pod ${podName}:`, error);
      throw error;
    }
  }

  /**
   * Update ClaudeSession status
   */
  private async updateStatus(
    resource: ClaudeSession,
    phase: string,
    message: string,
    podName?: string,
    containerName?: string
  ): Promise<void> {
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace || this.namespace;

    if (!name) return;

    try {
      const status = {
        phase,
        message,
        ...(podName && { podName }),
        ...(containerName && { containerName }),
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