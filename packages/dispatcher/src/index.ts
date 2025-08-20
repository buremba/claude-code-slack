#!/usr/bin/env bun

import { config as dotenvConfig } from 'dotenv';
import { join } from 'path';
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { SlackEventHandlers } from "./slack/event-handlers";
import { KubernetesJobManager } from "./kubernetes/job-manager";
import { ClaudeSessionManager } from "./kubernetes/session-manager";
import { GitHubRepositoryManager } from "./github/repository-manager";
import { setupHealthEndpoints } from "./simple-http";
import type { DispatcherConfig, JobManager } from "./types";
import logger from "./logger";

export class SlackDispatcher {
  private app: App;
  private jobManager: JobManager;
  private repoManager: GitHubRepositoryManager;
  private config: DispatcherConfig;

  constructor(config: DispatcherConfig) {
    this.config = config;

    // Initialize Slack app based on mode
    if (config.slack.socketMode === false) {
      // HTTP mode - use ExpressReceiver
      const receiver = new ExpressReceiver({
        signingSecret: config.slack.signingSecret!,
        endpoints: {
          events: '/slack/events'
        },
        processBeforeResponse: true,
        logLevel: LogLevel.DEBUG,
      });
      
      this.app = new App({
        token: config.slack.token,
        receiver,
        logLevel: config.logLevel || LogLevel.DEBUG,
        ignoreSelf: false, // We need to receive action events from our own messages
      });
      
      logger.info("Initialized Slack app in HTTP mode with ExpressReceiver");
    } else {
      // Socket mode
      const appConfig: any = {
        signingSecret: config.slack.signingSecret,
        socketMode: true,
        appToken: config.slack.appToken,
        port: config.slack.port || 3000,
        logLevel: config.logLevel || LogLevel.INFO,
        ignoreSelf: false, // We need to receive action events from our own messages
        processBeforeResponse: true,
      };
      
      if (config.slack.token) {
        appConfig.token = config.slack.token;
      } else {
        throw new Error("SLACK_BOT_TOKEN is required");
      }
      
      this.app = new App(appConfig);
      logger.info("Initialized Slack app in Socket mode");
    }

    // Initialize job manager based on configuration
    if (config.useOperator) {
      logger.info("✅ Using Claude Operator for session management");
      this.jobManager = new ClaudeSessionManager(config.kubernetes);
    } else {
      logger.info("✅ Using direct Kubernetes job management");
      this.jobManager = new KubernetesJobManager(config.kubernetes);
    }
    
    this.repoManager = new GitHubRepositoryManager(config.github);

    this.setupErrorHandling();
    this.setupGracefulShutdown();
    
    // Add global middleware to log all events
    this.app.use(async ({ payload, next }) => {
      const event = (payload as any).event || payload;
      logger.debug(`[Slack Event] Type: ${event?.type}, Subtype: ${event?.subtype}`);
      if (event) {
        logger.debug(`[Slack Event Details]`, JSON.stringify(event).substring(0, 200));
      }
      await next();
    });
  }

