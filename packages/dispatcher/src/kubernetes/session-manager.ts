import * as k8s from "@kubernetes/client-node";
import logger from "../logger";
import type { 
  KubernetesConfig,
  WorkerJobRequest,
  JobManager
} from "../types";
import { KubernetesError } from "../types";

interface ClaudeSessionSpec {
  sessionKey: string;
  userId: string;
  username: string;
  channelId: string;
  threadTs?: string;
  repositoryUrl: string;
  userPrompt: string; // base64 encoded
  slackResponseChannel: string;
  slackResponseTs: string;
  originalMessageTs?: string;
  claudeOptions: string; // JSON string
  resumeSessionId?: string;
  resources?: {
    cpu?: string;
    memory?: string;
  };
  timeoutSeconds?: number;
}

interface ClaudeSession {
  apiVersion: "claude.ai/v1";
  kind: "ClaudeSession";
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
  };
  spec: ClaudeSessionSpec;
  status?: {
    phase?: "Pending" | "Running" | "Succeeded" | "Failed" | "Terminated";
    jobName?: string;
    startTime?: string;
    completionTime?: string;
    message?: string;
  };
}

export class ClaudeSessionManager implements JobManager {
  private customObjectsApi: k8s.CustomObjectsApi;
  private k8sCoreApi: k8s.CoreV1Api;
  private k8sApi: k8s.BatchV1Api;
  private activeSessions = new Map<string, string>(); // sessionKey -> session name
  private config: KubernetesConfig;

  constructor(config: KubernetesConfig) {
    this.config = config;

    // Initialize Kubernetes client
    const kc = new k8s.KubeConfig();
    
    if (config.kubeconfig) {
      kc.loadFromFile(config.kubeconfig);
      logger.info(`✅ Loaded Kubernetes configuration from ${config.kubeconfig}`);
    } else {
      const inCluster = process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT;
      
      if (inCluster) {
        try {
          kc.loadFromCluster();
          logger.info("✅ Successfully loaded in-cluster Kubernetes configuration");
        } catch (error) {
          logger.error("❌ Failed to load in-cluster config:", error);
          throw new Error("Failed to load in-cluster Kubernetes configuration");
        }
      } else {
        try {
          kc.loadFromDefault();
          logger.info("✅ Loaded Kubernetes configuration from default kubeconfig");
        } catch (error) {
          logger.error("❌ Failed to load default kubeconfig:", error);
          throw new Error("Failed to load Kubernetes configuration");
        }
      }
    }

    this.customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.k8sApi = kc.makeApiClient(k8s.BatchV1Api);
    
    // Restore active sessions on startup
    this.restoreActiveSessions().catch(error => {
      logger.error("Failed to restore active sessions on startup:", error);
    });
  }

  /**
   * Create a ClaudeSession resource (replaces createWorkerJob)
   */
  async createWorkerJob(request: WorkerJobRequest): Promise<string> {
    const sessionName = this.generateSessionName(request.sessionKey);
    
    try {
      // Check if session already exists in memory
      const existingSessionName = this.activeSessions.get(request.sessionKey);
      if (existingSessionName) {
        logger.info(`Session already exists for session key ${request.sessionKey}: ${existingSessionName}`);
        return existingSessionName;
      }

      // Check if a session already exists in Kubernetes for this session key
      const existingSession = await this.findExistingSession(request.sessionKey);
      if (existingSession) {
        logger.info(`Found existing Kubernetes session for session key ${request.sessionKey}: ${existingSession.metadata.name}`);
        this.activeSessions.set(request.sessionKey, existingSession.metadata.name);
        return existingSession.metadata.name;
      }

      // Create ClaudeSession manifest
      const sessionManifest = this.createSessionManifest(sessionName, request);

      // Create the session resource
      await this.customObjectsApi.createNamespacedCustomObject(
        "claude.ai",
        "v1",
        this.config.namespace,
        "claudesessions",
        sessionManifest
      );
      
      // Track the session
      this.activeSessions.set(request.sessionKey, sessionName);
      
      logger.info(`Created ClaudeSession: ${sessionName} for session ${request.sessionKey}`);
      
      // Start monitoring the session
      this.monitorSession(sessionName, request.sessionKey);
      
      return sessionName;

    } catch (error) {
      throw new KubernetesError(
        "createWorkerJob",
        `Failed to create ClaudeSession for session ${request.sessionKey}`,
        error as Error
      );
    }
  }

