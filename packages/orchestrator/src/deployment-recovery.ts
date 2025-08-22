#!/usr/bin/env bun

import { KubernetesApi } from '@kubernetes/client-node';
import { DatabasePoolService } from '../shared/database-pool-service';
import { OrchestratorError, ErrorCode } from './types';

export interface RecoveryConfig {
  namespace: string;
  labelSelectors: { [key: string]: string };
  maxAge: number; // Maximum age in minutes for orphaned deployments
  recoveryInterval: number; // Recovery check interval in milliseconds
}

export interface OrphanedDeployment {
  name: string;
  creationTime: Date;
  labels: { [key: string]: string };
  status: string;
  shouldRecover: boolean;
  reason: string;
}

/**
 * Deployment recovery service to handle orphaned and failed deployments
 * Provides mechanisms to detect and recover from deployment issues
 */
export class DeploymentRecovery {
  private k8sApi: KubernetesApi;
  private dbPool: DatabasePoolService;
  private config: RecoveryConfig;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private isRecoveryRunning = false;

  constructor(
    k8sApi: KubernetesApi,
    dbPool: DatabasePoolService,
    config: RecoveryConfig
  ) {
    this.k8sApi = k8sApi;
    this.dbPool = dbPool;
    this.config = config;
  }

  /**
   * Start the deployment recovery service
   */
  start(): void {
    if (this.recoveryTimer) {
      console.warn('Deployment recovery is already running');
      return;
    }

    console.log(`Starting deployment recovery service (interval: ${this.config.recoveryInterval}ms)`);
    
    // Run recovery check immediately
    this.runRecoveryCheck();
    
    // Schedule periodic recovery checks
    this.recoveryTimer = setInterval(() => {
      this.runRecoveryCheck();
    }, this.config.recoveryInterval);
  }

