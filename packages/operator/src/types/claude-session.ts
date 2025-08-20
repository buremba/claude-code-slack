import { KubernetesObject } from "@kubernetes/client-node";

export interface ClaudeSessionSpec {
  sessionKey: string;
  userId: string;
  username: string;
  channelId: string;
  threadTs?: string;
  repositoryUrl: string;
  userPrompt: string; // base64 encoded
  slackResponseChannel: string;
  slackResponseTs: string;
  originalMessageTs?: string;
  claudeOptions: string; // JSON string
  resumeSessionId?: string;
  resources?: {
    cpu?: string;
    memory?: string;
  };
  timeoutSeconds?: number;
}

export interface ClaudeSessionStatus {
  phase?: "Pending" | "Running" | "Succeeded" | "Failed" | "Terminated";
  podName?: string;
  containerName?: string;
  startTime?: string;
  completionTime?: string;
  message?: string;
  conditions?: ClaudeSessionCondition[];
}

export interface ClaudeSessionCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  lastTransitionTime: string;
  reason?: string;
  message?: string;
}

export interface ClaudeSession extends KubernetesObject {
  apiVersion: "claude.ai/v1";
  kind: "ClaudeSession";
  spec: ClaudeSessionSpec;
  status?: ClaudeSessionStatus;
}

// Rate limiting types
export interface RateLimitEntry {
  count: number;
  windowStart: number;
}