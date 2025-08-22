#!/usr/bin/env bun

import type { App } from "@slack/bolt";
import type { GitHubRepositoryManager } from "../github/repository-manager";
import type { 
  DispatcherConfig, 
  SlackContext, 
  ThreadSession
} from "../types";
import { QueueProducer, type WorkerDeploymentPayload, type ThreadMessagePayload } from "../queue/queue-producer";
import { SessionManager } from "@claude-code-slack/core-runner";
import logger from "../logger";

/**
 * Queue-based Slack event handlers that replace direct Kubernetes job creation
 * Routes messages to appropriate queues based on conversation state
 */
export class SlackEventHandlers {
  private activeSessions = new Map<string, ThreadSession>();
  private userMappings = new Map<string, string>(); // slackUserId -> githubUsername
  private repositoryCache = new Map<string, { repository: any; timestamp: number }>(); // username -> {repository, timestamp}
  private sessionMappings = new Map<string, string>(); // sessionKey -> agentSessionId
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

  constructor(
    private app: App,
    private queueProducer: QueueProducer,
    private repoManager: GitHubRepositoryManager,
    private config: DispatcherConfig
  ) {
    this.setupEventHandlers();
    this.startCachePrewarming();
  }

  /**
   * Get bot ID from configuration
   */
  private getBotId(): string {
    return this.config.slack.botId || "default-slack-bot";
  }