  /**
   * Restore active sessions from Kubernetes on startup
   */
  private async restoreActiveSessions(): Promise<void> {
    try {
      logger.info("Restoring active sessions from Kubernetes...");
      
      // List all ClaudeSession resources
      const response = await this.customObjectsApi.listNamespacedCustomObject(
        "claude.ai",
        "v1",
        this.config.namespace,
        "claudesessions"
      );
      
      const sessions = (response.body as any).items as ClaudeSession[];
      let activeCount = 0;

      for (const session of sessions) {
        const sessionName = session.metadata.name;
        const sessionKey = session.spec.sessionKey;
        const phase = session.status?.phase;
        
        // Track sessions that are still active (not completed or failed)
        if (phase && !["Succeeded", "Failed", "Terminated"].includes(phase)) {
          this.activeSessions.set(sessionKey, sessionName);
          activeCount++;
          logger.info(`Restored active session ${sessionName} for session key ${sessionKey}`);
        }
      }
      
      logger.info(`✅ Restored ${activeCount} active sessions from Kubernetes on startup`);
    } catch (error) {
      logger.error("Error restoring active sessions:", error);
    }
  }

  /**
   * Find an existing ClaudeSession for a session key
   */
  private async findExistingSession(sessionKey: string): Promise<ClaudeSession | null> {
    try {
      // Create a safe label value from the session key
      const labelValue = sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      
      // List sessions with the session-key label
      const response = await this.customObjectsApi.listNamespacedCustomObject(
        "claude.ai",
        "v1",
        this.config.namespace,
        "claudesessions",
        undefined,
        undefined,
        undefined,
        undefined,
        `session-key=${labelValue}`
      );
      
      const sessions = (response.body as any).items as ClaudeSession[];
      
      // Find active sessions (not completed or failed)
      for (const session of sessions) {
        const phase = session.status?.phase;
        
        if (!phase || !["Succeeded", "Failed", "Terminated"].includes(phase)) {
          // Verify it's the exact session via spec
          if (session.spec.sessionKey === sessionKey) {
            logger.info(`Found existing active session ${session.metadata.name} for session key ${sessionKey}`);
            return session;
          }
        }
      }
      
      return null;
    } catch (error) {
      logger.error(`Error checking for existing session for session key ${sessionKey}:`, error);
      return null;
    }
  }

  /**
   * Generate unique session name
   */
  private generateSessionName(sessionKey: string): string {
    const safeSessionKey = sessionKey.replace(/\./g, "-").toLowerCase();
    const timestamp = Date.now().toString(36).slice(-4);
    return `claude-session-${safeSessionKey}-${timestamp}`;
  }

  /**
   * Create ClaudeSession manifest
   */
  private createSessionManifest(sessionName: string, request: WorkerJobRequest): ClaudeSession {
    return {
      apiVersion: "claude.ai/v1",
      kind: "ClaudeSession",
      metadata: {
        name: sessionName,
        namespace: this.config.namespace,
        labels: {
          app: "claude-operator",
          "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
          "user-id": request.userId,
          component: "session",
        }
      },
      spec: {
        sessionKey: request.sessionKey,
        userId: request.userId,
        username: request.username,
        channelId: request.channelId,
        threadTs: request.threadTs,
        repositoryUrl: request.repositoryUrl,
        userPrompt: Buffer.from(request.userPrompt).toString("base64"),
        slackResponseChannel: request.slackResponseChannel,
        slackResponseTs: request.slackResponseTs,
        originalMessageTs: request.originalMessageTs,
        claudeOptions: JSON.stringify(request.claudeOptions),
        resumeSessionId: request.resumeSessionId,
        resources: {
          cpu: this.config.cpu,
          memory: this.config.memory
        },
        timeoutSeconds: this.config.timeoutSeconds
      }
    };
  }

  /**
   * Monitor session status (compatible interface with job monitoring)
   */
  private async monitorSession(sessionName: string, sessionKey: string): Promise<void> {
    const maxAttempts = 60; // Monitor for up to 10 minutes
    let attempts = 0;

    const checkStatus = async () => {
      try {
        attempts++;
        
        const response = await this.customObjectsApi.getNamespacedCustomObject(
          "claude.ai",
          "v1",
          this.config.namespace,
          "claudesessions",
          sessionName
        );
        
        const session = response.body as ClaudeSession;
        const phase = session.status?.phase;
        
        if (phase === "Succeeded") {
          logger.info(`Session ${sessionName} completed successfully`);
          this.activeSessions.delete(sessionKey);
          return;
        }
        
        if (["Failed", "Terminated"].includes(phase || "")) {
          logger.info(`Session ${sessionName} failed or was terminated`);
          this.activeSessions.delete(sessionKey);
          return;
        }
        
        // Check if monitoring timed out
        if (attempts >= maxAttempts) {
          logger.info(`Session ${sessionName} monitoring timed out`);
          this.activeSessions.delete(sessionKey);
          return;
        }
        
        // Continue monitoring
        setTimeout(checkStatus, 10000); // Check every 10 seconds
        
      } catch (error) {
        logger.error(`Error monitoring session ${sessionName}:`, error);
        this.activeSessions.delete(sessionKey);
      }
    };

    // Start monitoring
    setTimeout(checkStatus, 5000); // Initial delay of 5 seconds
  }

