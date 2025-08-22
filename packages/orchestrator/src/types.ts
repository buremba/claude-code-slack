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
    workerImage: string;
    cpu: string;
    memory: string;
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
  pgboss: {
    connectionString: string;
    retryLimit: number;
    retryDelay: number;
    expireInHours: number;
  };
  queues: {
    directMessage: string;
    messageQueue: string;
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
  DATABASE_CONNECTION_FAILED = 'DATABASE_CONNECTION_FAILED',
  JOB_PROCESSING_FAILED = 'JOB_PROCESSING_FAILED',
  KUBERNETES_API_ERROR = 'KUBERNETES_API_ERROR',
  DEPLOYMENT_CREATION_FAILED = 'DEPLOYMENT_CREATION_FAILED',
  DEPLOYMENT_MONITORING_FAILED = 'DEPLOYMENT_MONITORING_FAILED',
  RLS_CONTEXT_FAILED = 'RLS_CONTEXT_FAILED',
  QUEUE_CONNECTION_FAILED = 'QUEUE_CONNECTION_FAILED',
}

export class OrchestratorError extends Error {
  constructor(
    public operation: string,
    public errorCode: ErrorCode,
    message: string,
    public cause?: Error,
    public retryable: boolean = false
  ) {
    super(`[${operation}:${errorCode}] ${message}`);
    this.name = 'OrchestratorError';
    
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }

  static databaseError(operation: string, cause: Error): OrchestratorError {
    return new OrchestratorError(
      operation,
      ErrorCode.DATABASE_CONNECTION_FAILED,
      `Database operation failed: ${cause.message}`,
      cause,
      true // Database errors are often retryable
    );
  }

  static kubernetesError(operation: string, cause: Error): OrchestratorError {
    return new OrchestratorError(
      operation,
      ErrorCode.KUBERNETES_API_ERROR,
      `Kubernetes API error: ${cause.message}`,
      cause,
      true // K8s API errors are often retryable
    );
  }

  static deploymentError(operation: string, message: string, retryable: boolean = false): OrchestratorError {
    return new OrchestratorError(
      operation,
      ErrorCode.DEPLOYMENT_CREATION_FAILED,
      message,
      undefined,
      retryable
    );
  }
}