  /**
   * Setup Slack event handlers
   */
  private setupEventHandlers(): void {
    logger.info("Setting up Queue-based Slack event handlers...");
    
    // Handle app mentions
    this.app.event("app_mention", async ({ event, client, say }) => {
      const handlerStartTime = Date.now();
      logger.info("=== APP_MENTION HANDLER TRIGGERED (QUEUE) ===");
      logger.info(`[TIMING] Handler triggered at: ${new Date(handlerStartTime).toISOString()}`);
      
      try {
        const context = this.extractSlackContext(event);
        
        if (!context.userId) {
          logger.error("No user ID found in app_mention event");
          await say({
            thread_ts: context.threadTs,
            text: "❌ Error: Unable to identify user. Please try again.",
          });
          return;
        }
        
        
        if (!this.isUserAllowed(context.userId)) {
          await say({
            thread_ts: context.threadTs,
            text: "Sorry, you don't have permission to use this bot.",
          });
          return;
        }

        const userRequest = this.extractUserRequest(context.text);
        await this.handleUserRequest(context, userRequest, client);
        
      } catch (error) {
        logger.error("Error handling app mention:", error);
        
        try {
          await client.reactions.add({
            channel: event.channel,
            timestamp: event.ts,
            name: "x",
          });
        } catch (reactionError) {
          logger.error("Failed to add error reaction:", reactionError);
        }
        
        await say({
          thread_ts: event.thread_ts,
          text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
        });
      }
    });

    // Handle direct messages
    this.app.message(async ({ message, client, say }) => {
      logger.info("=== MESSAGE HANDLER TRIGGERED (QUEUE) ===");
      
      // Skip our own bot's messages
      const botUserId = this.config.slack.botUserId;
      const botId = this.config.slack.botId;
      if ((message as any).user === botUserId || (message as any).bot_id === botId) {
        logger.debug(`Skipping our own bot's message`);
        return;
      }
      
      // Skip channel messages with bot mentions (handled by app_mention)
      const messageText = (message as any).text || '';
      if (message.channel_type === 'channel' && messageText.includes(`<@${botUserId}>`)) {
        logger.debug("Skipping channel message with bot mention - handled by app_mention");
        return;
      }
      
      const ignoredSubtypes = [
        'message_changed',
        'message_deleted', 
        'thread_broadcast',
        'channel_join',
        'channel_leave',
        'assistant_app_thread'
      ];
      
      if (message.subtype && ignoredSubtypes.includes(message.subtype)) {
        logger.debug(`Ignoring message with subtype: ${message.subtype}`);
        return;
      }
      
      try {
        const context = this.extractSlackContext(message);
        
        if (!context.userId) {
          logger.error("No user ID found in message event");
          await say("❌ Error: Unable to identify user. Please try again.");
          return;
        }
        
        
        if (!this.isUserAllowed(context.userId)) {
          await say("Sorry, you don't have permission to use this bot.");
          return;
        }

        const userRequest = this.extractUserRequest(context.text);
        await this.handleUserRequest(context, userRequest, client);
        
      } catch (error) {
        logger.error("Error handling direct message:", error);
        await say(`❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`);
      }
    });

    // Handle view submissions (dialog/modal submissions)
    this.app.view(/.*/, async ({ ack, body, view, client }) => {
      logger.info("=== VIEW SUBMISSION HANDLER TRIGGERED (QUEUE) ===");
      await ack();
      
      try {
        const userId = body.user.id;
        const metadata = view.private_metadata ? JSON.parse(view.private_metadata) : {};
        
        // Handle repository override modal specifically
        if (view.callback_id === 'repository_override_modal') {
          await this.handleRepositoryOverrideSubmission(userId, view, client);
          return;
        }
        
        const channelId = metadata.channel_id;
        const threadTs = metadata.thread_ts;
        const userInput = this.extractViewInputs(view.state.values);
        
        if (channelId && threadTs) {
          const buttonText = metadata.button_text || 
                            (metadata.action_id ? metadata.action_id.replace(/_/g, ' ') : null) || 
                            view.callback_id?.replace(/_/g, ' ') || 
                            'Form';
          
          const formattedInput = `> 📝 *Form submitted from "${buttonText}" button*\n\n${userInput}`;
          
          const inputMessage = await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: formattedInput,
            blocks: [
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `<@${userId}> submitted form`
                  }
                ]
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: userInput
                }
              }
            ]
          });
          
          const context = {
            channelId,
            userId,
            userDisplayName: body.user.name || 'Unknown User',
            teamId: body.team?.id || '',
            messageTs: inputMessage.ts as string,
            threadTs: threadTs,
            text: userInput,
          };
          
          await this.handleUserRequest(context, userInput, client);
        }
        
      } catch (error) {
        logger.error("Error handling view submission:", error);
      }
    });

    // Handle interactive actions (button clicks, select menus, etc.)
    this.app.action(/.*/, async ({ action, ack, client, body }) => {
      logger.info("=== ACTION HANDLER TRIGGERED (QUEUE) ===");
      await ack();
      
      try {
        const actionId = (action as any).action_id;
        const userId = body.user.id;
        const channelId = (body as any).channel?.id || (body as any).container?.channel_id;
        const messageTs = (body as any).message?.ts || (body as any).container?.message_ts;
        
        if (!this.isUserAllowed(userId)) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: "Sorry, you don't have permission to use this action.",
          });
          return;
        }
        
        await this.handleBlockAction(actionId, userId, channelId, messageTs, body, client);
        
      } catch (error) {
        logger.error("Error handling action:", error);
        
        const userId = body.user.id;
        const channelId = (body as any).channel?.id || (body as any).container?.channel_id;
        
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
        });
      }
    });

    // Handle app home opened events
    this.app.event("app_home_opened", async ({ event, client }) => {
      logger.info("=== APP_HOME_OPENED HANDLER TRIGGERED (QUEUE) ===");
      
      try {
        if (event.tab === "home") {
          await this.updateAppHome(event.user, client);
        }
      } catch (error) {
        logger.error("Error handling app home opened:", error);
      }
    });
  }

  /**
   * Handle user request by routing to appropriate queue
   */
  private async handleUserRequest(
    context: SlackContext,
    userRequest: string,
    client: any
  ): Promise<void> {
    const requestStartTime = Date.now();
    logger.info(`[TIMING] handleUserRequest started at: ${new Date(requestStartTime).toISOString()}`);
    
    // Generate session key
    const sessionKey = SessionManager.generateSessionKey({
      platform: "slack",
      channelId: context.channelId,
      userId: context.userId,
      userDisplayName: context.userDisplayName,
      teamId: context.teamId,
      threadTs: context.threadTs,
      messageTs: context.messageTs,
    });

    logger.info(`Handling request for session: ${sessionKey}`);

    // Check if session is already active
    const existingSession = this.activeSessions.get(sessionKey);
    if (existingSession && existingSession.status === "running") {
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: context.threadTs,
        text: "⏳ I'm already working on this thread. Please wait for the current task to complete.",
        mrkdwn: true,
      });
      return;
    }

    try {
      // Get user's GitHub username mapping
      const username = await this.getOrCreateUserMapping(context.userId, client);
      
      // Check if we have an existing Claude session for this thread
      const existingClaudeSessionId = await this.loadSessionMapping(username, sessionKey);
      
      // Check repository cache first
      let repository;
      const cachedRepo = this.repositoryCache.get(username);
      if (cachedRepo && Date.now() - cachedRepo.timestamp < this.CACHE_TTL) {
        repository = cachedRepo.repository;
        logger.info(`Using cached repository for ${username}`);
      } else {
        repository = await this.repoManager.ensureUserRepository(username);
        this.repositoryCache.set(username, { repository, timestamp: Date.now() });
      }
      
      // If this is not already a thread, use the current message timestamp as thread_ts
      const threadTs = context.threadTs || context.messageTs;
      
      // Create thread session
      const threadSession: ThreadSession = {
        sessionKey,
        threadTs: threadTs,
        channelId: context.channelId,
        userId: context.userId,
        username,
        repositoryUrl: repository.repositoryUrl,
        agentSessionId: existingClaudeSessionId,
        lastActivity: Date.now(),
        status: "pending",
        createdAt: Date.now(),
      };

      this.activeSessions.set(sessionKey, threadSession);

      // Post initial Slack response
      logger.info(`[TIMING] Posting initial response at: ${new Date().toISOString()}`);
      const initialResponse = await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: threadTs,
        text: "🚀 Starting Claude session...",
      });

      // Determine if this is a new conversation or continuation
      const isNewConversation = !context.threadTs;
      
      if (isNewConversation) {
        // Enqueue to direct_message queue (will create worker deployment)
        const directPayload: DirectMessagePayload = {
          botId: this.getBotId(),
          userId: context.userId,
          platform: "slack",
          channelId: context.channelId,
          messageId: context.messageTs,
          threadId: threadTs,
          messageText: userRequest,
          githubUsername: username,
          repositoryUrl: repository.repositoryUrl,
          platformMetadata: {
            teamId: context.teamId,
            userDisplayName: context.userDisplayName,
            slackResponseChannel: context.channelId,
            slackResponseTs: initialResponse.ts,
            originalMessageTs: context.messageTs,
          },
          claudeOptions: {
            ...this.config.claude,
            timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
            resumeSessionId: existingClaudeSessionId,
          },
        };

        const deploymentPayload: WorkerDeploymentPayload = {
          userId: context.userId,
          botId: this.getBotId(),
          agentSessionId: existingClaudeSessionId || sessionKey,
          threadId: threadTs,
          platform: "slack",
          platformUserId: context.userId,
          messageId: context.messageTs,
          messageText: userRequest,
          channelId: context.channelId,
          platformMetadata: {
            teamId: context.teamId,
            userDisplayName: context.userDisplayName,
            repositoryUrl: repositoryUrl,
            slackResponseChannel: context.channelId,
            slackResponseTs: initialResponse.ts,
            originalMessageTs: context.messageTs,
          },
          claudeOptions: {
            allowedTools: this.config.claude.allowedTools,
            model: this.config.claude.model,
            timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
            resumeSessionId: existingClaudeSessionId,
          },
        };

        const jobId = await this.queueProducer.enqueueWorkerDeployment(deploymentPayload);

        logger.info(`Enqueued direct message job ${jobId} for session ${sessionKey}`);
        threadSession.status = "enqueued";
        
      } else {
        // Enqueue to user-specific queue (worker should already exist)
        const threadPayload: ThreadMessagePayload = {
          botId: this.getBotId(),
          userId: context.userId,
          threadId: threadTs,
          platform: "slack",
          channelId: context.channelId,
          messageId: context.messageTs,
          messageText: userRequest,
          agentSessionId: existingClaudeSessionId,
          platformMetadata: {
            teamId: context.teamId,
            userDisplayName: context.userDisplayName,
            repositoryUrl: repositoryUrl,
            slackResponseChannel: context.channelId,
            slackResponseTs: initialResponse.ts,
            originalMessageTs: context.messageTs,
          },
          claudeOptions: {
            ...this.config.claude,
            timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
          },
          // Add routing metadata for thread-specific processing
          routingMetadata: {
            targetThreadId: threadTs,
            agentSessionId: existingClaudeSessionId || sessionKey,
            userId: context.userId
          }
        };

        const jobId = await this.queueProducer.enqueueThreadMessage(threadPayload);

        logger.info(`Enqueued thread message job ${jobId} for session ${sessionKey}`);
        threadSession.status = "enqueued";
      }

    } catch (error) {
      logger.error(`Failed to handle request for session ${sessionKey}:`, error);
      
      // Try to update reaction to error
      try {
        await client.reactions.remove({
          channel: context.channelId,
          timestamp: context.messageTs,
          name: "eyes",
        });
        await client.reactions.add({
          channel: context.channelId,
          timestamp: context.messageTs,
          name: "x",
        });
      } catch (reactionError) {
        logger.error("Failed to update error reaction:", reactionError);
      }
      
      const errorMessage = `❌ *Error:* ${error instanceof Error ? error.message : "Unknown error occurred"}`;
      
      // Post error message in thread
      const threadTs = context.threadTs || context.messageTs;
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: threadTs,
        text: errorMessage,
        mrkdwn: true,
      });
      
      // Clean up session
      this.activeSessions.delete(sessionKey);
    }
  }

  /**
   * Extract Slack context from event
   */
  private extractSlackContext(event: any): SlackContext {
    return {
      channelId: event.channel,
      userId: event.user,
      teamId: event.team || "",
      threadTs: event.thread_ts,
      messageTs: event.ts,
      text: event.text || "",
      userDisplayName: event.user_profile?.display_name || "Unknown User",
    };
  }

  /**
   * Extract user request from mention text
   */
  private extractUserRequest(text: string): string {
    let cleaned = text.replace(/<@[^>]+>/g, "").trim();
    
    if (!cleaned) {
      return "Hello! How can I help you today?";
    }
    
    return cleaned;
  }

  /**
   * Check if user is allowed to use the bot
   */
  private isUserAllowed(userId: string): boolean {
    const { allowedUsers, blockedUsers } = this.config.slack;
    
    if (blockedUsers?.includes(userId)) {
      return false;
    }
    
    if (allowedUsers && allowedUsers.length > 0) {
      return allowedUsers.includes(userId);
    }
    
    return true;
  }

  /**
   * Load previously stored Claude session mapping for a thread
   * Currently uses in-memory map but can be extended to persistent storage
   */
  private async loadSessionMapping(
    _username: string,
    sessionKey: string,
  ): Promise<string | undefined> {
    return this.sessionMappings.get(sessionKey);
  }

  private async getOrCreateUserMapping(slackUserId: string, client: any): Promise<string> {
    const existingMapping = this.userMappings.get(slackUserId);
    if (existingMapping) {
      return existingMapping;
    }

    try {
      const userInfo = await client.users.info({ user: slackUserId });
      const user = userInfo.user;
      
      let username = user.profile?.display_name || user.profile?.real_name || user.name;
      username = username.toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      
      username = `user-${username}`;
      this.userMappings.set(slackUserId, username);
      
      logger.info(`Created user mapping: ${slackUserId} -> ${username}`);
      return username;
      
    } catch (error) {
      logger.error(`Failed to get user info for ${slackUserId}:`, error);
      const fallbackUsername = slackUserId ? `user-${slackUserId.substring(0, 8)}` : "user-unknown";
      if (slackUserId) {
        this.userMappings.set(slackUserId, fallbackUsername);
      }
      return fallbackUsername;
    }
  }

  private startCachePrewarming(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [username, cached] of this.repositoryCache.entries()) {
        if (now - cached.timestamp > this.CACHE_TTL) {
          this.repositoryCache.delete(username);
          logger.info(`Evicted stale repository cache for ${username}`);
        }
      }
    }, 60000);
  }

  private async handleBlockAction(
    actionId: string,
    userId: string,
    channelId: string,
    messageTs: string,
    body: any,
    client: any
  ): Promise<void> {
    logger.info(`Handling block action: ${actionId}`);

    switch (actionId) {
      case "open_repository_override_modal":
        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: "modal",
            callback_id: "repository_override_modal",
            private_metadata: JSON.stringify({
              channel_id: channelId,
              thread_ts: messageTs,
            }),
            title: { type: "plain_text", text: "Repository" },
            submit: { type: "plain_text", text: "Save" },
            close: { type: "plain_text", text: "Cancel" },
            blocks: [
              {
                type: "input",
                block_id: "repo_input",
                label: { type: "plain_text", text: "Repository URL" },
                element: {
                  type: "plain_text_input",
                  action_id: "repo_url",
                  placeholder: { type: "plain_text", text: "https://github.com/user/repo" },
                },
              },
            ],
          },
        });
        break;

      default:
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Unsupported action: ${actionId}`,
        });
    }
  }

  private async updateAppHome(userId: string, client: any): Promise<void> {
    logger.info(`Updating app home for user: ${userId}`);
    const homeView = {
      type: "home",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Welcome to Claude Code!" },
        },
      ],
    };

    await client.views.publish({ user_id: userId, view: homeView });
  }

  private async handleRepositoryOverrideSubmission(
    userId: string,
    view: any,
    client: any
  ): Promise<void> {
    logger.info(`Handling repository override submission for user: ${userId}`);

    const repoUrl = view.state.values?.repo_input?.repo_url?.value?.trim();
    const metadata = view.private_metadata ? JSON.parse(view.private_metadata) : {};
    const channelId = metadata.channel_id;
    const threadTs = metadata.thread_ts;

    if (!repoUrl) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "Please provide a repository URL.",
      });
      return;
    }

    const username = await this.getOrCreateUserMapping(userId, client);
    
    // Save to database instead of just memory cache
    try {
      await this.saveUserRepositoryUrl(username, userId, repoUrl);
      
      // Also update memory cache for immediate use
      this.repositoryCache.set(username, {
        repository: { repositoryUrl: repoUrl },
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error(`Failed to save repository URL for ${username}:`, error);
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "❌ Failed to save repository URL. Please try again.",
      });
      return;
    }

    if (channelId && threadTs) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `✅ Repository set to ${repoUrl}`,
      });
    }
  }

  private extractViewInputs(stateValues: any): string {
    const inputs: string[] = [];
    for (const block of Object.values(stateValues || {})) {
      for (const action of Object.values(block as any)) {
        const value =
          (action as any).value ||
          (action as any).selected_option?.value ||
          "";
        if (value) {
          inputs.push(value);
        }
      }
    }
    return inputs.join("\n");
  }

  /**
   * Get active sessions for monitoring
   */
  getActiveSessions(): ThreadSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get session count
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Cleanup all sessions
   */
  async cleanup(): Promise<void> {
    this.activeSessions.clear();
    this.userMappings.clear();
    this.repositoryCache.clear();
  }
}