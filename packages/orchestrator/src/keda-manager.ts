import * as k8s from '@kubernetes/client-node';
import { 
  OrchestratorConfig, 
  KedaScaledObject, 
  KedaDeployment, 
  UserQueueConfig,
  ThreadDeployment,
  OrchestratorError,
  ErrorCode 
} from './types';
import { DatabasePool } from './database-pool';

export class KedaManager {
  private k8sApi: k8s.CustomObjectsApi;
  private appsV1Api: k8s.AppsV1Api;
  private coreV1Api: k8s.CoreV1Api;
  private config: OrchestratorConfig;
  private dbPool: DatabasePool;
  private activeUserQueues: Map<string, UserQueueConfig> = new Map();
  private activeThreadDeployments: Map<string, ThreadDeployment> = new Map();

  constructor(config: OrchestratorConfig, dbPool: DatabasePool) {
    this.config = config;
    this.dbPool = dbPool;

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    
    this.k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
    this.coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
  }

  /**
   * Create or update user-specific queue and KEDA ScaledObject
   */
  async ensureUserQueue(userId: string): Promise<UserQueueConfig> {
    const queueName = this.getUserQueueName(userId);
    const existing = this.activeUserQueues.get(userId);

    if (existing && existing.isActive) {
      // Update thread count and last activity
      existing.threadCount++;
      existing.lastActivity = new Date();
      return existing;
    }

    try {
      // Create deployment for this user if it doesn't exist
      const deploymentName = this.getUserDeploymentName(userId);
      await this.createUserDeployment(userId, deploymentName);

      // Create KEDA ScaledObject for user queue
      const scaledObjectName = this.getUserScaledObjectName(userId);
      await this.createUserScaledObject(userId, queueName, deploymentName, scaledObjectName);

      const userQueue: UserQueueConfig = {
        userId,
        queueName,
        scaledObjectName,
        deploymentName,
        isActive: true,
        threadCount: 1,
        lastActivity: new Date()
      };

      this.activeUserQueues.set(userId, userQueue);
      return userQueue;
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.KEDA_SCALEDOBJECT_CREATE_FAILED,
        `Failed to ensure user queue for ${userId}: ${error.message}`,
        { userId, error },
        true
      );
    }
  }

  /**
   * Create thread-specific deployment tracking
   */
  async createThreadDeployment(
    userId: string,
    threadId: string,
    agentSessionId: string
  ): Promise<ThreadDeployment> {
    const userQueue = await this.ensureUserQueue(userId);
    
    const threadDeployment: ThreadDeployment = {
      threadId,
      userId,
      deploymentName: userQueue.deploymentName,
      agentSessionId,
      createdAt: new Date(),
      isActive: true,
      lastHeartbeat: new Date()
    };

    this.activeThreadDeployments.set(threadId, threadDeployment);
    return threadDeployment;
  }

  /**
   * Create user-specific deployment
   */
  private async createUserDeployment(userId: string, deploymentName: string): Promise<void> {
    try {
      // Check if deployment already exists
      try {
        await this.appsV1Api.readNamespacedDeployment(deploymentName, this.config.kubernetes.namespace);
        console.log(`Deployment ${deploymentName} already exists, reusing`);
        return;
      } catch (error) {
        // Deployment doesn't exist, create it
      }

      // Ensure user credentials exist
      if (!(await this.dbPool.userCredentialsExist(userId))) {
        const password = this.generateSecurePassword();
        await this.dbPool.createUserCredentials(userId, password);
        await this.createUserSecret(userId, password);
      }

      const deployment: KedaDeployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: deploymentName,
          namespace: this.config.kubernetes.namespace,
          labels: {
            'app.kubernetes.io/name': 'peerbot',
            'app.kubernetes.io/component': 'worker',
            'peerbot.io/user-id': userId,
            'peerbot.io/managed-by': 'orchestrator'
          }
        },
        spec: {
          replicas: 1, // KEDA will override this
          selector: {
            matchLabels: {
              'app.kubernetes.io/name': 'peerbot',
              'app.kubernetes.io/component': 'worker',
              'peerbot.io/user-id': userId
            }
          },
          template: {
            metadata: {
              labels: {
                'app.kubernetes.io/name': 'peerbot',
                'app.kubernetes.io/component': 'worker',
                'peerbot.io/user-id': userId
              }
            },
            spec: {
              serviceAccountName: 'peerbot-worker',
              containers: [{
                name: 'worker',
                image: `${this.config.worker.image.repository}:${this.config.worker.image.tag}`,
                imagePullPolicy: 'Always',
                env: [
                  // User-specific database connection
                  {
                    name: 'DATABASE_URL',
                    value: `postgres://user_${userId.replace(/[^a-zA-Z0-9]/g, '_')}:$(DATABASE_PASSWORD)@peerbot-postgresql:5432/peerbot`
                  },
                  {
                    name: 'DATABASE_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: `peerbot-user-${userId}`,
                        key: 'password'
                      }
                    }
                  },
                  // Queue configuration
                  {
                    name: 'QUEUE_USER_QUEUE',
                    value: this.getUserQueueName(userId)
                  },
                  {
                    name: 'USER_ID', 
                    value: userId
                  },
                  // Worker configuration
                  {
                    name: 'WORKER_MODE',
                    value: 'queue'
                  },
                  {
                    name: 'LOG_LEVEL',
                    value: 'info'
                  },
                  // Workspace configuration
                  {
                    name: 'WORKSPACE_PATH',
                    value: '/workspace'
                  }
                ],
                ports: [{
                  name: 'health',
                  containerPort: 8080,
                  protocol: 'TCP'
                }],
                livenessProbe: {
                  httpGet: {
                    path: '/health',
                    port: 'health'
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                  timeoutSeconds: 10,
                  failureThreshold: 3
                },
                readinessProbe: {
                  httpGet: {
                    path: '/ready', 
                    port: 'health'
                  },
                  initialDelaySeconds: 15,
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                  failureThreshold: 3
                },
                resources: {
                  requests: this.config.worker.resources.requests,
                  limits: this.config.worker.resources.limits
                },
                volumeMounts: [{
                  name: 'workspace',
                  mountPath: '/workspace'
                }]
              }],
              volumes: [{
                name: 'workspace',
                persistentVolumeClaim: {
                  claimName: `peerbot-user-${userId}-pvc`
                }
              }]
            }
          }
        }
      };

      await this.appsV1Api.createNamespacedDeployment(this.config.kubernetes.namespace, deployment);
      console.log(`Created deployment ${deploymentName} for user ${userId}`);
    } catch (error) {
      throw OrchestratorError.fromKubernetesError(error);
    }
  }

  /**
   * Create user-specific KEDA ScaledObject
   */
  private async createUserScaledObject(
    userId: string,
    queueName: string,
    deploymentName: string,
    scaledObjectName: string
  ): Promise<void> {
    try {
      // Check if ScaledObject already exists
      try {
        await this.k8sApi.getNamespacedCustomObject(
          'keda.sh',
          'v1alpha1',
          this.config.kubernetes.namespace,
          'scaledobjects',
          scaledObjectName
        );
        console.log(`ScaledObject ${scaledObjectName} already exists, reusing`);
        return;
      } catch (error) {
        // ScaledObject doesn't exist, create it
      }

      const scaledObject: KedaScaledObject = {
        apiVersion: 'keda.sh/v1alpha1',
        kind: 'ScaledObject',
        metadata: {
          name: scaledObjectName,
          namespace: this.config.kubernetes.namespace,
          labels: {
            'app.kubernetes.io/name': 'peerbot',
            'app.kubernetes.io/component': 'worker-scaler',
            'peerbot.io/user-id': userId,
            'peerbot.io/managed-by': 'orchestrator'
          }
        },
        spec: {
          scaleTargetRef: {
            name: deploymentName
          },
          pollingInterval: this.config.keda.pollingInterval,
          cooldownPeriod: this.config.keda.cooldownPeriod,
          minReplicaCount: this.config.keda.minReplicas,
          maxReplicaCount: this.config.keda.maxReplicas,
          triggers: [{
            type: 'postgresql',
            metadata: {
              connectionFromEnv: 'DATABASE_URL',
              query: `SELECT COUNT(*) FROM pgboss.job WHERE name = '${queueName}' AND state IN ('created', 'retry') AND startafter <= now()`,
              targetQueryValue: this.config.keda.jobThreshold.toString(),
              queryTimeout: '30'
            }
          }],
          advanced: {
            horizontalPodAutoscalerConfig: {
              behavior: {
                scaleDown: {
                  stabilizationWindowSeconds: 300,
                  policies: [{
                    type: 'Percent',
                    value: 25,
                    periodSeconds: 60
                  }]
                },
                scaleUp: {
                  stabilizationWindowSeconds: 60,
                  policies: [
                    {
                      type: 'Percent',
                      value: 100,
                      periodSeconds: 15
                    },
                    {
                      type: 'Pods',
                      value: 5,
                      periodSeconds: 15
                    }
                  ]
                }
              }
            }
          }
        }
      };

      await this.k8sApi.createNamespacedCustomObject(
        'keda.sh',
        'v1alpha1',
        this.config.kubernetes.namespace,
        'scaledobjects',
        scaledObject
      );

      console.log(`Created KEDA ScaledObject ${scaledObjectName} for user ${userId}`);
    } catch (error) {
      throw OrchestratorError.fromKubernetesError(error);
    }
  }

  /**
   * Create user-specific secret for database credentials
   */
  private async createUserSecret(userId: string, password: string): Promise<void> {
    try {
      const secretName = `peerbot-user-${userId}`;
      
      // Check if secret already exists
      try {
        await this.coreV1Api.readNamespacedSecret(secretName, this.config.kubernetes.namespace);
        console.log(`Secret ${secretName} already exists, skipping creation`);
        return;
      } catch (error) {
        // Secret doesn't exist, create it
      }

      const secret = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: secretName,
          namespace: this.config.kubernetes.namespace,
          labels: {
            'app.kubernetes.io/name': 'peerbot',
            'peerbot.io/user-id': userId,
            'peerbot.io/managed-by': 'orchestrator'
          }
        },
        type: 'Opaque',
        data: {
          password: Buffer.from(password).toString('base64')
        }
      };

      await this.coreV1Api.createNamespacedSecret(this.config.kubernetes.namespace, secret);
      console.log(`Created secret ${secretName} for user ${userId}`);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.SECRET_CREATE_FAILED,
        `Failed to create secret for user ${userId}: ${error.message}`,
        { userId, error },
        true
      );
    }
  }

  /**
   * Cleanup inactive thread deployments
   */
  async cleanupInactiveThreads(): Promise<void> {
    const now = new Date();
    const inactiveThreshold = 30 * 60 * 1000; // 30 minutes

    for (const [threadId, thread] of this.activeThreadDeployments.entries()) {
      if (now.getTime() - thread.lastHeartbeat.getTime() > inactiveThreshold) {
        console.log(`Cleaning up inactive thread deployment: ${threadId}`);
        
        // Mark thread as inactive
        thread.isActive = false;
        this.activeThreadDeployments.delete(threadId);

        // Decrease thread count for user queue
        const userQueue = this.activeUserQueues.get(thread.userId);
        if (userQueue) {
          userQueue.threadCount--;
          
          // If no more threads for user, consider cleanup
          if (userQueue.threadCount <= 0) {
            await this.cleanupUserQueue(thread.userId);
          }
        }
      }
    }
  }

  /**
   * Cleanup user queue when no threads are active
   */
  private async cleanupUserQueue(userId: string): Promise<void> {
    const userQueue = this.activeUserQueues.get(userId);
    if (!userQueue) return;

    try {
      // Delete KEDA ScaledObject
      await this.k8sApi.deleteNamespacedCustomObject(
        'keda.sh',
        'v1alpha1',
        this.config.kubernetes.namespace,
        'scaledobjects',
        userQueue.scaledObjectName
      );

      // Delete Deployment
      await this.appsV1Api.deleteNamespacedDeployment(
        userQueue.deploymentName,
        this.config.kubernetes.namespace
      );

      console.log(`Cleaned up user queue resources for ${userId}`);
      this.activeUserQueues.delete(userId);
    } catch (error) {
      console.error(`Failed to cleanup user queue for ${userId}:`, error);
    }
  }

  /**
   * Update thread heartbeat
   */
  updateThreadHeartbeat(threadId: string): void {
    const thread = this.activeThreadDeployments.get(threadId);
    if (thread) {
      thread.lastHeartbeat = new Date();
    }
  }

  /**
   * Get user queue name
   */
  private getUserQueueName(userId: string): string {
    return `user_${userId.replace(/[^a-zA-Z0-9]/g, '_')}_queue`;
  }

  /**
   * Get user deployment name
   */
  private getUserDeploymentName(userId: string): string {
    return `peerbot-user-${userId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
  }

  /**
   * Get user ScaledObject name
   */
  private getUserScaledObjectName(userId: string): string {
    return `peerbot-user-${userId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-scaler`;
  }

  /**
   * Generate secure password for user database credentials
   */
  private generateSecurePassword(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < 32; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  /**
   * Get deployment status for thread
   */
  getThreadDeployment(threadId: string): ThreadDeployment | undefined {
    return this.activeThreadDeployments.get(threadId);
  }

  /**
   * Get user queue status
   */
  getUserQueue(userId: string): UserQueueConfig | undefined {
    return this.activeUserQueues.get(userId);
  }
}