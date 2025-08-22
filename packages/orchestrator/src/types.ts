#!/usr/bin/env bun

/**
 * Type definitions for orchestrator service
 */

export interface BotConfig {
  botId: string;
  platform: string;
  name: string;
  tokenHash?: string;
  isActive: boolean;
}

export interface DirectMessageJob {
  jobId: string;
  botId: string;
  userId: string;
  platform: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  messageText: string;
  repositoryUrl: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
  createdAt: Date;
}

export interface ThreadMessageJob {
  jobId: string;
  botId: string;
  userId: string;
  threadId: string;
  platform: string;
  channelId: string;
  messageId: string;
  messageText: string;
  agentSessionId?: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
  createdAt: Date;
}

export interface WorkerDeploymentRequest {
  sessionKey: string;
  botId: string;
  userId: string;
  channelId: string;
  threadId: string;
  repositoryUrl: string;
  initialMessage: DirectMessageJob;
}

export interface OrchestratorConfig {
  kubernetes: {
    namespace: string;
    image: string;
    cpu: string;
    memory: string;
    pullPolicy: 'Always' | 'IfNotPresent' | 'Never';
    nodeSelector: { [key: string]: string };
    tolerations: any[];
    affinity: any;
    kubeconfig?: string;
  };
  database: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    ssl?: boolean;
  };
  queues: {
    directMessage: string;
    messageQueue: string;
    concurrency: number;
    retryLimit: number;
    retryDelay: number;
    archiveCompletedAfterSeconds: number;
  };
  server: {
    port: number;
    host: string;
    logLevel: 'error' | 'warn' | 'info' | 'debug';
    healthCheckPath: string;
    metricsPath: string;
  };
  monitoring: {
    enabled: boolean;
    namespace: string;
    maxRetries: number;
    initialRetryDelay: number;
    maxRetryDelay: number;
    retryBackoffMultiplier: number;
  };
  recovery: {
    enabled: boolean;
    namespace: string;
    labelSelectors: { [key: string]: string };
    maxAge: number;
    recoveryInterval: number;
  };
  secrets: {
    secretName: string;
    userSecretPrefix: string;
    passwordSecretPrefix: string;
    externalSecretOperator: boolean;
    externalSecretStore: string;
  };
}

export interface JobStatus {
  jobId: string;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'retrying';
  retryCount: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  error?: string;
}

export enum ErrorCode {
  DATABASE_ERROR = 'DATABASE_ERROR',
  DATABASE_CONNECTION_FAILED = 'DATABASE_CONNECTION_FAILED',
  JOB_PROCESSING_FAILED = 'JOB_PROCESSING_FAILED',
  KUBERNETES_ERROR = 'KUBERNETES_ERROR',
  KUBERNETES_API_ERROR = 'KUBERNETES_API_ERROR',
  DEPLOYMENT_CREATION_FAILED = 'DEPLOYMENT_CREATION_FAILED',
  DEPLOYMENT_MONITORING_FAILED = 'DEPLOYMENT_MONITORING_FAILED',
  DEPLOYMENT_RECOVERY_FAILED = 'DEPLOYMENT_RECOVERY_FAILED',
  RLS_CONTEXT_FAILED = 'RLS_CONTEXT_FAILED',
  QUEUE_CONNECTION_FAILED = 'QUEUE_CONNECTION_FAILED',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

export class OrchestratorError extends Error {
  constructor(
    public errorCode: ErrorCode,
    message: string,
    public cause?: Error,
    public context?: Record<string, any>
  ) {
    super(`[${errorCode}] ${message}`);
    this.name = 'OrchestratorError';
    
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }

  static databaseError(operation: string, cause: Error): OrchestratorError {
    return new OrchestratorError(
      ErrorCode.DATABASE_ERROR,
      `Database operation failed in ${operation}: ${cause.message}`,
      cause,
      { operation }
    );
  }

  static kubernetesError(operation: string, cause: Error): OrchestratorError {
    return new OrchestratorError(
      ErrorCode.KUBERNETES_ERROR,
      `Kubernetes API error in ${operation}: ${cause.message}`,
      cause,
      { operation }
    );
  }

  static deploymentError(operation: string, message: string, context?: Record<string, any>): OrchestratorError {
    return new OrchestratorError(
      ErrorCode.DEPLOYMENT_CREATION_FAILED,
      `Deployment error in ${operation}: ${message}`,
      undefined,
      { operation, ...context }
    );
  }

  static configurationError(message: string, context?: Record<string, any>): OrchestratorError {
    return new OrchestratorError(
      ErrorCode.CONFIGURATION_ERROR,
      `Configuration error: ${message}`,
      undefined,
      context
    );
  }

  static validationError(message: string, context?: Record<string, any>): OrchestratorError {
    return new OrchestratorError(
      ErrorCode.VALIDATION_ERROR,
      `Validation error: ${message}`,
      undefined,
      context
    );
  }

  /**
   * Determine if this error should be retried
   */
  get isRetryable(): boolean {
    return [
      ErrorCode.DATABASE_CONNECTION_FAILED,
      ErrorCode.KUBERNETES_API_ERROR,
      ErrorCode.DEPLOYMENT_MONITORING_FAILED,
      ErrorCode.QUEUE_CONNECTION_FAILED,
    ].includes(this.errorCode);
  }

  /**
   * Get error severity level
   */
  get severity(): 'low' | 'medium' | 'high' | 'critical' {
    switch (this.errorCode) {
      case ErrorCode.CONFIGURATION_ERROR:
      case ErrorCode.VALIDATION_ERROR:
        return 'critical';
      case ErrorCode.DATABASE_ERROR:
      case ErrorCode.DATABASE_CONNECTION_FAILED:
        return 'high';
      case ErrorCode.KUBERNETES_ERROR:
      case ErrorCode.DEPLOYMENT_CREATION_FAILED:
        return 'high';
      case ErrorCode.DEPLOYMENT_RECOVERY_FAILED:
      case ErrorCode.DEPLOYMENT_MONITORING_FAILED:
        return 'medium';
      default:
        return 'low';
    }
  }
}