  /**
   * Stop the deployment recovery service
   */
  stop(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
      console.log('Deployment recovery service stopped');
    }
  }

  /**
   * Run a manual recovery check
   */
  async runRecoveryCheck(): Promise<OrphanedDeployment[]> {
    if (this.isRecoveryRunning) {
      console.log('Recovery check already running, skipping...');
      return [];
    }

    this.isRecoveryRunning = true;

    try {
      console.log('Starting deployment recovery check...');
      
      const orphanedDeployments = await this.findOrphanedDeployments();
      
      if (orphanedDeployments.length > 0) {
        console.log(`Found ${orphanedDeployments.length} orphaned deployments`);
        
        for (const deployment of orphanedDeployments) {
          if (deployment.shouldRecover) {
            await this.recoverDeployment(deployment);
          } else {
            await this.cleanupOrphanedDeployment(deployment);
          }
        }
      } else {
        console.log('No orphaned deployments found');
      }

      return orphanedDeployments;

    } catch (error) {
      console.error('Error during deployment recovery check:', error);
      throw new OrchestratorError(
        ErrorCode.KUBERNETES_ERROR,
        'Deployment recovery check failed',
        error as Error
      );
    } finally {
      this.isRecoveryRunning = false;
    }
  }

  /**
   * Find orphaned deployments that need attention
   */
  private async findOrphanedDeployments(): Promise<OrphanedDeployment[]> {
    try {
      // Get all deployments matching our label selectors
      const labelSelector = Object.entries(this.config.labelSelectors)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');

      const response = await this.k8sApi.appsV1Api.listNamespacedDeployment({
        namespace: this.config.namespace,
        labelSelector
      });

      const orphaned: OrphanedDeployment[] = [];
      const now = new Date();

      for (const deployment of response.body.items) {
        const name = deployment.metadata?.name || '';
        const labels = deployment.metadata?.labels || {};
        const creationTime = new Date(deployment.metadata?.creationTimestamp || now);
        const ageMinutes = (now.getTime() - creationTime.getTime()) / (1000 * 60);
        
        // Check if deployment is in problematic state
        const status = deployment.status;
        const spec = deployment.spec;
        
        const totalReplicas = spec?.replicas || 0;
        const readyReplicas = status?.readyReplicas || 0;
        const availableReplicas = status?.availableReplicas || 0;
        
        let shouldRecover = false;
        let reason = '';
        let deploymentStatus = 'unknown';

        // Check for various problematic states
        if (ageMinutes > this.config.maxAge) {
          // Old deployment that might be stuck
          if (readyReplicas === 0) {
            shouldRecover = true;
            reason = 'Old deployment with no ready replicas';
            deploymentStatus = 'failed';
          } else if (readyReplicas < totalReplicas) {
            shouldRecover = true;
            reason = 'Old deployment with insufficient replicas';
            deploymentStatus = 'degraded';
          }
        }

        // Check for failed conditions
        if (status?.conditions) {
          const failedCondition = status.conditions.find(c => 
            c.type === "Progressing" && c.status === "False"
          );
          
          if (failedCondition) {
            shouldRecover = true;
            reason = `Failed deployment: ${failedCondition.reason}`;
            deploymentStatus = 'failed';
          }
        }

        // Check if deployment exists in our tracking but isn't in expected state
        const sessionKey = labels['session-key'];
        if (sessionKey && readyReplicas === 0 && ageMinutes > 5) {
          const isTrackedInDB = await this.isDeploymentTracked(sessionKey);
          if (isTrackedInDB) {
            shouldRecover = true;
            reason = 'Tracked deployment with no ready replicas';
            deploymentStatus = 'missing';
          }
        }

        if (shouldRecover || (ageMinutes > this.config.maxAge && readyReplicas === 0)) {
          orphaned.push({
            name,
            creationTime,
            labels,
            status: deploymentStatus,
            shouldRecover,
            reason: reason || 'Old deployment candidate for cleanup'
          });
        }
      }

      return orphaned;

    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.KUBERNETES_ERROR,
        'Failed to find orphaned deployments',
        error as Error
      );
    }
  }

  /**
   * Check if a deployment is tracked in our database
   */
  private async isDeploymentTracked(sessionKey: string): Promise<boolean> {
    try {
      const result = await this.dbPool.query(
        'SELECT id FROM queue_jobs WHERE session_key = $1 AND status IN ($2, $3)',
        [sessionKey, 'active', 'created']
      );
      
      return result.length > 0;
    } catch (error) {
      console.error('Error checking deployment tracking:', error);
      return false;
    }
  }

  /**
   * Attempt to recover a failed deployment
   */
  private async recoverDeployment(deployment: OrphanedDeployment): Promise<void> {
    console.log(`Attempting to recover deployment: ${deployment.name} (${deployment.reason})`);

    try {
      const sessionKey = deployment.labels['session-key'];
      const userId = deployment.labels['user-id'];
      
      if (!sessionKey || !userId) {
        console.warn(`Cannot recover ${deployment.name}: missing required labels`);
        await this.cleanupOrphanedDeployment(deployment);
        return;
      }

      // Try to restart the deployment by scaling down and up
      await this.restartDeployment(deployment.name);
      
      // Update job status in database
      if (sessionKey) {
        await this.updateJobStatus(sessionKey, 'active', 'Deployment recovered');
      }
      
      console.log(`Successfully recovered deployment: ${deployment.name}`);

    } catch (error) {
      console.error(`Failed to recover deployment ${deployment.name}:`, error);
      
      // If recovery fails, try to clean up
      await this.cleanupOrphanedDeployment(deployment);
    }
  }

  /**
   * Restart a deployment by scaling it
   */
  private async restartDeployment(deploymentName: string): Promise<void> {
    try {
      // Scale down to 0
      await this.k8sApi.appsV1Api.patchNamespacedDeployment({
        name: deploymentName,
        namespace: this.config.namespace,
        body: {
          spec: {
            replicas: 0
          }
        }
      });

      // Wait a moment for scale down
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Scale back up to 1
      await this.k8sApi.appsV1Api.patchNamespacedDeployment({
        name: deploymentName,
        namespace: this.config.namespace,
        body: {
          spec: {
            replicas: 1
          }
        }
      });

      console.log(`Restarted deployment: ${deploymentName}`);

    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.KUBERNETES_ERROR,
        `Failed to restart deployment ${deploymentName}`,
        error as Error,
        { deploymentName }
      );
    }
  }

  /**
   * Clean up an orphaned deployment
   */
  private async cleanupOrphanedDeployment(deployment: OrphanedDeployment): Promise<void> {
    console.log(`Cleaning up orphaned deployment: ${deployment.name} (${deployment.reason})`);

    try {
      // Delete the deployment
      await this.k8sApi.appsV1Api.deleteNamespacedDeployment({
        name: deployment.name,
        namespace: this.config.namespace
      });

      // Update job status in database if tracked
      const sessionKey = deployment.labels['session-key'];
      if (sessionKey) {
        await this.updateJobStatus(sessionKey, 'failed', 'Deployment cleaned up due to orphaned state');
      }

      console.log(`Successfully cleaned up deployment: ${deployment.name}`);

    } catch (error) {
      console.error(`Failed to cleanup deployment ${deployment.name}:`, error);
    }
  }

  /**
   * Update job status in database
   */
  private async updateJobStatus(sessionKey: string, status: string, message?: string): Promise<void> {
    try {
      await this.dbPool.query(
        'SELECT update_job_status($1, $2, $3)',
        [sessionKey, status, message || null]
      );
    } catch (error) {
      console.error(`Failed to update job status for ${sessionKey}:`, error);
    }
  }

  /**
   * Get recovery statistics
   */
  getStats() {
    return {
      isRunning: !!this.recoveryTimer,
      isRecoveryActive: this.isRecoveryRunning,
      config: {
        interval: this.config.recoveryInterval,
        maxAge: this.config.maxAge,
        namespace: this.config.namespace
      }
    };
  }
}