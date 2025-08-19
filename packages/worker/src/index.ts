#!/usr/bin/env bun

import { ClaudeSessionRunner } from "@claude-code-slack/core-runner";
import { WorkspaceManager } from "./workspace-setup";
import { SlackIntegration } from "./slack-integration";
import { SlackTokenManager } from "./slack/token-manager";
import { extractFinalResponse } from "./claude-output-parser";
import { WorkerHttpServer } from "./http-server";
import type { WorkerConfig, WorkerMode, WorkerState, TaskRequest, TaskResponse } from "./types";
import logger from "./logger";

export class ClaudeWorker {
  private sessionRunner: ClaudeSessionRunner;
  private workspaceManager: WorkspaceManager;
  private slackIntegration: SlackIntegration;
  private config: WorkerConfig;
  private tokenManager?: SlackTokenManager;
  private autoPushInterval?: NodeJS.Timeout;
  
  // Persistent mode properties
  private workerState: WorkerState = WorkerState.idle;
  private timeoutTimer?: NodeJS.Timeout;
  private httpServer?: WorkerHttpServer;

  constructor(config: WorkerConfig) {
    this.config = config;

    // Initialize components
    this.sessionRunner = new ClaudeSessionRunner();

    this.workspaceManager = new WorkspaceManager(config.workspace);
    
    // Initialize token manager if refresh token is available
    if (config.slack.refreshToken && config.slack.clientId && config.slack.clientSecret) {
      this.tokenManager = new SlackTokenManager(
        config.slack.clientId,
        config.slack.clientSecret,
        config.slack.refreshToken,
        config.slack.token
      );
      
      // Initialize Slack integration with token manager
      this.slackIntegration = new SlackIntegration({
        ...config.slack,
        tokenManager: this.tokenManager
      });
    } else {
      this.slackIntegration = new SlackIntegration(config.slack);
    }
  }

