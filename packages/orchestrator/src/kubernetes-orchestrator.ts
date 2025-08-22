#!/usr/bin/env bun

import * as k8s from "@kubernetes/client-node";
import type { 
  OrchestratorConfig,
  WorkerDeploymentRequest,
  DirectMessageJob,
  OrchestratorError
} from "./types";

/**
 * Kubernetes orchestrator for managing worker deployments
 * Extracted from dispatcher's KubernetesJobManager with queue integration
 */
export class KubernetesOrchestrator {
  private k8sAppsApi: k8s.AppsV1Api;
  private k8sCoreApi: k8s.CoreV1Api;
  private activeDeployments = new Map<string, string>(); // sessionKey -> deploymentName
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.initializeKubernetesClient();
  }

  private initializeKubernetesClient(): void {
    const kc = new k8s.KubeConfig();
    
    // Check if we're running in a Kubernetes pod
    const inCluster = process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT;
    
    if (this.config.kubernetes.kubeconfig) {
      // Explicit kubeconfig path provided
      kc.loadFromFile(this.config.kubernetes.kubeconfig);
      console.log(`✅ Loaded Kubernetes configuration from ${this.config.kubernetes.kubeconfig}`);
    } else if (inCluster) {
      try {
        kc.loadFromCluster();
        console.log("✅ Successfully loaded in-cluster Kubernetes configuration");
      } catch (error) {
        console.error("❌ Failed to load in-cluster config:", error);
        throw new Error("Failed to load in-cluster Kubernetes configuration: " + (error as Error).message);
      }
    } else {
      // Running locally, use default kubeconfig
      try {
        kc.loadFromDefault();
        console.log("✅ Loaded Kubernetes configuration from default kubeconfig");
      } catch (error) {
        console.error("❌ Failed to load default kubeconfig:", error);
        throw new Error("Failed to load Kubernetes configuration. Please ensure kubectl is configured.");
      }
    }

    // For local development with Docker Desktop, skip TLS verification
    if (!inCluster && process.env.NODE_ENV !== 'production') {
      const clusters = kc.getClusters();
      clusters.forEach(cluster => {
        if (cluster.server && (cluster.server.includes('127.0.0.1') || cluster.server.includes('localhost'))) {
          (cluster as any).skipTLSVerify = true;
          console.log(`⚠️  Skipping TLS verification for cluster: ${cluster.name}`);
        }
      });
    }
    
    this.k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
    this.k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  /**
   * Create a worker deployment for handling direct messages
   * This replaces the job-based approach with persistent deployments
   */
  async createWorkerDeployment(request: WorkerDeploymentRequest): Promise<string> {
    const deploymentName = this.generateDeploymentName(request.sessionKey);
    
    try {
      // Check if deployment already exists
      const existingDeployment = await this.findExistingDeployment(request.sessionKey);
      if (existingDeployment) {
        console.log(`Worker deployment already exists for session ${request.sessionKey}: ${existingDeployment}`);
        this.activeDeployments.set(request.sessionKey, existingDeployment);
        return existingDeployment;
      }

      // Create worker deployment manifest
      const deploymentManifest = this.createWorkerDeploymentManifest(deploymentName, request);

      // Create the deployment
      await this.k8sAppsApi.createNamespacedDeployment({
        namespace: this.config.kubernetes.namespace,
        body: deploymentManifest
      });
      
      // Track the deployment
      this.activeDeployments.set(request.sessionKey, deploymentName);
      
      console.log(`Created Kubernetes worker deployment: ${deploymentName} for session ${request.sessionKey}`);
      
      // Start monitoring the deployment
      this.monitorDeployment(deploymentName, request.sessionKey);
      
      return deploymentName;

    } catch (error) {
      throw new Error(`Failed to create worker deployment for session ${request.sessionKey}: ${(error as Error).message}`);
    }
  }

  /**
   * Find existing worker deployment for a session
   */
  private async findExistingDeployment(sessionKey: string): Promise<string | null> {
    try {
      const labelValue = sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      
      const deploymentsResponse = await this.k8sAppsApi.listNamespacedDeployment({
        namespace: this.config.kubernetes.namespace,
        labelSelector: `session-key=${labelValue}`
      });
      
      // Find active deployments
      for (const deployment of deploymentsResponse.items) {
        const deploymentName = deployment.metadata?.name;
        const status = deployment.status;
        
        if (deploymentName && status?.readyReplicas && status?.readyReplicas > 0) {
          const annotations = deployment.metadata?.annotations || {};
          if (annotations["claude.ai/session-key"] === sessionKey) {
            console.log(`Found existing active worker ${deploymentName} for session ${sessionKey}`);
            return deploymentName;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error(`Error checking for existing worker for session ${sessionKey}:`, error);
      return null;
    }
  }

  /**
   * Generate deployment name based on session key
   */
  private generateDeploymentName(sessionKey: string): string {
    const safeSessionKey = sessionKey.replace(/\./g, "-").toLowerCase();
    return `claude-worker-${safeSessionKey}`;
  }

  /**
   * Create Kubernetes Deployment manifest for persistent worker
   */
  private createWorkerDeploymentManifest(deploymentName: string, request: WorkerDeploymentRequest): k8s.V1Deployment {
    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deploymentName,
        namespace: this.config.kubernetes.namespace,
        labels: {
          app: "claude-worker",
          "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
          "bot-id": request.botId.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
          "user-id": request.userId,
          component: "worker",
        },
        annotations: {
          "claude.ai/session-key": request.sessionKey,
          "claude.ai/bot-id": request.botId,
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
            containers: [
              {
                name: "claude-worker",
                image: this.config.kubernetes.workerImage,
                imagePullPolicy: "Always",
                command: ["bun", "run", "dist/persistent-worker.js"],
                resources: {
                  requests: {
                    cpu: this.config.kubernetes.cpu,
                    memory: this.config.kubernetes.memory,
                  },
                  limits: {
                    cpu: this.config.kubernetes.cpu,
                    memory: this.config.kubernetes.memory,
                  },
                },
                env: [
                  // Session and bot context
                  {
                    name: "SESSION_KEY",
                    value: request.sessionKey,
                  },
                  {
                    name: "BOT_ID",
                    value: request.botId,
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
                    name: "THREAD_ID",
                    value: request.threadId,
                  },
                  {
                    name: "REPOSITORY_URL",
                    value: request.repositoryUrl,
                  },
                  {
                    name: "WORKER_NAME",
                    value: deploymentName,
                  },
                  {
                    name: "SESSION_TIMEOUT_MINUTES",
                    value: "30", // Longer timeout for persistent workers
                  },
                  // PostgreSQL connection for queue access
                  {
                    name: "DATABASE_HOST",
                    value: this.config.database.host,
                  },
                  {
                    name: "DATABASE_PORT",
                    value: this.config.database.port.toString(),
                  },
                  {
                    name: "DATABASE_NAME",
                    value: this.config.database.database,
                  },
                  {
                    name: "DATABASE_USER",
                    valueFrom: {
                      secretKeyRef: {
                        name: "peerbot-secrets",
                        key: `db-user-${request.botId}`,
                      },
                    },
                  },
                  {
                    name: "DATABASE_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: "peerbot-secrets",
                        key: `db-password-${request.botId}`,
                      },
                    },
                  },
                  // Platform tokens
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
   * Monitor deployment status
   */
  private async monitorDeployment(deploymentName: string, sessionKey: string): Promise<void> {
    const maxAttempts = 60; // Monitor for up to 10 minutes
    let attempts = 0;

    const checkStatus = async () => {
      try {
        attempts++;
        
        const deploymentResponse = await this.k8sAppsApi.readNamespacedDeployment({
          name: deploymentName,
          namespace: this.config.kubernetes.namespace
        });
        
        const status = deploymentResponse.status;
        
        if (status?.readyReplicas && status.readyReplicas > 0) {
          console.log(`Worker ${deploymentName} is ready and running`);
          return;
        }
        
        // Check if deployment failed
        if (status?.conditions) {
          const failedCondition = status.conditions.find(c => 
            c.type === "Progressing" && c.status === "False"
          );
          if (failedCondition) {
            console.error(`Worker ${deploymentName} failed to deploy: ${failedCondition.reason} - ${failedCondition.message}`);
            this.activeDeployments.delete(sessionKey);
            return;
          }
        }
        
        if (attempts >= maxAttempts) {
          console.warn(`Worker ${deploymentName} monitoring timed out after ${maxAttempts} attempts`);
          return;
        }
        
        setTimeout(checkStatus, 10000);
        
      } catch (error) {
        console.error(`Error monitoring worker ${deploymentName}:`, error);
        if (attempts < maxAttempts) {
          setTimeout(checkStatus, 10000);
        }
      }
    };

    setTimeout(checkStatus, 5000);
  }

  /**
   * Delete a deployment
   */
  async deleteDeployment(deploymentName: string): Promise<void> {
    try {
      await this.k8sAppsApi.deleteNamespacedDeployment({
        name: deploymentName,
        namespace: this.config.kubernetes.namespace,
        body: {
          propagationPolicy: "Background"
        }
      });
      
      console.log(`Deleted deployment: ${deploymentName}`);
    } catch (error) {
      console.error(`Failed to delete deployment ${deploymentName}:`, error);
    }
  }

  /**
   * Get deployment status
   */
  async getDeploymentStatus(deploymentName: string): Promise<string> {
    try {
      const response = await this.k8sAppsApi.readNamespacedDeployment({
        name: deploymentName,
        namespace: this.config.kubernetes.namespace
      });
      
      const status = response.status;
      
      if (status?.readyReplicas && status.readyReplicas > 0) return "running";
      if (status?.replicas === 0) return "stopped";
      
      return "pending";
    } catch (error) {
      return "unknown";
    }
  }

  /**
   * Get active deployment count
   */
  getActiveDeploymentCount(): number {
    return this.activeDeployments.size;
  }

  /**
   * Cleanup all deployments
   */
  async cleanup(): Promise<void> {
    console.log(`Cleaning up ${this.activeDeployments.size} active deployments...`);
    
    const promises = Array.from(this.activeDeployments.values()).map(deploymentName =>
      this.deleteDeployment(deploymentName).catch(error => 
        console.error(`Failed to delete deployment ${deploymentName}:`, error)
      )
    );
    
    await Promise.allSettled(promises);
    this.activeDeployments.clear();
    
    console.log("Deployment cleanup completed");
  }
}