  /**
   * Start the dispatcher
   */
  async start(): Promise<void> {
    try {
      // Setup health endpoints for Kubernetes FIRST
      setupHealthEndpoints();
      
      // Get bot's own user ID and bot ID dynamically before starting
      await this.initializeBotInfo(this.config);
      
      // We'll test auth after starting the server
      logger.info("Starting Slack app with token:", {
        firstChars: this.config.slack.token?.substring(0, 10),
        length: this.config.slack.token?.length,
        signingSecretLength: this.config.slack.signingSecret?.length,
      });
      
      if (this.config.slack.socketMode === false) {
        // In HTTP mode, start with the port
        await this.app.start(this.config.slack.port || 3000);
        
        // Add debugging info
        const receiver = (this.app as any).receiver as ExpressReceiver;
        const expressApp = receiver.app;
        
        // Add request logging middleware
        expressApp.use((req: any, _res: any, next: any) => {
          logger.debug(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
          logger.debug('Headers:', req.headers);
          if (req.method === 'POST' && req.body) {
            logger.debug('Body:', JSON.stringify(req.body).substring(0, 200));
          }
          next();
        });
        
        // No test endpoints in production code
        
        // Add a health check endpoint
        expressApp.get('/health', (_req, res) => {
          res.json({ 
            service: 'peerbot-dispatcher',
            status: 'running',
            mode: 'http'
          });
        });
        
        logger.debug("Express routes after Slack app start:");
        expressApp._router.stack.forEach((middleware: any) => {
          if (middleware.route) {
            logger.debug(`- ${Object.keys(middleware.route.methods).join(', ').toUpperCase()} ${middleware.route.path}`);
          } else if (middleware.name === 'router') {
            logger.debug('- Router middleware');
          }
        });
      } else {
        // In socket mode, just start
        logger.info("Starting Slack app in Socket Mode...");
        try {
          await this.app.start();
          logger.info("✅ Socket Mode connection established!");
        } catch (socketError) {
          logger.error("❌ Failed to start Socket Mode:", socketError);
          throw socketError;
        }
      }
      
      const mode = this.config.slack.socketMode ? "Socket Mode" : `HTTP on port ${this.config.slack.port}`;
      logger.info(`🚀 Slack Dispatcher is running in ${mode}! (Local Dev with Skaffold)`);
      
      // Log configuration
      logger.info("Configuration:");
      logger.info(`- Kubernetes Namespace: ${this.config.kubernetes.namespace}`);
      logger.info(`- Worker Image: ${this.config.kubernetes.workerImage}`);
      logger.info(`- GitHub Organization: ${this.config.github.organization}`);
      logger.info(`- Session Timeout: ${this.config.sessionTimeoutMinutes} minutes`);
      logger.info(`- Signing Secret: ${this.config.slack.signingSecret?.substring(0, 8)}...`);
      
    } catch (error) {
      logger.error("Failed to start Slack dispatcher:", error);
      process.exit(1);
    }
  }

  /**
   * Stop the dispatcher
   */
  async stop(): Promise<void> {
    try {
      await this.app.stop();
      await this.jobManager.cleanup();
      
      
      logger.info("Slack dispatcher stopped");
    } catch (error) {
      logger.error("Error stopping Slack dispatcher:", error);
    }
  }

  /**
   * Get dispatcher status
   */
  getStatus(): {
    isRunning: boolean;
    activeJobs: number;
    config: Partial<DispatcherConfig>;
  } {
    return {
      isRunning: true,
      activeJobs: this.jobManager.getActiveJobCount(),
      config: {
        slack: {
          token: this.config.slack.token,
          socketMode: this.config.slack.socketMode,
          port: this.config.slack.port,
        },
        kubernetes: {
          namespace: this.config.kubernetes.namespace,
          workerImage: this.config.kubernetes.workerImage,
          cpu: this.config.kubernetes.cpu,
          memory: this.config.kubernetes.memory,
          timeoutSeconds: this.config.kubernetes.timeoutSeconds,
        },
      },
    };
  }

  /**
   * Setup error handling
   */
  private async initializeBotInfo(config: DispatcherConfig): Promise<void> {
    try {
      // Get bot's own user ID and bot ID using auth.test
      const authResult = await this.app.client.auth.test({
        token: config.slack.token
      });
      
      const botUserId = authResult.user_id as string;
      const botId = authResult.bot_id as string;
      
      logger.info(`Bot initialized - User ID: ${botUserId}, Bot ID: ${botId}`);
      
      // Store bot info in config for event handlers to use
      config.slack.botUserId = botUserId;
      config.slack.botId = botId;
      
      // Now initialize event handlers with bot info
      new SlackEventHandlers(
        this.app,
        this.jobManager,
        this.repoManager,
        config
      );
    } catch (error) {
      logger.error("Failed to get bot info:", error);
      throw new Error("Failed to initialize bot - could not get bot user ID");
    }
  }

  private setupErrorHandling(): void {
    this.app.error(async (error) => {
      logger.error("Slack app error:", error);
      logger.error("Error details:", {
        message: error.message,
        code: (error as any).code,
        data: (error as any).data,
        stack: error.stack
      });
    });

    process.on("unhandledRejection", (reason, promise) => {
      logger.error("Unhandled Rejection at:", promise, "reason:", reason);
      // Don't exit on unhandled rejections during startup
      // The app might still work despite some initialization errors
    });

    process.on("uncaughtException", (error) => {
      logger.error("Uncaught Exception:", error);
      process.exit(1);
    });
  }

  /**
   * Setup graceful shutdown
   */
  private setupGracefulShutdown(): void {
    const cleanup = async () => {
      logger.info("Shutting down Slack dispatcher...");
      
      // Stop accepting new jobs
      await this.stop();
      
      // Wait for active jobs to complete (with timeout)
      const activeJobs = this.jobManager.getActiveJobCount();
      if (activeJobs > 0) {
        logger.info(`Waiting for ${activeJobs} active jobs to complete...`);
        
        const timeout = setTimeout(() => {
          logger.warn("Timeout reached, forcing shutdown");
          process.exit(0);
        }, 60000); // 1 minute timeout
        
        // Wait for jobs to complete
        while (this.jobManager.getActiveJobCount() > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        clearTimeout(timeout);
      }
      
      logger.info("Slack dispatcher shutdown complete");
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Load environment variables from project root
    const envPath = join(__dirname, '../../../.env');
    dotenvConfig({ path: envPath });
    logger.info("🚀 Starting Claude Code Slack Dispatcher");

    // Get bot token from environment
    const botToken = process.env.SLACK_BOT_TOKEN;

    // Load configuration from environment
    const config: DispatcherConfig = {
      slack: {
        token: botToken!,
        appToken: process.env.SLACK_APP_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: process.env.SLACK_HTTP_MODE !== "true",
        port: parseInt(process.env.PORT || "3000"),
        botUserId: process.env.SLACK_BOT_USER_ID,
        allowedUsers: process.env.SLACK_ALLOWED_USERS?.split(","),
        allowedChannels: process.env.SLACK_ALLOWED_CHANNELS?.split(","),
      },
      kubernetes: {
        namespace: process.env.KUBERNETES_NAMESPACE || "default",
        workerImage: process.env.WORKER_IMAGE || "claude-worker:latest",
        cpu: process.env.WORKER_CPU || "1000m",
        memory: process.env.WORKER_MEMORY || "2Gi",
        timeoutSeconds: parseInt(process.env.WORKER_TIMEOUT_SECONDS || "300"),
      },
      github: {
        token: process.env.GITHUB_TOKEN!,
        organization: process.env.GITHUB_ORGANIZATION || "", // Empty string means use authenticated user
      },
      claude: {
        allowedTools: process.env.ALLOWED_TOOLS,
        model: process.env.MODEL,
        timeoutMinutes: process.env.TIMEOUT_MINUTES,
      },
      sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES || "5"),
      logLevel: process.env.LOG_LEVEL as any || LogLevel.INFO,
      useOperator: process.env.USE_CLAUDE_OPERATOR === "true",
    };

    // Validate required configuration
    if (!config.slack.token) {
      throw new Error("SLACK_BOT_TOKEN is required");
    }
    if (!config.github.token) {
      throw new Error("GITHUB_TOKEN is required");
    }

    // Create and start dispatcher
    const dispatcher = new SlackDispatcher(config);
    await dispatcher.start();

    logger.info("✅ Claude Code Slack Dispatcher is running!");

    // Handle health checks
    process.on("SIGUSR1", () => {
      const status = dispatcher.getStatus();
      logger.info("Health check:", JSON.stringify(status, null, 2));
    });

  } catch (error) {
    logger.error("❌ Failed to start Slack Dispatcher:", error);
    process.exit(1);
  }
}

// Start the application
main();

export type { DispatcherConfig } from "./types";