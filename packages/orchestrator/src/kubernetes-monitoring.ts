#!/usr/bin/env bun

import { KubernetesApi, Watch, V1Deployment } from '@kubernetes/client-node';
import { OrchestratorError, ErrorCode } from './types';

export interface MonitoringConfig {
  namespace: string;
  maxRetries: number;
  initialRetryDelay: number;
  maxRetryDelay: number;
  retryBackoffMultiplier: number;
}

export interface DeploymentStatus {
  name: string;
  status: 'pending' | 'ready' | 'failed' | 'unknown';
  readyReplicas: number;
  totalReplicas: number;
  message?: string;
  lastUpdateTime: Date;
}

/**
 * Enhanced Kubernetes deployment monitoring with watch API and exponential backoff
 */
export class KubernetesMonitoring {
  private k8sApi: KubernetesApi;
  private config: MonitoringConfig;
  private watchers: Map<string, Watch> = new Map();
  private deploymentCallbacks: Map<string, (status: DeploymentStatus) => void> = new Map();
  private retryAttempts: Map<string, number> = new Map();

  constructor(k8sApi: KubernetesApi, config: MonitoringConfig) {
    this.k8sApi = k8sApi;
    this.config = config;
  }

  /**
   * Start monitoring a deployment with real-time watch API
   */
  async startMonitoring(
    deploymentName: string, 
    onStatusChange: (status: DeploymentStatus) => void
  ): Promise<void> {
    // Store callback for this deployment
    this.deploymentCallbacks.set(deploymentName, onStatusChange);
    this.retryAttempts.set(deploymentName, 0);

    try {
      await this.setupWatch(deploymentName);
      
      // Also do an initial status check
      await this.checkDeploymentStatus(deploymentName);
      
    } catch (error) {
      console.error(`Failed to start monitoring for ${deploymentName}:`, error);
      await this.handleMonitoringError(deploymentName, error as Error);
    }
  }