  /**
   * Get session status (compatible interface)
   */
  async getJobStatus(sessionName: string): Promise<string> {
    try {
      const response = await this.customObjectsApi.getNamespacedCustomObject(
        "claude.ai",
        "v1",
        this.config.namespace,
        "claudesessions",
        sessionName
      );
      
      const session = response.body as ClaudeSession;
      const phase = session.status?.phase;
      
      switch (phase) {
        case "Succeeded": return "succeeded";
        case "Failed": return "failed";
        case "Running": return "running";
        case "Terminated": return "failed";
        default: return "pending";
      }
    } catch (error) {
      return "unknown";
    }
  }

  /**
   * Get session name for a session key (compatible interface)
   */
  async getJobForSession(sessionKey: string): Promise<string | null> {
    return this.activeSessions.get(sessionKey) || null;
  }

  /**
   * Get logs from worker pod (delegates to job via session status)
   */
  async getJobLogs(sessionName: string): Promise<string | null> {
    try {
      // Get the session to find the job name
      const response = await this.customObjectsApi.getNamespacedCustomObject(
        "claude.ai",
        "v1",
        this.config.namespace,
        "claudesessions",
        sessionName
      );
      
      const session = response.body as ClaudeSession;
      const jobName = session.status?.jobName;
      
      if (!jobName) {
        return null;
      }

      // Find pods for this job
      const podsResponse = await this.k8sCoreApi.listNamespacedPod({
        namespace: this.config.namespace,
        labelSelector: `job-name=${jobName}`
      });
      
      if (!podsResponse.items || podsResponse.items.length === 0) {
        return null;
      }
      
      const pod = podsResponse.items[0];
      const podName = pod?.metadata?.name;
      
      if (!podName) {
        return null;
      }
      
      // Get logs from the pod
      const logsResponse = await this.k8sCoreApi.readNamespacedPodLog({
        name: podName,
        namespace: this.config.namespace,
        container: "claude-worker",
        tailLines: 10000
      });
      
      return logsResponse;
    } catch (error) {
      logger.error(`Failed to get logs for session ${sessionName}:`, error);
      return null;
    }
  }

  /**
   * Delete a session (compatible interface)
   */
  async deleteJob(sessionName: string): Promise<void> {
    try {
      await this.customObjectsApi.deleteNamespacedCustomObject(
        "claude.ai",
        "v1",
        this.config.namespace,
        "claudesessions",
        sessionName
      );
      
      logger.info(`Deleted session: ${sessionName}`);
    } catch (error) {
      logger.error(`Failed to delete session ${sessionName}:`, error);
    }
  }

  /**
   * Extract session from logs (compatible interface)
   */
  extractSessionFromLogs(logs: string): any | null {
    try {
      // Look for session data markers in logs (same as original)
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
   * List active sessions (compatible interface)
   */
  async listActiveJobs(): Promise<Array<{ name: string; sessionKey: string; status: string }>> {
    const sessions = [];
    
    for (const [sessionKey, sessionName] of this.activeSessions.entries()) {
      const status = await this.getJobStatus(sessionName);
      sessions.push({ name: sessionName, sessionKey, status });
    }
    
    return sessions;
  }

  /**
   * Get active session count (compatible interface)
   */
  getActiveJobCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Cleanup all sessions (compatible interface)
   */
  async cleanup(): Promise<void> {
    logger.info(`Cleaning up ${this.activeSessions.size} active sessions...`);
    
    const promises = Array.from(this.activeSessions.values()).map(sessionName =>
      this.deleteJob(sessionName).catch(error => 
        logger.error(`Failed to delete session ${sessionName}:`, error)
      )
    );
    
    await Promise.allSettled(promises);
    this.activeSessions.clear();
    
    logger.info("Session cleanup completed");
  }
}