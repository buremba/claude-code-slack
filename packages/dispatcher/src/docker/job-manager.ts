#!/usr/bin/env bun

import Docker from "dockerode";
import type { AgentManager } from "../infrastructure/agent-manager";
import type { DockerConfig, WorkerJobRequest } from "../types";
import type { SlackTokenManager } from "../slack/token-manager";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface ContainerInfo {
  containerId: string;
  sessionKey: string;
  status: string;
  createdAt: number;
}

export class DockerJobManager implements AgentManager {
  private docker: Docker;
  private activeContainers = new Map<string, ContainerInfo>(); // sessionKey -> container info
  private rateLimitMap = new Map<string, RateLimitEntry>(); // userId -> rate limit data
  private config: DockerConfig;
  private tokenManager?: SlackTokenManager;
  private rateLimitCleanupInterval?: NodeJS.Timeout;
  
  // Rate limiting configuration - same as Kubernetes implementation
  private readonly RATE_LIMIT_MAX_JOBS = 5; // Max jobs per user per window
  private readonly RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes window

  constructor(config: DockerConfig, tokenManager?: SlackTokenManager) {
    this.config = {
      socketPath: "/var/run/docker.sock",
      removeContainers: true,
      ...config
    };
    this.tokenManager = tokenManager;

    // Initialize Docker client
    this.docker = new Docker({
      socketPath: this.config.socketPath
    });
    
    // Start cleanup timer for rate limit entries
    this.startRateLimitCleanup();
  }

  /**
   * Check if user is within rate limits
   */
  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const entry = this.rateLimitMap.get(userId);
    
    if (!entry) {
      // First request for this user
      this.rateLimitMap.set(userId, { count: 1, windowStart: now });
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
    console.warn(`Rate limit exceeded for user ${userId}: ${entry.count} jobs in current window`);
    return false;
  }

