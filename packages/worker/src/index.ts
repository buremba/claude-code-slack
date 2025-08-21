#!/usr/bin/env bun

import { ClaudeSessionRunner } from "@claude-code-slack/core-runner";
import { WorkspaceManager } from "./workspace-setup";
import { SlackIntegration } from "./slack-integration";
import { SlackTokenManager } from "./slack/token-manager";
import { extractFinalResponse } from "./claude-output-parser";
import type { WorkerConfig } from "./types";
import logger from "./logger";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { dirname, relative } from "node:path";

export class ClaudeWorker {
  private sessionRunner: ClaudeSessionRunner;
  private workspaceManager: WorkspaceManager;
  private slackIntegration: SlackIntegration;
  private config: WorkerConfig;
  private tokenManager?: SlackTokenManager;

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


  private listMakefilePaths(rootDirectory: string): string[] {
    const foundMakefiles: string[] = [];
    const ignored = new Set([
      "node_modules",
      ".git",
      ".next",
      "dist",
      "build",
      "vendor",
      "target",
      ".venv",
      "venv"
    ]);

    const walk = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (ignored.has(entry.name)) continue;
          walk(p);
        } else if (entry.isFile() && entry.name === "Makefile") {
          foundMakefiles.push(p);
        }
      }
    };

    walk(rootDirectory);
    return foundMakefiles;
  }

  private extractMakeTargets(makefileDirectory: string): string[] {
    try {
      const stdout = execSync(`make -C "${makefileDirectory}" -qp`, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" });
      const lineRegex = new RegExp('^[a-zA-Z0-9][^$#\\/\\t%=:]*:([^=]|$)');
      const targets = new Set<string>();
      for (const line of stdout.split("\n")) {
        if (!lineRegex.test(line)) continue;
        const name = line.split(":")[0];
        if (!name || name.startsWith(".")) continue;
        if (name === "Makefile" || name === "makefile" || name === "GNUmakefile") continue;
        targets.add(name);
      }
      return Array.from(targets).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private getMakeTargetsSummary(): string {
    const root = `/workspace/${this.config.username}`;
    const makefiles = this.listMakefilePaths(root);
    if (makefiles.length === 0) return "  - none";

    const lines: string[] = [];
    for (const mf of makefiles) {
      const dir = dirname(mf);
      const rel = relative(root, dir) || ".";
      const targets = this.extractMakeTargets(dir);
      lines.push(`  - ${rel}`);
      if (targets.length === 0) {
        lines.push("    - (none)");
      } else {
        for (const t of targets) lines.push(`    - ${t}`);
      }
    }
    return lines.join("\n");
  }



  /**
   * Execute the worker job
   */
  async execute(): Promise<void> {
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
              text: `🪚 <${this.config.repositoryUrl.replace('github.com', 'github.dev')}/tree/main|${this.config.username}>`
          }
        ]
      };
      
      // Set initial context block
      this.slackIntegration.setContextBlock(contextBlock);
      
      // Decode user prompt first
      const userPrompt = Buffer.from(this.config.userPrompt, "base64").toString("utf-8");
      logger.info(`User prompt: ${userPrompt.substring(0, 100)}...`);
      
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
      
      contextBlock = {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `🪚 <${this.config.repositoryUrl.replace('github.com', 'github.dev')}/tree/${branchName}|${this.config.username}>`
          },
          {
            type: "mrkdwn",
            text: `🔀 <${this.config.repositoryUrl}/compare/main...${branchName}|Pull Request>`
          }
        ]
      };
      
      // Update context block with proper URLs
      this.slackIntegration.setContextBlock(contextBlock);
      

      // Update progress with simple status
      await this.slackIntegration.updateProgress("🚀 Starting Claude session...");

      // Check if we should resume an existing session
      const shouldResume = !!this.config.resumeSessionId;
      if (shouldResume) {
        logger.info(`Resuming Claude session: ${this.config.resumeSessionId}`);
        await this.slackIntegration.updateProgress("🔄 Resuming Claude session...");
      } else {
        logger.info("Creating new Claude session");
        await this.slackIntegration.updateProgress("🤖 Creating new Claude session...");
      }

      // Prepare session context
      const sessionContext = {
        platform: "slack" as const,
        channelId: this.config.channelId,
        userId: this.config.userId,
        userDisplayName: this.config.username,
        threadTs: this.config.threadTs,
        messageTs: this.config.slackResponseTs,
        repositoryUrl: this.config.repositoryUrl,
        workingDirectory: this.workspaceManager.getCurrentWorkingDirectory(),
        customInstructions: this.generateCustomInstructions(),
      };

      // Update progress to show we're starting Claude
      await this.slackIntegration.updateProgress("🤖 Initializing Claude...");

      // Execute Claude session with conversation history
      logger.info(`[TIMING] Starting Claude session at: ${new Date().toISOString()}`);
      const claudeStartTime = Date.now();
      logger.info(`[TIMING] Total worker startup time: ${claudeStartTime - executeStartTime}ms`);
      
      let firstOutputLogged = false;
      const result = await this.sessionRunner.executeSession({
        sessionKey: this.config.sessionKey,
        userPrompt,
        context: sessionContext,
        options: {
          ...JSON.parse(this.config.claudeOptions),
          resumeSessionId: this.config.resumeSessionId, // Use resumeSessionId if available
        },
        onProgress: async (update) => {
          // Log timing for first output
          if (!firstOutputLogged && update.type === "output") {
            logger.info(`[TIMING] First Claude output at: ${new Date().toISOString()} (${Date.now() - claudeStartTime}ms after Claude start)`);
            firstOutputLogged = true;
            // Update progress to show Claude is now actively working
            await this.slackIntegration.sendTyping();
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
You are a helpful Claude Code agent running in a pod on K8S for user ${this.config.username}. 
You MUST generate Markdown content that will be rendered in user's messaging app. 

**Code Block Actions:**
You can add action metadata to code blocks to create interactive buttons. 
The metadata goes in the fence info, NOT in the content.
Only use it to run commands and programs, not to create forms or links.

**Examples:**

\`\`\`bash { action: "Deploy App", confirm: true, show: true }
#!/bin/bash
npm run build
docker build -t myapp .
\`\`\`

\`\`\`blockkit { action: "Configure Settings", confirm: false, show: false }
{
  "blocks": [
    {
      "type": "input",
      "element": {
        "type": "plain_text_input",
        "action_id": "name_input"
      },
      "label": {
        "type": "plain_text",
        "text": "Project Name"
      }
    }
  ]
}
\`\`\`

**CRITICAL FOR BLOCKKIT FORMS:**
- ALWAYS include action metadata: \`{ action: "Button Name", confirm: false, show: false }\`
- NEVER use plain \`\`\`blockkit without metadata
- Forms without action metadata will NOT work properly

**Environment:**
- Repo: ${this.config.repositoryUrl}
- Session: ${this.config.sessionKey}
- Makefile directories and targets (indicating projects):
${this.getMakeTargetsSummary()}

**Guidelines:**
- Branch: claude/${this.config.sessionKey.replace(/\./g, "-")}
- IMPORTANT: After making any code changes, you MUST commit and push them using git commands (git add, git commit, git push).
- Push only to this branch (no PR creation, the user has to create PR manually).
- Focus on the user's request.
- Always prefer numbered lists over bullet points.
- After changes, ask the user to click "Create Pull Request".

**Instructions:**
1. New project: create a folder in the current directory; ask for name, tech stack (dbname,providername,apiservicename etc.) in a form and autopopulate if provided. Collect secrets if needed. Deployment types are Node.js/bun, Python/uv, Docker, Docker Compose, Cloudflare (install flarectl and ask for personal access token.).
2. Feature/bug: if no Makefile in current dir, show a dropdown of folders containing a Makefile in a form; user selects one; set the current directory to the selected folder.
3. Secrets: if required, collect values via form and map to .env file before running make commands.
4. New persona: If the user says he wants to create subagent/persona, create a Claude subagent on .claude/agents/agent-name.md and in there add it's traits based on the form values the user enters.
5. If the user wants to remember something, add it to CLAUDE.md file.
6. If the user wants to create an action, create a new file in .claude/actions/action-name.md and in there add the action's traits based on the form values the user enters.

}.`
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
    const config: WorkerConfig = {
      sessionKey: process.env.SESSION_KEY!,
      userId: process.env.USER_ID!,
      username: process.env.USERNAME!,
      channelId: process.env.CHANNEL_ID!,
      threadTs: process.env.THREAD_TS || undefined,
      repositoryUrl: process.env.REPOSITORY_URL!,
      userPrompt: process.env.USER_PROMPT!, // Base64 encoded
      slackResponseChannel: process.env.SLACK_RESPONSE_CHANNEL!,
      slackResponseTs: process.env.SLACK_RESPONSE_TS!,
      claudeOptions: process.env.CLAUDE_OPTIONS!,
      resumeSessionId: process.env.RESUME_SESSION_ID,
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
    const required = [
      "SESSION_KEY", "USER_ID", "USERNAME", "CHANNEL_ID", 
      "REPOSITORY_URL", "USER_PROMPT", "SLACK_RESPONSE_CHANNEL", 
      "SLACK_RESPONSE_TS", "CLAUDE_OPTIONS", "SLACK_BOT_TOKEN",
      "GITHUB_TOKEN"
    ];

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
  await appendTerminationMessage("SIGTERM");
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("Received SIGINT, shutting down gracefully...");
  await appendTerminationMessage("SIGINT");
  process.exit(0);
});

/**
 * Append termination message to Slack when worker is terminated
 */
async function appendTerminationMessage(signal: string): Promise<void> {
  try {
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_RESPONSE_CHANNEL && process.env.SLACK_RESPONSE_TS) {
      const slackIntegration = new SlackIntegration({
        token: process.env.SLACK_BOT_TOKEN,
        refreshToken: process.env.SLACK_REFRESH_TOKEN,
        clientId: process.env.SLACK_CLIENT_ID,
        clientSecret: process.env.SLACK_CLIENT_SECRET,
      });
      
      await slackIntegration.updateProgress(
        `🛑 **Worker terminated (${signal})** - The host is terminated and not processing further requests.`
      );
      
      // Update reaction to show termination
      const originalMessageTs = process.env.ORIGINAL_MESSAGE_TS;
      if (originalMessageTs) {
        await slackIntegration.removeReaction("gear", originalMessageTs).catch(() => {});
        await slackIntegration.removeReaction("eyes", originalMessageTs).catch(() => {});
        await slackIntegration.addReaction("stop_sign", originalMessageTs).catch(() => {});
      }
    }
  } catch (error) {
    logger.error(`Failed to send ${signal} termination message to Slack:`, error);
  }
}

// Start the worker
main();

export type { WorkerConfig } from "./types";