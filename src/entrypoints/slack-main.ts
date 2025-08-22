#!/usr/bin/env bun

import { SlackServer } from "../slack/server";
import type { SlackServerConfig } from "../slack/server";

/**
 * Main entry point for the Slack Bolt Application
 * 
 * This serves as the equivalent of the GitHub Actions workflow orchestration
 * but for Slack, coordinating the entire Claude execution flow.
 */

function getEnvVar(name: string, required: boolean = false): string | undefined {
  const value = process.env[name];
  if (required && !value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function parseIntEnvVar(name: string, defaultValue?: number): number | undefined {
  const value = getEnvVar(name);
  if (!value) return defaultValue;
  
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid number, got: ${value}`);
  }
  return parsed;
}

function parseBooleanEnvVar(name: string, defaultValue: boolean = false): boolean {
  const value = getEnvVar(name);
  if (!value) return defaultValue;
  
  return value.toLowerCase() === "true" || value === "1";
}

function parseArrayEnvVar(name: string): string[] | undefined {
  const value = getEnvVar(name);
  if (!value) return undefined;
  
  return value.split(",").map(item => item.trim()).filter(item => item.length > 0);
}

export async function main() {
  try {
    console.log("🚀 Starting Claude Code Slack Application");

    // Validate required environment variables
    const slackToken = getEnvVar("SLACK_BOT_TOKEN", true);
    const appToken = getEnvVar("SLACK_APP_TOKEN");
    const signingSecret = getEnvVar("SLACK_SIGNING_SECRET");

    if (!slackToken) {
      throw new Error("SLACK_BOT_TOKEN is required");
    }

    // Determine if we should use Socket Mode or HTTP
    const useSocketMode = !parseBooleanEnvVar("SLACK_HTTP_MODE", false);
    
    if (useSocketMode && !appToken) {
      console.warn("SLACK_APP_TOKEN is not set, falling back to HTTP mode");
    }

    // Build server configuration
    const config: SlackServerConfig = {
      // Core Slack configuration
      token: slackToken,
      appToken: appToken,
      signingSecret: signingSecret,
      socketMode: useSocketMode && !!appToken,
      port: parseIntEnvVar("PORT", 3000),

      // Bot configuration
      botUserId: getEnvVar("SLACK_BOT_USER_ID"),
      triggerPhrase: getEnvVar("SLACK_TRIGGER_PHRASE") || "@bot",

      // Permissions
      allowDirectMessages: parseBooleanEnvVar("SLACK_ALLOW_DIRECT_MESSAGES", true),
      allowPrivateChannels: parseBooleanEnvVar("SLACK_ALLOW_PRIVATE_CHANNELS", false),
      allowedUsers: parseArrayEnvVar("SLACK_ALLOWED_USERS"),
      blockedUsers: parseArrayEnvVar("SLACK_BLOCKED_USERS"),
      allowedChannels: parseArrayEnvVar("SLACK_ALLOWED_CHANNELS"),
      blockedChannels: parseArrayEnvVar("SLACK_BLOCKED_CHANNELS"),

      // Claude configuration
      claudeOptions: {
        allowedTools: getEnvVar("ALLOWED_TOOLS"),
        disallowedTools: getEnvVar("DISALLOWED_TOOLS"),
        maxTurns: getEnvVar("MAX_TURNS"),
        systemPrompt: getEnvVar("SYSTEM_PROMPT"),
        appendSystemPrompt: getEnvVar("APPEND_SYSTEM_PROMPT"),
        fallbackModel: getEnvVar("FALLBACK_MODEL"),
        model: getEnvVar("MODEL"),
        timeoutMinutes: getEnvVar("TIMEOUT_MINUTES"),
        claudeEnv: getEnvVar("CLAUDE_ENV"),
      },
      customInstructions: getEnvVar("CUSTOM_INSTRUCTIONS"),
      mcpConfigPath: getEnvVar("MCP_CONFIG_PATH"),

      // Features
      enableStatusReactions: parseBooleanEnvVar("ENABLE_STATUS_REACTIONS", true),
      enableProgressUpdates: parseBooleanEnvVar("ENABLE_PROGRESS_UPDATES", true),

      // Environment
      nodeEnv: getEnvVar("NODE_ENV") || "development",
      logLevel: getEnvVar("LOG_LEVEL") as any || "INFO",
    };

    // Log configuration (without sensitive data)
    console.log("Configuration:");
    console.log(`- Mode: ${config.socketMode ? "Socket Mode" : `HTTP on port ${config.port}`}`);
    console.log(`- Trigger Phrase: ${config.triggerPhrase}`);
    console.log(`- Direct Messages: ${config.allowDirectMessages ? "Allowed" : "Blocked"}`);
    console.log(`- Private Channels: ${config.allowPrivateChannels ? "Allowed" : "Blocked"}`);
    console.log(`- Status Reactions: ${config.enableStatusReactions ? "Enabled" : "Disabled"}`);
    console.log(`- Progress Updates: ${config.enableProgressUpdates ? "Enabled" : "Disabled"}`);
    console.log(`- Environment: ${config.nodeEnv}`);

    if (config.allowedUsers?.length) {
      console.log(`- Allowed Users: ${config.allowedUsers.length} users`);
    }
    if (config.blockedUsers?.length) {
      console.log(`- Blocked Users: ${config.blockedUsers.length} users`);
    }
    if (config.allowedChannels?.length) {
      console.log(`- Allowed Channels: ${config.allowedChannels.length} channels`);
    }
    if (config.blockedChannels?.length) {
      console.log(`- Blocked Channels: ${config.blockedChannels.length} channels`);
    }

    // Create and start the server
    const server = new SlackServer(config);
    await server.start();

    // Log successful startup
    console.log("✅ Claude Code Slack Application is running!");
    console.log("Ready to receive Slack mentions and messages.");

    // Handle process signals for health monitoring
    process.on("SIGUSR1", () => {
      const status = server.getStatus();
      console.log("Status check:", JSON.stringify(status, null, 2));
    });

  } catch (error) {
    console.error("❌ Failed to start Claude Code Slack Application:", error);
    process.exit(1);
  }
}

// Handle uncaught exceptions and rejections
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start the application
if (import.meta.main) {
  main();
}