  /**
   * Start automatic git push interval
   */
  private startAutoPush(): void {
    // Check and push changes every 30 seconds
    this.autoPushInterval = setInterval(async () => {
      try {
        const status = await this.workspaceManager.getRepositoryStatus();
        if (status.hasChanges) {
          logger.info("Auto-push: Detected changes, committing and pushing...");
          await this.workspaceManager.commitAndPush(
            `Auto-save: ${status.changedFiles.length} file(s) modified`
          );
          logger.info("Auto-push: Changes pushed successfully");
        }
      } catch (error) {
        logger.warn("Auto-push failed:", error);
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop automatic git push interval
   */
  private stopAutoPush(): void {
    if (this.autoPushInterval) {
      clearInterval(this.autoPushInterval);
      this.autoPushInterval = undefined;
    }
  }

  /**
   * Check if this is a simple query that doesn't need repository access
   */
  private isSimpleQuery(prompt: string): boolean {
    // Simple queries are typically short and don't mention files/code
    const lowerPrompt = prompt.toLowerCase();
    
    // Keywords that indicate need for repository
    const needsRepoKeywords = [
      'file', 'code', 'function', 'class', 'method', 'variable',
      'repository', 'repo', 'git', 'commit', 'branch', 'pull request',
      'pr', 'implement', 'fix', 'bug', 'feature', 'refactor', 'test',
      'build', 'compile', 'run', 'execute', 'debug', 'deploy',
      'create', 'add', 'update', 'modify', 'change', 'edit'
    ];
    
    // Check if prompt is short and doesn't contain repo-related keywords
    const isShort = prompt.length < 100;
    const hasRepoKeywords = needsRepoKeywords.some(keyword => 
      lowerPrompt.includes(keyword)
    );
    
    return isShort && !hasRepoKeywords;
  }

  /**
   * Start persistent mode
   */
  private async startPersistentMode(): Promise<void> {
    logger.info(`Starting worker in persistent mode on port ${this.config.httpPort}`);
    
    // Create HTTP server
    this.httpServer = new WorkerHttpServer(
      this.config.httpPort,
      this.handleTaskRequest.bind(this),
      () => this.workerState
    );
    
    // Start HTTP server
    await this.httpServer.start();
    
    // Start idle timeout
    this.startIdleTimeout();
    
    logger.info("Worker is now running in persistent mode");
  }

  /**
   * Handle task request from HTTP server
   */
  private async handleTaskRequest(taskData: TaskRequest): Promise<TaskResponse> {
    try {
      logger.info(`Received task request for session: ${taskData.sessionKey}`);
      
      // Update worker state
      this.workerState = WorkerState.busy;
      this.resetIdleTimeout();
      
      // Update config with new task data
      this.updateConfigFromTask(taskData);
      
      // Execute the task
      await this.executeTask();
      
      // Set state back to idle and reset timeout
      this.workerState = WorkerState.idle;
      this.startIdleTimeout();
      
      return {
        success: true,
        message: "Task completed successfully",
        taskId: taskData.sessionKey
      };
    } catch (error) {
      logger.error("Error handling task request:", error);
      this.workerState = WorkerState.idle;
      this.startIdleTimeout();
      
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
        taskId: taskData.sessionKey
      };
    }
  }

  /**
   * Update config from task request
   */
  private updateConfigFromTask(taskData: TaskRequest): void {
    // Store conversation locally instead of using env var
    const conversationPath = this.getConversationPath(taskData.sessionKey);
    this.storeConversation(conversationPath, taskData.conversationHistory || []);
    
    // Update relevant config fields - note: we don't update userPrompt via env
    // Instead, we'll pass it directly to the execution
    this.config.userPrompt = Buffer.from(taskData.userPrompt).toString("base64");
    this.config.slackResponseChannel = taskData.slackResponseChannel;
    this.config.slackResponseTs = taskData.slackResponseTs;
    this.config.channelId = taskData.channelId;
    this.config.userId = taskData.userId;
    this.config.username = taskData.username;
    this.config.threadTs = taskData.threadTs;
    this.config.repositoryUrl = taskData.repositoryUrl;
    this.config.claudeOptions = JSON.stringify(taskData.claudeOptions);
  }

  /**
   * Get conversation storage path
   */
  private getConversationPath(sessionKey: string): string {
    return `/workspace/.claude/projects/${this.config.userId}/${sessionKey}.jsonl`;
  }

  /**
   * Store conversation history to file
   */
  private storeConversation(conversationPath: string, history: Array<{ role: string; content: string; timestamp: number }>): void {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Ensure directory exists
      fs.mkdirSync(path.dirname(conversationPath), { recursive: true });
      
      // Write conversation history as JSONL
      const jsonlContent = history.map(msg => JSON.stringify(msg)).join('\n');
      fs.writeFileSync(conversationPath, jsonlContent);
      
      logger.info(`Stored conversation history to ${conversationPath}`);
    } catch (error) {
      logger.error("Failed to store conversation history:", error);
    }
  }

  /**
   * Load conversation history from file
   */
  private loadConversation(conversationPath: string): Array<{ role: string; content: string; timestamp: number }> {
    try {
      const fs = require('fs');
      
      if (!fs.existsSync(conversationPath)) {
        return [];
      }
      
      const content = fs.readFileSync(conversationPath, 'utf8');
      if (!content.trim()) {
        return [];
      }
      
      return content.split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch (error) {
      logger.error("Failed to load conversation history:", error);
      return [];
    }
  }

  /**
   * Start idle timeout
   */
  private startIdleTimeout(): void {
    this.clearIdleTimeout();
    
    const timeoutMs = this.config.timeoutMinutes * 60 * 1000;
    this.timeoutTimer = setTimeout(() => {
      logger.info(`Idle timeout reached (${this.config.timeoutMinutes} minutes), shutting down worker`);
      this.shutdown();
    }, timeoutMs);
    
    logger.info(`Started ${this.config.timeoutMinutes}min idle timeout`);
  }

  /**
   * Reset idle timeout
   */
  private resetIdleTimeout(): void {
    this.clearIdleTimeout();
    this.startIdleTimeout();
  }

  /**
   * Clear idle timeout
   */
  private clearIdleTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  /**
   * Shutdown worker gracefully
   */
  private async shutdown(): Promise<void> {
    logger.info("Shutting down worker...");
    this.workerState = WorkerState.shutting_down;
    
    // Clear timeout
    this.clearIdleTimeout();
    
    // Stop HTTP server
    if (this.httpServer) {
      await this.httpServer.stop();
    }
    
    // Cleanup resources
    await this.cleanup();
    
    // Exit process
    process.exit(0);
  }

  /**
   * Execute task (extracted from execute method)
   */
  private async executeTask(): Promise<void> {
    // Implementation will be the core of the existing execute method
    // We'll modify execute() to call this method
    await this.executeTaskInternal();
  }

  /**
   * Execute the worker job
   */
  async execute(): Promise<void> {
    // Check if we're in persistent mode
    if (this.config.mode === WorkerMode.persistent) {
      await this.startPersistentMode();
      // In persistent mode, we don't exit - the server keeps running
      return;
    }
    
    // Original one-shot execution
    await this.executeTaskInternal();
  }

  /**
   * Internal task execution logic
   */
  private async executeTaskInternal(): Promise<void> {
    const executeStartTime = Date.now();
    // Get original message timestamp for reactions (defined outside try block)
    const originalMessageTs = process.env.ORIGINAL_MESSAGE_TS;
    
    try {
      logger.info(`🚀 Starting Claude worker for session: ${this.config.sessionKey}`);
      logger.info(`[TIMING] Worker execute() started at: ${new Date(executeStartTime).toISOString()}`);
      
      // Add "gear" reaction to indicate worker is running
      if (originalMessageTs) {
        logger.info(`Adding gear reaction to message ${originalMessageTs}`);
        await this.slackIntegration.removeReaction("eyes", originalMessageTs);
        await this.slackIntegration.addReaction("gear", originalMessageTs);
      }
      
      // Create initial context block without branch URLs (branch doesn't exist yet)
      let contextBlock = {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `🔖 ${this.config.sessionKey}`
          },
          {
            type: "mrkdwn",
            text: `📁 ${this.config.username}`
          },
          {
            type: "mrkdwn",
            text: `🔀 Setting up...`
          },
          {
            type: "mrkdwn",
            text: `📂 /workspace/${this.config.username}`
          }
        ]
      };
      
      // Set initial context block
      this.slackIntegration.setContextBlock(contextBlock);
      
      // Decode user prompt first
      const userPrompt = Buffer.from(this.config.userPrompt, "base64").toString("utf-8");
      logger.info(`User prompt: ${userPrompt.substring(0, 100)}...`);
      
      // Check if this is a simple query that doesn't need repository
      const isSimpleQuery = this.isSimpleQuery(userPrompt);
      
      if (!isSimpleQuery) {
        // Update initial Slack message with simple status
        await this.slackIntegration.updateProgress("💻 Setting up workspace...");

        // Setup workspace
        logger.info("Setting up workspace...");
        await this.workspaceManager.setupWorkspace(
          this.config.repositoryUrl,
          this.config.username,
          this.config.sessionKey
        );
        
        // Create or checkout session branch
        logger.info("Setting up session branch...");
        await this.workspaceManager.createSessionBranch(this.config.sessionKey);
        
        // Now that branch exists, update context block with proper URLs
        const branchName = `claude/${this.config.sessionKey.replace(/\./g, "-")}`;
        const pwd = process.cwd();
        
        contextBlock = {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `🔖 ${this.config.sessionKey}`
            },
            {
              type: "mrkdwn",
              text: `📁 <${this.config.repositoryUrl.replace('github.com', 'github.dev')}/tree/${branchName}|${this.config.username}>`
            },
            {
              type: "mrkdwn",
              text: `🔀 <${this.config.repositoryUrl}/compare/main...${branchName}|Create Pull Request>`
            },
            {
              type: "mrkdwn",
              text: `📂 ${pwd}`
            }
          ]
        };
        
        // Update context block with proper URLs
        this.slackIntegration.setContextBlock(contextBlock);
        
        // Start automatic git push
        logger.info("Starting automatic git push monitoring...");
        this.startAutoPush();
      } else {
        logger.info("Skipping workspace setup for simple query");
        // Create a minimal workspace directory
        const fs = await import('fs/promises');
        const path = await import('path');
        const workspaceDir = path.join('/workspace', this.config.username);
        await fs.mkdir(workspaceDir, { recursive: true });
        process.chdir(workspaceDir);
      }

      // Update progress with simple status
      await this.slackIntegration.updateProgress("🚀 Starting Claude session...");

      // Parse conversation history 
      let conversationHistory: Array<{ role: string; content: string; timestamp: number }>;
      
      if (this.config.mode === WorkerMode.persistent) {
        // In persistent mode, load from file
        const conversationPath = this.getConversationPath(this.config.sessionKey);
        conversationHistory = this.loadConversation(conversationPath);
      } else {
        // In one-shot mode, use env var
        conversationHistory = this.config.conversationHistory 
          ? JSON.parse(this.config.conversationHistory)
          : [];
      }
      
      logger.info(`Loaded ${conversationHistory.length} messages from conversation history`);

      // Prepare session context with conversation history
      const sessionContext = {
        platform: "slack" as const,
        channelId: this.config.channelId,
        userId: this.config.userId,
        userDisplayName: this.config.username,
        threadTs: this.config.threadTs,
        messageTs: this.config.slackResponseTs,
        repositoryUrl: this.config.repositoryUrl,
        workingDirectory: `/workspace/${this.config.username}`,
        customInstructions: this.generateCustomInstructions(),
        conversationHistory, // Include the parsed conversation history
      };

      // Execute Claude session with conversation history
      logger.info(`[TIMING] Starting Claude session at: ${new Date().toISOString()}`);
      const claudeStartTime = Date.now();
      logger.info(`[TIMING] Total worker startup time: ${claudeStartTime - executeStartTime}ms`);
      
      let firstOutputLogged = false;
      const result = await this.sessionRunner.executeSession({
        sessionKey: this.config.sessionKey,
        userPrompt,
        context: sessionContext,
        options: JSON.parse(this.config.claudeOptions),
        // No recovery options needed - conversation history is already in context
        onProgress: async (update) => {
          // Log timing for first output
          if (!firstOutputLogged && update.type === "output") {
            logger.info(`[TIMING] First Claude output at: ${new Date().toISOString()} (${Date.now() - claudeStartTime}ms after Claude start)`);
            firstOutputLogged = true;
          }
          // Stream progress to Slack
          if (update.type === "output" && update.data) {
            await this.slackIntegration.streamProgress(update.data);
          }
        },
      });

      // Handle final result
      
      logger.info("=== FINAL RESULT DEBUG ===");
      logger.info("result.success:", result.success);
      logger.info("result.output exists:", !!result.output);
      logger.info("result.output length:", result.output?.length);
      logger.info("result.output sample:", result.output?.substring(0, 300));
      logger.info("About to update Slack...");
      
      // Stop auto-push before final operations
      this.stopAutoPush();
      
      // Do a final push of any remaining changes
      try {
        const status = await this.workspaceManager.getRepositoryStatus();
        if (status.hasChanges) {
          logger.info("Final push: Committing remaining changes...");
          await this.workspaceManager.commitAndPush(
            `Session complete: ${status.changedFiles.length} file(s) modified`
          );
        }
      } catch (pushError) {
        logger.warn("Final push failed:", pushError);
      }
      
      if (result.success) {
        logger.info("Calling slackIntegration.updateProgress...");
        // Update with Claude's response and completion status
        const claudeResponse = this.formatClaudeResponse(result.output);
        if (claudeResponse) {
          await this.slackIntegration.updateProgress(claudeResponse);
        } else {
          await this.slackIntegration.updateProgress("✅ Completed");
        }
        
        // Update reaction to success
        logger.info(`Updating reaction to success. originalMessageTs: ${originalMessageTs}`);
        if (originalMessageTs) {
          logger.info(`Removing gear and adding check mark reaction to ${originalMessageTs}`);
          await this.slackIntegration.removeReaction("gear", originalMessageTs);
          await this.slackIntegration.addReaction("white_check_mark", originalMessageTs);
        } else {
          logger.info('No originalMessageTs found, skipping reaction update');
        }
      } else {
        const errorMsg = result.error || "Unknown error";
        await this.slackIntegration.updateProgress(
          `❌ Session failed: ${errorMsg}`
        );
        
        // Update reaction to error
        if (originalMessageTs) {
          await this.slackIntegration.removeReaction("gear", originalMessageTs);
          await this.slackIntegration.addReaction("x", originalMessageTs);
        }
      }

      logger.info(`Worker completed with ${result.success ? "success" : "failure"}`);

    } catch (error) {
      logger.error("Worker execution failed:", error);
      
      // Stop auto-push on error
      this.stopAutoPush();
      
      // Try to push any pending changes before failing
      try {
        const status = await this.workspaceManager.getRepositoryStatus();
        if (status?.hasChanges) {
          await this.workspaceManager.commitAndPush(
            `Session error: Saving ${status.changedFiles.length} file(s) before exit`
          );
        }
      } catch (pushError) {
        logger.warn("Error push failed:", pushError);
      }
      
      // Update Slack with error
      await this.slackIntegration.updateProgress(
        `💥 Worker crashed: ${error instanceof Error ? error.message : "Unknown error"}`
      ).catch(slackError => {
        logger.error("Failed to update Slack with error:", slackError);
      });
      
      // Update reaction to error
      const originalMessageTs = process.env.ORIGINAL_MESSAGE_TS;
      if (originalMessageTs) {
        await this.slackIntegration.removeReaction("gear", originalMessageTs).catch(() => {});
        await this.slackIntegration.removeReaction("eyes", originalMessageTs).catch(() => {});
        await this.slackIntegration.addReaction("x", originalMessageTs).catch(() => {});
      }

      // Re-throw to ensure container exits with error code
      throw error;
    }
  }

  /**
   * Generate custom instructions for Claude
   */
  private generateCustomInstructions(): string {
    return `
You are Claude Code running in a pod on K8S for user ${this.config.username}. 
You MUST generate Markdown content that will be rendered in user's messaging app. Here is fence code blocks feature:
- You can add \`action\` to the code block to indicate a button should be rendered at the end of the message to trigger the action with its label. You must have at least one or more blocks with action_id for the user to take action from your message as the next steps.
- The \`confirm\` flag enables a dialog to be shown the user before the action is executed. 
- The \`show\` flag enables the content to be shown to the user.
- The blockkit type will be rendered natively in Slack. The action_id supports following types:
1. blockkit: Renders the native Slack components. Use it to collect input from the user in a structured way when confirm is true and show is false. If the value of show is true, the content will be rendered in the message, don't use it if you use inputs, checkboxes, or and user inputs.
2. bash/shell: Runs the script in the container.
3. python: Uses \`uv\` to install dependencies and run the script. You MUST use shebang on top of the script to define dependencies if the project is not a Python project. 
5. javascript/typescript: Runs the script in the container via \`bun run\`.

\`\`\`blockkit { action: "Example Button", confirm: false, show: false }
{
  "blocks": [
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": "Click Me"
          },
          "action_id": "button_click"
        }
      ]
    }
  ]
  }
\`\`\`

**Environment:**
- Working in: /workspace/${this.config.username}  
- Repository: ${this.config.repositoryUrl}
- Session: ${this.config.sessionKey}

**Important guidelines:**
- You're working on branch: claude/${this.config.sessionKey.replace(/\./g, "-")}
- Focus on solving the user's specific request
- If you make any changes to the files, let the user know that they can click "Create Pull Request" button to review and merge the changes. All file changes are automatically saved and pushed to GitHub after you're done.

**Session context:**
This is ${this.config.threadTs ? "a continued conversation in a thread" : "a new conversation"}.`
.trim();
  }


  private formatClaudeResponse(output: string | undefined): string {
    logger.info("=== formatClaudeResponse DEBUG ===");
    logger.info(`output exists? ${!!output}`);
    logger.info(`output length: ${output?.length}`);
    logger.info(`output first 200 chars: ${output?.substring(0, 200)}`);
    
    if (!output) {
      return "";
    }
    
    const extracted = extractFinalResponse(output);
    logger.info(`extracted response: ${extracted}`);
    logger.info(`extracted length: ${extracted.length}`);
    
    // Return the raw extracted markdown - slack-integration will handle conversion
    return extracted || "";
  }

  /**
   * Cleanup worker resources
   */
  async cleanup(): Promise<void> {
    try {
      logger.info("Cleaning up worker resources...");
      
      // Stop auto-push if still running
      this.stopAutoPush();
      
      // Cleanup session runner
      await this.sessionRunner.cleanupSession(this.config.sessionKey);
      
      // Cleanup workspace (this also does a final commit/push)
      await this.workspaceManager.cleanup();
      
      logger.info("Worker cleanup completed");
    } catch (error) {
      logger.error("Error during cleanup:", error);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const workerStartTime = Date.now();
  let worker: ClaudeWorker | null = null;
  
  try {
    logger.info("🚀 Starting Claude Code Worker");
    logger.info(`[TIMING] Worker process started at: ${new Date(workerStartTime).toISOString()}`);

    // Load configuration from environment
    const workerMode = (process.env.WORKER_MODE as WorkerMode) || WorkerMode.oneshot;
    const timeoutMinutes = parseInt(process.env.WORKER_TIMEOUT_MINUTES || "5");
    const httpPort = parseInt(process.env.WORKER_HTTP_PORT || "8080");
    
    const config: WorkerConfig = {
      sessionKey: process.env.SESSION_KEY!,
      userId: process.env.USER_ID!,
      username: process.env.USERNAME!,
      channelId: process.env.CHANNEL_ID!,
      threadTs: process.env.THREAD_TS || undefined,
      repositoryUrl: process.env.REPOSITORY_URL!,
      userPrompt: process.env.USER_PROMPT || "", // May be empty in persistent mode
      slackResponseChannel: process.env.SLACK_RESPONSE_CHANNEL!,
      slackResponseTs: process.env.SLACK_RESPONSE_TS!,
      claudeOptions: process.env.CLAUDE_OPTIONS!,
      conversationHistory: process.env.CONVERSATION_HISTORY,
      mode: workerMode,
      timeoutMinutes: timeoutMinutes,
      httpPort: httpPort,
      slack: {
        token: process.env.SLACK_BOT_TOKEN!,
        refreshToken: process.env.SLACK_REFRESH_TOKEN,
        clientId: process.env.SLACK_CLIENT_ID,
        clientSecret: process.env.SLACK_CLIENT_SECRET,
      },
      workspace: {
        baseDirectory: "/workspace",
        githubToken: process.env.GITHUB_TOKEN!,
      },
    };

    // Validate required configuration
    let required = [
      "SESSION_KEY", "USER_ID", "USERNAME", "CHANNEL_ID", 
      "REPOSITORY_URL", "SLACK_RESPONSE_CHANNEL", 
      "SLACK_RESPONSE_TS", "CLAUDE_OPTIONS", "SLACK_BOT_TOKEN",
      "GITHUB_TOKEN"
    ];
    
    // In one-shot mode, USER_PROMPT is required
    if (workerMode === WorkerMode.oneshot) {
      required.push("USER_PROMPT");
    }

    const missingVars: string[] = [];
    for (const key of required) {
      if (!process.env[key]) {
        missingVars.push(key);
      }
    }

    if (missingVars.length > 0) {
      const errorMessage = `Missing required environment variables: ${missingVars.join(", ")}`;
      logger.error(`❌ ${errorMessage}`);
      
      // Try to update Slack if we have enough config
      if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_RESPONSE_CHANNEL && process.env.SLACK_RESPONSE_TS) {
        try {
          const slackIntegration = new SlackIntegration({
            token: process.env.SLACK_BOT_TOKEN,
            refreshToken: process.env.SLACK_REFRESH_TOKEN,
            clientId: process.env.SLACK_CLIENT_ID,
            clientSecret: process.env.SLACK_CLIENT_SECRET,
          });
          
          await slackIntegration.updateProgress(
            `💥 Worker failed to start: ${errorMessage}`
          );
        } catch (slackError) {
          logger.error("Failed to send error to Slack:", slackError);
        }
      }
      
      throw new Error(errorMessage);
    }

    logger.info("Configuration loaded:");
    logger.info(`- Session: ${config.sessionKey}`);
    logger.info(`- User: ${config.username}`);
    logger.info(`- Repository: ${config.repositoryUrl}`);

    // Create and execute worker
    worker = new ClaudeWorker(config);
    await worker.execute();

    logger.info("✅ Worker execution completed successfully");
    process.exit(0);

  } catch (error) {
    logger.error("❌ Worker execution failed:", error);
    
    // Try to report error to Slack if possible
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_RESPONSE_CHANNEL && process.env.SLACK_RESPONSE_TS) {
      try {
        const slackIntegration = new SlackIntegration({
          token: process.env.SLACK_BOT_TOKEN,
          refreshToken: process.env.SLACK_REFRESH_TOKEN,
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
        });
        
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        
        await slackIntegration.updateProgress(
          `💥 Worker failed: ${errorMessage}`
        );
      } catch (slackError) {
        logger.error("Failed to send error to Slack:", slackError);
      }
    }
    
    // Cleanup if worker was created
    if (worker) {
      try {
        await worker.cleanup();
      } catch (cleanupError) {
        logger.error("Error during cleanup:", cleanupError);
      }
    }
    
    process.exit(1);
  }
}

// Handle process signals
process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

// Start the worker
main();

export type { WorkerConfig } from "./types";