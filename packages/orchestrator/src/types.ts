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
  githubUsername: string;
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
  claudeSessionId?: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
  createdAt: Date;
}

export interface WorkerDeploymentRequest {
  sessionKey: string;
  botId: string;
  userId: string;
  username: string;
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
    threadMessage: string;
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

export class OrchestratorError extends Error {
  constructor(
    public operation: string,
    message: string,
    public cause?: Error
  ) {
    super(`[${operation}] ${message}`);
    this.name = 'OrchestratorError';
    
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}