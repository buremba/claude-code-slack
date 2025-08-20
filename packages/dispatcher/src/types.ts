#!/usr/bin/env bun

import type { LogLevel } from "@slack/bolt";
import type { ClaudeExecutionOptions } from "@claude-code-slack/core-runner";

export interface SlackConfig {
  token: string;
  appToken?: string;
  signingSecret?: string;
  socketMode?: boolean;
  port?: number;
  botUserId?: string;
  botId?: string;
  allowedUsers?: string[];
  allowedChannels?: string[];
  blockedUsers?: string[];
  blockedChannels?: string[];
  allowDirectMessages?: boolean;
  allowPrivateChannels?: boolean;
}

export interface KubernetesConfig {
  namespace: string;
  workerImage: string;
  cpu: string;
  memory: string;
  timeoutSeconds: number;
  kubeconfig?: string;
}

export interface GitHubConfig {
  token: string;
  organization: string;
  repoTemplate?: string;
}

export interface DispatcherConfig {
  slack: SlackConfig;
  kubernetes: KubernetesConfig;
  github: GitHubConfig;
  claude: Partial<ClaudeExecutionOptions>;
  sessionTimeoutMinutes: number;
  logLevel?: LogLevel;
}

export interface SlackContext {
  channelId: string;
  userId: string;
  userDisplayName?: string;
  teamId: string;
  threadTs?: string;
  messageTs: string;
  text: string;
  messageUrl?: string;
}

export interface WorkerJobRequest {
  sessionKey: string;
  userId: string;
  username: string;
  channelId: string;
  threadTs?: string;
  userPrompt: string;
  repositoryUrl: string;
  slackResponseChannel: string;
  slackResponseTs: string;
  originalMessageTs?: string; // Original user message timestamp for reactions
  claudeOptions: ClaudeExecutionOptions;
  resumeSessionId?: string; // Claude session ID to resume from
}

export interface ThreadSession {
  sessionKey: string;
  threadTs?: string;
  channelId: string;
  userId: string;
  username: string;
  jobName?: string;
  repositoryUrl: string;
  claudeSessionId?: string; // Claude session ID for resumption
  lastActivity: number;
  status: "pending" | "starting" | "running" | "completed" | "error" | "timeout";
  createdAt: number;
}

export interface UserRepository {
  username: string;
  repositoryName: string;
  repositoryUrl: string;
  cloneUrl: string;
  createdAt: number;
  lastUsed: number;
}

// Kubernetes Job template data
export interface JobTemplateData {
  jobName: string;
  namespace: string;
  workerImage: string;
  cpu: string;
  memory: string;
  timeoutSeconds: number;
  sessionKey: string;
  userId: string;
  username: string;
  channelId: string;
  threadTs?: string;
  repositoryUrl: string;
  userPrompt: string;
  slackResponseChannel: string;
  slackResponseTs: string;
  originalMessageTs?: string; // Original user message timestamp for reactions
  claudeOptions: string; // JSON string
  resumeSessionId?: string; // Claude session ID to resume from
  // Environment variables from config
  slackToken: string;
  githubToken: string;
}

// Error types
export class DispatcherError extends Error {
  constructor(
    public operation: string,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = "DispatcherError";
  }
}

export class KubernetesError extends Error {
  constructor(
    public operation: string,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = "KubernetesError";
  }
}

export class GitHubRepositoryError extends Error {
  constructor(
    public operation: string,
    public username: string,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = "GitHubRepositoryError";
  }
}