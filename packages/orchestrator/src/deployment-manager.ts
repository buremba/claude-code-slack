import * as k8s from '@kubernetes/client-node';
import { 
  OrchestratorConfig, 
  SimpleDeployment, 
  UserQueueConfig,
  ThreadDeployment,
  OrchestratorError,
  ErrorCode 
} from './types';
import { DatabasePool } from './database-pool';

export class DeploymentManager {
  private appsV1Api: k8s.AppsV1Api;
  private coreV1Api: k8s.CoreV1Api;
  private config: OrchestratorConfig;
  private dbPool: DatabasePool;
  private activeUserQueues: Map<string, UserQueueConfig> = new Map();
  private activeThreadDeployments: Map<string, ThreadDeployment> = new Map();
  private idleTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: OrchestratorConfig, dbPool: DatabasePool) {
    this.config = config;
    this.dbPool = dbPool;

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    
    this.appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
    this.coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
  }

  /**
   * Create or update user-specific queue and deployment
   */
  async ensureUserQueue(userId: string): Promise<UserQueueConfig> {
    const queueName = this.getUserQueueName(userId);
    const existing = this.activeUserQueues.get(userId);

    if (existing && existing.isActive) {
      // Update thread count and last activity
      existing.threadCount++;
      existing.lastActivity = new Date();
      // Cancel idle timer since there's activity
      this.cancelIdleTimer(userId);
      // Scale deployment to 1 if needed
      await this.scaleDeployment(existing.deploymentName, 1);
      return existing;
    }

    try {
      // Create deployment for this user if it doesn't exist
      const deploymentName = this.getUserDeploymentName(userId);
      await this.createUserDeployment(userId, deploymentName);
      // Start with 1 replica as requested
      await this.scaleDeployment(deploymentName, 1);

      const userQueue: UserQueueConfig = {
        userId,
        queueName,
        deploymentName,
        isActive: true,
        threadCount: 1,
        lastActivity: new Date(),
        currentReplicas: 1
      };

      this.activeUserQueues.set(userId, userQueue);
      return userQueue;
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to ensure user queue for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
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

      const deployment: SimpleDeployment = {
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
          replicas: 1, // Start with 1 pod as requested
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
   * Scale deployment to specified replica count
   */
  private async scaleDeployment(deploymentName: string, replicas: number): Promise<void> {
    try {
      const deployment = await this.appsV1Api.readNamespacedDeployment(
        deploymentName, 
        this.config.kubernetes.namespace
      );
      
      if (deployment.body.spec?.replicas !== replicas) {
        deployment.body.spec!.replicas = replicas;
        await this.appsV1Api.patchNamespacedDeployment(
          deploymentName,
          this.config.kubernetes.namespace,
          deployment.body
        );
        console.log(`Scaled deployment ${deploymentName} to ${replicas} replicas`);
      }
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_SCALE_FAILED,
        `Failed to scale deployment ${deploymentName}: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, replicas, error },
        true
      );
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
        `Failed to create secret for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
        { userId, error },
        true
      );
    }
  }

  /**
   * Cleanup inactive thread deployments and start idle timers
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
          
          // If no more threads for user, start 5-minute idle timer
          if (userQueue.threadCount <= 0) {
            this.startIdleTimer(thread.userId);
          }
        }
      }
    }
  }

  /**
   * Start 5-minute idle timer before scaling to 0
   */
  private startIdleTimer(userId: string): void {
    // Cancel existing timer if any
    this.cancelIdleTimer(userId);
    
    const idleTimeout = 5 * 60 * 1000; // 5 minutes as requested
    const timer = setTimeout(async () => {
      await this.scaleUserDeploymentToZero(userId);
    }, idleTimeout);
    
    this.idleTimers.set(userId, timer);
    console.log(`Started 5-minute idle timer for user ${userId}`);
  }

  /**
   * Cancel idle timer for user
   */
  private cancelIdleTimer(userId: string): void {
    const timer = this.idleTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(userId);
      console.log(`Cancelled idle timer for user ${userId}`);
    }
  }

  /**
   * Scale user deployment to 0 after idle timeout
   */
  private async scaleUserDeploymentToZero(userId: string): Promise<void> {
    const userQueue = this.activeUserQueues.get(userId);
    if (!userQueue) return;

    try {
      // Scale deployment to 0
      await this.scaleDeployment(userQueue.deploymentName, 0);
      userQueue.currentReplicas = 0;
      console.log(`Scaled user deployment ${userQueue.deploymentName} to 0 after idle timeout`);
    } catch (error) {
      console.error(`Failed to scale user deployment to 0 for ${userId}:`, error);
    }
  }

  /**
   * Check if user has queued jobs and scale accordingly
   */
  async checkUserQueueAndScale(userId: string): Promise<void> {
    const userQueue = this.activeUserQueues.get(userId);
    if (!userQueue) return;

    try {
      const queueName = this.getUserQueueName(userId);
      const jobCount = await this.dbPool.queryWithUserContext(userId, 
        'SELECT COUNT(*) as count FROM pgboss.job WHERE name = $1 AND state IN ($2, $3) AND startafter <= now()',
        [queueName, 'created', 'retry']
      );
      
      const pendingJobs = parseInt(jobCount.rows[0]?.count || '0');
      
      if (pendingJobs > 0 && userQueue.currentReplicas === 0) {
        // Scale up to 1
        await this.scaleDeployment(userQueue.deploymentName, 1);
        userQueue.currentReplicas = 1;
        this.cancelIdleTimer(userId); // Cancel idle timer
        console.log(`Scaled user deployment ${userQueue.deploymentName} to 1 due to pending jobs`);
      }
    } catch (error) {
      console.error(`Failed to check queue and scale for user ${userId}:`, error);
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