  /**
   * Setup Kubernetes watch for deployment changes
   */
  private async setupWatch(deploymentName: string): Promise<void> {
    const watch = new Watch(this.k8sApi.makeApiClient());
    
    const watchPath = `/apis/apps/v1/namespaces/${this.config.namespace}/deployments`;
    const queryParams = {
      fieldSelector: `metadata.name=${deploymentName}`,
      resourceVersion: '0', // Start from beginning
    };

    try {
      const watchStream = await watch.watch(
        watchPath,
        queryParams,
        (type: string, apiObj: V1Deployment) => {
          this.handleWatchEvent(deploymentName, type, apiObj);
        },
        (err: any) => {
          console.error(`Watch error for ${deploymentName}:`, err);
          this.handleWatchError(deploymentName, err);
        }
      );

      // Store the watch request for cleanup
      this.watchers.set(deploymentName, watch);

      console.log(`Started watching deployment: ${deploymentName}`);

    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.KUBERNETES_ERROR,
        `Failed to setup watch for deployment ${deploymentName}`,
        error as Error,
        { deploymentName }
      );
    }
  }

  /**
   * Handle watch events from Kubernetes API
   */
  private handleWatchEvent(deploymentName: string, eventType: string, deployment: V1Deployment): void {
    try {
      const status = this.parseDeploymentStatus(deployment);
      const callback = this.deploymentCallbacks.get(deploymentName);
      
      if (callback) {
        callback(status);
      }

      // Reset retry attempts on successful event
      this.retryAttempts.set(deploymentName, 0);

      // Auto-cleanup monitoring for completed deployments
      if (status.status === 'ready' || status.status === 'failed') {
        setTimeout(() => {
          this.stopMonitoring(deploymentName);
        }, 30000); // Keep monitoring for 30 more seconds
      }

    } catch (error) {
      console.error(`Error handling watch event for ${deploymentName}:`, error);
    }
  }

  /**
   * Handle watch connection errors with exponential backoff
   */
  private async handleWatchError(deploymentName: string, error: any): Promise<void> {
    const currentAttempts = this.retryAttempts.get(deploymentName) || 0;
    
    if (currentAttempts >= this.config.maxRetries) {
      console.error(`Max retry attempts reached for ${deploymentName}, stopping monitoring`);
      this.stopMonitoring(deploymentName);
      return;
    }

    const delay = this.calculateBackoffDelay(currentAttempts);
    this.retryAttempts.set(deploymentName, currentAttempts + 1);
    
    console.log(`Retrying watch for ${deploymentName} in ${delay}ms (attempt ${currentAttempts + 1})`);
    
    setTimeout(async () => {
      try {
        await this.setupWatch(deploymentName);
      } catch (retryError) {
        await this.handleWatchError(deploymentName, retryError);
      }
    }, delay);
  }

  /**
   * Handle monitoring errors with exponential backoff
   */
  private async handleMonitoringError(deploymentName: string, error: Error): Promise<void> {
    const currentAttempts = this.retryAttempts.get(deploymentName) || 0;
    
    if (currentAttempts >= this.config.maxRetries) {
      console.error(`Max retry attempts reached for monitoring ${deploymentName}`);
      return;
    }

    const delay = this.calculateBackoffDelay(currentAttempts);
    this.retryAttempts.set(deploymentName, currentAttempts + 1);
    
    console.log(`Retrying monitoring for ${deploymentName} in ${delay}ms (attempt ${currentAttempts + 1})`);
    
    setTimeout(async () => {
      try {
        await this.setupWatch(deploymentName);
        await this.checkDeploymentStatus(deploymentName);
      } catch (retryError) {
        await this.handleMonitoringError(deploymentName, retryError as Error);
      }
    }, delay);
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoffDelay(attempt: number): number {
    const delay = this.config.initialRetryDelay * Math.pow(this.config.retryBackoffMultiplier, attempt);
    return Math.min(delay, this.config.maxRetryDelay);
  }

  /**
   * Check deployment status via direct API call
   */
  private async checkDeploymentStatus(deploymentName: string): Promise<void> {
    try {
      const response = await this.k8sApi.appsV1Api.readNamespacedDeployment({
        name: deploymentName,
        namespace: this.config.namespace
      });

      const status = this.parseDeploymentStatus(response.body);
      const callback = this.deploymentCallbacks.get(deploymentName);
      
      if (callback) {
        callback(status);
      }

    } catch (error) {
      console.error(`Failed to check status for ${deploymentName}:`, error);
    }
  }

  /**
   * Parse Kubernetes deployment object into our status format
   */
  private parseDeploymentStatus(deployment: V1Deployment): DeploymentStatus {
    const name = deployment.metadata?.name || '';
    const spec = deployment.spec;
    const status = deployment.status;
    
    const totalReplicas = spec?.replicas || 0;
    const readyReplicas = status?.readyReplicas || 0;
    
    let deploymentStatus: DeploymentStatus['status'] = 'pending';
    let message: string | undefined;

    if (status?.conditions) {
      // Check for failed condition
      const failedCondition = status.conditions.find(c => 
        c.type === "Progressing" && c.status === "False"
      );
      
      if (failedCondition) {
        deploymentStatus = 'failed';
        message = `${failedCondition.reason}: ${failedCondition.message}`;
      } else if (readyReplicas > 0 && readyReplicas === totalReplicas) {
        deploymentStatus = 'ready';
        message = `All ${totalReplicas} replicas ready`;
      }
    }

    return {
      name,
      status: deploymentStatus,
      readyReplicas,
      totalReplicas,
      message,
      lastUpdateTime: new Date()
    };
  }

  /**
   * Stop monitoring a specific deployment
   */
  stopMonitoring(deploymentName: string): void {
    // Clean up watch
    const watch = this.watchers.get(deploymentName);
    if (watch) {
      try {
        // The @kubernetes/client-node Watch class doesn't have a direct stop method
        // but the watch request will be cleaned up when the process ends
        this.watchers.delete(deploymentName);
      } catch (error) {
        console.error(`Error stopping watch for ${deploymentName}:`, error);
      }
    }

    // Clean up callbacks and retry tracking
    this.deploymentCallbacks.delete(deploymentName);
    this.retryAttempts.delete(deploymentName);
    
    console.log(`Stopped monitoring deployment: ${deploymentName}`);
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    return {
      activeWatchers: this.watchers.size,
      activeCallbacks: this.deploymentCallbacks.size,
      deployments: Array.from(this.deploymentCallbacks.keys())
    };
  }

  /**
   * Cleanup all monitoring
   */
  async cleanup(): Promise<void> {
    const deploymentNames = Array.from(this.watchers.keys());
    
    for (const deploymentName of deploymentNames) {
      this.stopMonitoring(deploymentName);
    }
    
    console.log(`Kubernetes monitoring cleanup completed for ${deploymentNames.length} deployments`);
  }
}