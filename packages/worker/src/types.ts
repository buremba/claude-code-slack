#!/usr/bin/env bun

import type { SlackTokenManager } from "./slack/token-manager";

export enum WorkerMode {
  oneshot = "oneshot",
  persistent = "persistent"
}

export enum WorkerState {
  idle = "idle",
  busy = "busy",
  shutting_down = "shutting_down"
}

export interface WorkerConfig {
  sessionKey: string;
  userId: string;
  username: string;
  channelId: string;
  threadTs?: string;
  repositoryUrl: string;
  userPrompt: string; // Base64 encoded
  slackResponseChannel: string;
  slackResponseTs: string;
  claudeOptions: string; // JSON string
  conversationHistory?: string; // JSON string
  mode: WorkerMode;
  timeoutMinutes: number;
  httpPort: number;
  slack: {
    token: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
  };
  workspace: {
    baseDirectory: string;
    githubToken: string;
  };
}

export interface WorkspaceSetupConfig {
  baseDirectory: string;
  githubToken: string;
}

export interface SlackConfig {
  token: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  tokenManager?: SlackTokenManager;
}

export interface GitRepository {
  url: string;
  branch: string;
  directory: string;
  lastCommit?: string;
}

export interface WorkspaceInfo {
  baseDirectory: string;
  userDirectory: string;
  repository: GitRepository;
  setupComplete: boolean;
}

// Error types
export class WorkerError extends Error {
  constructor(
    public operation: string,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

export class WorkspaceError extends Error {
  constructor(
    public operation: string,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export class SlackError extends Error {
  constructor(
    public operation: string,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = "SlackError";
  }
}

// Task request and response types for HTTP communication
export interface TaskRequest {
  sessionKey: string;
  userId: string;
  username: string;
  channelId: string;
  threadTs?: string;
  userPrompt: string;
  repositoryUrl: string;
  slackResponseChannel: string;
  slackResponseTs: string;
  originalMessageTs?: string;
  claudeOptions: any;
  conversationHistory?: Array<{ role: string; content: string; timestamp: number }>;
}

export interface TaskResponse {
  success: boolean;
  message: string;
  taskId?: string;
}