  /**
   * Start periodic cleanup of expired rate limit entries
   */
  private startRateLimitCleanup(): void {
    const cleanupInterval = 5 * 60 * 1000; // Clean up every 5 minutes
    
    this.rateLimitCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [userId, entry] of this.rateLimitMap.entries()) {
        if (now - entry.windowStart >= this.RATE_LIMIT_WINDOW_MS) {
          this.rateLimitMap.delete(userId);
        }
      }
    }, cleanupInterval);
  }

  /**
   * Create a worker job for the user request
   */
  async createWorkerJob(request: WorkerJobRequest): Promise<string> {
    // Check rate limits first
    if (!this.checkRateLimit(request.userId)) {
      throw new Error(
        `Rate limit exceeded for user ${request.userId}. Maximum ${this.RATE_LIMIT_MAX_JOBS} jobs per ${this.RATE_LIMIT_WINDOW_MS / 1000 / 60} minutes`
      );
    }

    const containerName = this.generateContainerName(request.sessionKey);
    
    try {
      // Check if container already exists
      const existingContainer = this.activeContainers.get(request.sessionKey);
      if (existingContainer) {
        console.log(`Container already exists for session ${request.sessionKey}: ${existingContainer.containerId}`);
        return existingContainer.containerId;
      }

      // Create container configuration
      const containerConfig = this.createContainerConfig(containerName, request);

      // Create the container
      const container = await this.docker.createContainer(containerConfig);
      
      // Start the container
      await container.start();
      
      // Track the container
      const containerInfo: ContainerInfo = {
        containerId: container.id,
        sessionKey: request.sessionKey,
        status: "running",
        createdAt: Date.now()
      };
      this.activeContainers.set(request.sessionKey, containerInfo);
      
      console.log(`Created Docker container: ${container.id} for session ${request.sessionKey}`);
      
      // Start monitoring the container
      this.monitorContainer(container, request.sessionKey);
      
      return container.id;

    } catch (error) {
      throw new Error(
        `Failed to create container for session ${request.sessionKey}: ${error}`
      );
    }
  }

  /**
   * Generate unique container name
   */
  private generateContainerName(sessionKey: string): string {
    const timestamp = Date.now().toString(36);
    const sessionHash = sessionKey.replace(/[^a-z0-9]/gi, "").toLowerCase().substring(0, 8);
    return `claude-worker-${sessionHash}-${timestamp}`;
  }

  /**
   * Create Docker container configuration
   */
  private createContainerConfig(containerName: string, request: WorkerJobRequest): Docker.ContainerCreateOptions {
    const env = [
      `SESSION_KEY=${request.sessionKey}`,
      `USER_ID=${request.userId}`,
      `USERNAME=${request.username}`,
      `CHANNEL_ID=${request.channelId}`,
      `THREAD_TS=${request.threadTs || ""}`,
      `REPOSITORY_URL=${request.repositoryUrl}`,
      `USER_PROMPT=${Buffer.from(request.userPrompt).toString("base64")}`,
      `SLACK_RESPONSE_CHANNEL=${request.slackResponseChannel}`,
      `SLACK_RESPONSE_TS=${request.slackResponseTs}`,
      `CLAUDE_OPTIONS=${JSON.stringify(request.claudeOptions)}`,
      `RECOVERY_MODE=${request.recoveryMode ? "true" : "false"}`,
      // Environment variables from process.env
      `SLACK_BOT_TOKEN=${process.env.SLACK_BOT_TOKEN || ""}`,
      `SLACK_REFRESH_TOKEN=${process.env.SLACK_REFRESH_TOKEN || ""}`,
      `SLACK_CLIENT_ID=${process.env.SLACK_CLIENT_ID || ""}`,
      `SLACK_CLIENT_SECRET=${process.env.SLACK_CLIENT_SECRET || ""}`,
      `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ""}`,
      `GCS_BUCKET_NAME=${process.env.GCS_BUCKET_NAME || ""}`,
      `GOOGLE_CLOUD_PROJECT=${process.env.GOOGLE_CLOUD_PROJECT || ""}`,
    ];

    const hostConfig: Docker.HostConfig = {
      AutoRemove: this.config.removeContainers,
      NetworkMode: this.config.network || "bridge",
    };

    // Add resource limits if specified
    if (this.config.cpu || this.config.memory) {
      hostConfig.Memory = this.config.memory ? this.parseMemory(this.config.memory) : undefined;
      hostConfig.CpuShares = this.config.cpu ? this.parseCpu(this.config.cpu) : undefined;
    }

    // Add workspace volume mounting for development
    if (this.config.workspaceVolumeHost) {
      hostConfig.Binds = [
        `${this.config.workspaceVolumeHost}:/workspace:rw`
      ];
    }

    // Add GCS credentials volume if available
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      env.push(`GOOGLE_APPLICATION_CREDENTIALS=/etc/gcs/key.json`);
      hostConfig.Binds = hostConfig.Binds || [];
      hostConfig.Binds.push(`${process.env.GOOGLE_APPLICATION_CREDENTIALS}:/etc/gcs/key.json:ro`);
    }

    const config: Docker.ContainerCreateOptions = {
      Image: this.config.workerImage,
      name: containerName,
      Env: env,
      WorkingDir: "/workspace",
      Cmd: ["/app/scripts/entrypoint.sh"],
      HostConfig: hostConfig,
      Labels: {
        "app": "claude-worker",
        "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
        "user-id": request.userId,
        "component": "worker",
        "claude.ai/session-key": request.sessionKey,
        "claude.ai/user-id": request.userId,
        "claude.ai/username": request.username,
        "claude.ai/created-at": new Date().toISOString(),
      }
    };

    return config;
  }

  /**
   * Parse memory string (e.g., "2Gi" -> bytes)
   */
  private parseMemory(memory: string): number {
    const match = memory.match(/^(\d+(?:\.\d+)?)([KMGT]?i?)$/);
    if (!match) {
      throw new Error(`Invalid memory specification: ${memory}. Expected format: number[KMGT][i] (e.g., "2Gi", "512Mi")`);
    }
    
    const value = parseFloat(match[1]);
    if (value <= 0) {
      throw new Error(`Memory value must be positive: ${memory}`);
    }
    
    const unit = match[2].toUpperCase();
    
    const multipliers: { [key: string]: number } = {
      "": 1,
      "K": 1024,
      "KI": 1024,
      "M": 1024 * 1024,
      "MI": 1024 * 1024,
      "G": 1024 * 1024 * 1024,
      "GI": 1024 * 1024 * 1024,
      "T": 1024 * 1024 * 1024 * 1024,
      "TI": 1024 * 1024 * 1024 * 1024,
    };
    
    return Math.floor(value * (multipliers[unit] || 1));
  }

  /**
   * Parse CPU string (e.g., "1000m" -> CPU shares)
   */
  private parseCpu(cpu: string): number {
    if (cpu.endsWith('m')) {
      // Millicores to CPU shares (1024 shares = 1 CPU)
      const millicores = parseInt(cpu.slice(0, -1));
      return Math.floor((millicores / 1000) * 1024);
    }
    // Assume it's already in CPU units
    return Math.floor(parseFloat(cpu) * 1024);
  }

  /**
   * Monitor container status
   */
  private async monitorContainer(container: Docker.Container, sessionKey: string): Promise<void> {
    try {
      // Wait for container to finish
      const result = await container.wait();
      
      const containerInfo = this.activeContainers.get(sessionKey);
      if (containerInfo) {
        containerInfo.status = result.StatusCode === 0 ? "completed" : "failed";
        
        console.log(`Container ${container.id} finished with status code: ${result.StatusCode}`);
        
        // Remove from active containers immediately after status update
        this.activeContainers.delete(sessionKey);
      }
    } catch (error) {
      console.error(`Error monitoring container ${container.id}:`, error);
      this.activeContainers.delete(sessionKey);
    }
  }

  /**
   * Delete a container
   */
  async deleteJob(containerName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerName);
      
      // Stop the container if running
      try {
        await container.stop();
      } catch (error: any) {
        // Check if container is already stopped or doesn't exist
        if (error?.statusCode === 304 || error?.statusCode === 404 || 
            (error?.message && error.message.includes('is not running'))) {
          console.log(`Container ${containerName} was already stopped`);
        } else {
          console.warn(`Error stopping container ${containerName}:`, error);
        }
      }
      
      // Remove the container if not auto-removed
      if (!this.config.removeContainers) {
        try {
          await container.remove();
        } catch (error: any) {
          // Check if container is already removed or doesn't exist
          if (error?.statusCode === 404) {
            console.log(`Container ${containerName} was already removed`);
          } else {
            console.warn(`Error removing container ${containerName}:`, error);
          }
        }
      }
      
      console.log(`Deleted container: ${containerName}`);
    } catch (error) {
      console.error(`Failed to delete container ${containerName}:`, error);
    }
  }

  /**
   * Get container status
   */
  async getJobStatus(containerName: string): Promise<string> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      
      if (info.State.Running) return "running";
      if (info.State.Status === "exited") {
        return info.State.ExitCode === 0 ? "completed" : "failed";
      }
      
      return info.State.Status || "unknown";
    } catch (error) {
      return "unknown";
    }
  }

  /**
   * List active containers
   */
  async listActiveJobs(): Promise<Array<{ name: string; sessionKey: string; status: string }>> {
    const jobs = [];
    
    for (const [sessionKey, containerInfo] of this.activeContainers.entries()) {
      const status = await this.getJobStatus(containerInfo.containerId);
      jobs.push({ 
        name: containerInfo.containerId, 
        sessionKey, 
        status 
      });
    }
    
    return jobs;
  }

  /**
   * Get active container count
   */
  getActiveJobCount(): number {
    return this.activeContainers.size;
  }

  /**
   * Cleanup all containers
   */
  async cleanup(): Promise<void> {
    console.log(`Cleaning up ${this.activeContainers.size} active containers...`);
    
    // Clear the rate limit cleanup interval
    if (this.rateLimitCleanupInterval) {
      clearInterval(this.rateLimitCleanupInterval);
      this.rateLimitCleanupInterval = undefined;
    }
    
    const promises = Array.from(this.activeContainers.values()).map(containerInfo =>
      this.deleteJob(containerInfo.containerId).catch(error => 
        console.error(`Failed to delete container ${containerInfo.containerId}:`, error)
      )
    );
    
    await Promise.allSettled(promises);
    this.activeContainers.clear();
    
    console.log("Container cleanup completed");
  }
}