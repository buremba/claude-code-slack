#!/usr/bin/env bun

import type { App } from "@slack/bolt";
import type { KubernetesJobManager } from "../kubernetes/job-manager";
import type { GitHubRepositoryManager } from "../github/repository-manager";
import type { 
  DispatcherConfig, 
  SlackContext, 
  ThreadSession,
  WorkerJobRequest
} from "../types";
import { SessionManager } from "@claude-code-slack/core-runner";
import logger from "../logger";

export class SlackEventHandlers {
  private activeSessions = new Map<string, ThreadSession>();
  private userMappings = new Map<string, string>(); // slackUserId -> githubUsername
  private recentEvents = new Map<string, number>(); // eventKey -> timestamp
  private messageReactions = new Map<string, { channel: string; ts: string }>(); // sessionKey -> message info
  private repositoryCache = new Map<string, { repository: any; timestamp: number }>(); // username -> {repository, timestamp}
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

  constructor(
    private app: App,
    private jobManager: KubernetesJobManager,
    private repoManager: GitHubRepositoryManager,
    private config: DispatcherConfig
  ) {
    this.setupEventHandlers();
    this.startCachePrewarming();
  }

  /**
   * Check if this is a duplicate event
   */
  private isDuplicateEvent(userId: string, messageTs: string, text: string): boolean {
    const eventKey = `${userId}-${messageTs}-${text.substring(0, 50)}`;
    const now = Date.now();
    const lastSeen = this.recentEvents.get(eventKey);
    
    // If we've seen this event in the last 5 seconds, it's a duplicate
    if (lastSeen && now - lastSeen < 5000) {
      logger.info(`Duplicate event detected: ${eventKey}`);
      return true;
    }
    
    // Store this event
    this.recentEvents.set(eventKey, now);
    
    // Clean up old events (older than 10 seconds)
    for (const [key, timestamp] of this.recentEvents.entries()) {
      if (now - timestamp > 10000) {
        this.recentEvents.delete(key);
      }
    }
    
    return false;
  }

  /**
   * Setup Slack event handlers
   */
  private setupEventHandlers(): void {
    logger.info("Setting up Slack event handlers...");
    
    // Handle app mentions
    this.app.event("app_mention", async ({ event, client, say }) => {
      const handlerStartTime = Date.now();
      logger.info("=== APP_MENTION HANDLER TRIGGERED ===");
      logger.info(`[TIMING] Handler triggered at: ${new Date(handlerStartTime).toISOString()}`);
      logger.info(`[TIMING] Message timestamp: ${event.ts} (${new Date(parseFloat(event.ts) * 1000).toISOString()})`);
      logger.info(`[TIMING] Slack->Handler delay: ${handlerStartTime - (parseFloat(event.ts) * 1000)}ms`);
      logger.debug("Raw event object keys:", Object.keys(event));
      logger.debug("Event user field:", event.user);
      
      try {
        const context = this.extractSlackContext(event);
        logger.debug("Extracted context:", context);
        
        // Check if we have a valid user ID
        if (!context.userId) {
          logger.error("No user ID found in app_mention event. Context:", context);
          logger.error("Full event object:", JSON.stringify(event, null, 2));
          await say({
            thread_ts: context.threadTs,
            text: "❌ Error: Unable to identify user. Please try again.",
          });
          return;
        }
        
        // Check for duplicate events
        if (this.isDuplicateEvent(context.userId, context.messageTs, context.text)) {
          logger.info("Skipping duplicate app_mention event");
          return;
        }
        
        // Check permissions
        if (!this.isUserAllowed(context.userId)) {
          await say({
            thread_ts: context.threadTs,
            text: "Sorry, you don't have permission to use this bot.",
          });
          return;
        }

        // Add "eyes" emoji to indicate we're processing the message
        try {
          await client.reactions.add({
            channel: context.channelId,
            timestamp: context.messageTs,
            name: "eyes",
          });
        } catch (reactionError) {
          logger.error("Failed to add processing reaction:", reactionError);
        }

        // Extract user request (remove bot mention)
        const userRequest = this.extractUserRequest(context.text);
        
        logger.info(`[TIMING] Starting handleUserRequest at: ${new Date().toISOString()}`);
        await this.handleUserRequest(context, userRequest, client);
        
      } catch (error) {
        logger.error("Error handling app mention:", error);
        
        // Try to add error reaction
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

    // Handle view submissions (dialog/modal submissions)
    this.app.view(/.*/, async ({ ack, body, view, client }) => {
      logger.info("=== VIEW SUBMISSION HANDLER TRIGGERED ===");
      logger.info("View ID:", view.id);
      logger.info("View callback_id:", view.callback_id);
      
      // Acknowledge the view submission
      await ack();
      
      try {
        const userId = body.user.id;
        const metadata = view.private_metadata ? JSON.parse(view.private_metadata) : {};
        const channelId = metadata.channel_id;
        const threadTs = metadata.thread_ts;
        
        // Extract user inputs from the view state
        const userInput = this.extractViewInputs(view.state.values);
        
        logger.info(`Processing view submission from user ${userId}`);
        logger.info(`User input: ${userInput}`);
        
        // Post the user's input as a message in the thread
        if (channelId && threadTs) {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: userInput,
            user: userId
          });
          
          // Continue the Claude session with the user's input
          const context = {
            channelId,
            userId,
            userDisplayName: body.user.name || 'Unknown User',
            teamId: body.team?.id || '',
            messageTs: threadTs,
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
    logger.info("Registering action handler for all interactive components...");
    this.app.action(/.*/, async ({ action, ack, client, body }) => {
      logger.info("=== ACTION HANDLER TRIGGERED ===");
      logger.info("Action ID:", (action as any).action_id);
      logger.info("Action type:", action.type);
      
      // Acknowledge the action immediately
      await ack();
      
      try {
        const actionId = (action as any).action_id;
        const userId = body.user.id;
        const channelId = (body as any).channel?.id || (body as any).container?.channel_id;
        const messageTs = (body as any).message?.ts || (body as any).container?.message_ts;
        
        logger.info(`Handling action ${actionId} from user ${userId}`);
        
        // Check permissions
        if (!this.isUserAllowed(userId)) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: "Sorry, you don't have permission to use this action.",
          });
          return;
        }
        
        // Handle different action types
        await this.handleBlockAction(actionId, userId, channelId, messageTs, body, client);
        
      } catch (error) {
        logger.error("Error handling action:", error);
        
        // Send error message as ephemeral
        const userId = body.user.id;
        const channelId = (body as any).channel?.id || (body as any).container?.channel_id;
        
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
        });
      }
    });

    // Handle direct messages
    this.app.message(async ({ message, client, say }) => {
      logger.info("=== MESSAGE HANDLER TRIGGERED ===");
      logger.debug("Message channel_type:", message.channel_type);
      logger.debug("Message subtype:", message.subtype);
      logger.debug("Message object keys:", Object.keys(message));
      logger.debug("Message user field:", (message as any).user);
      
      // Skip our own bot's messages to prevent loops
      const botUserId = this.config.slack.botUserId;
      const botId = this.config.slack.botId;
      if ((message as any).user === botUserId || (message as any).bot_id === botId) {
        logger.debug(`Skipping our own bot's message (user: ${botUserId}, bot: ${botId})`);
        return;
      }
      
      // IMPORTANT: Skip channel messages with bot mentions immediately
      // These are handled by the app_mention handler to prevent duplicate processing
      const messageText = (message as any).text || '';
      if (message.channel_type === 'channel' && messageText.includes(`<@${botUserId}>`)) {
        logger.debug("Skipping channel message with bot mention - handled by app_mention");
        return;
      }
      
      // Handle both DMs and channel messages where the bot is mentioned
      // For channel messages, we rely on the app_mention handler above
      // This handler will process DMs and bot_message subtypes (for bot-to-bot communication)
      
      // Ignore message subtypes that are not actual user messages
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
      
      // Allow bot messages - removed bot filtering to enable bot-to-bot communication
      
      try {
        const context = this.extractSlackContext(message);
        logger.debug("Extracted context from message:", context);
        
        // Check if we have a valid user ID
        if (!context.userId) {
          logger.error("No user ID found in message event. Context:", context);
          logger.error("Full message object:", JSON.stringify(message, null, 2));
          await say("❌ Error: Unable to identify user. Please try again.");
          return;
        }
        
        // Check for duplicate events
        if (this.isDuplicateEvent(context.userId, context.messageTs, context.text)) {
          logger.info("Skipping duplicate message event");
          return;
        }
        
        // Check permissions
        if (!this.isUserAllowed(context.userId)) {
          await say("Sorry, you don't have permission to use this bot.");
          return;
        }

        // Add "eyes" emoji to indicate we're processing the message
        try {
          await client.reactions.add({
            channel: context.channelId,
            timestamp: context.messageTs,
            name: "eyes",
          });
        } catch (reactionError) {
          logger.error("Failed to add processing reaction:", reactionError);
        }

        const userRequest = this.extractUserRequest(context.text);
        await this.handleUserRequest(context, userRequest, client);
        
      } catch (error) {
        logger.error("Error handling direct message:", error);
        await say(`❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`);
      }
    });
  }

  /**
   * Handle user request by routing to appropriate worker
   */
  private async handleUserRequest(
    context: SlackContext,
    userRequest: string,
    client: any
  ): Promise<void> {
    const requestStartTime = Date.now();
    logger.info(`[TIMING] handleUserRequest started at: ${new Date(requestStartTime).toISOString()}`);
    
    // Generate session key (thread-based or new)
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

    // Check if we should reuse a recent worker (5-minute window)
    const existingSession = this.activeSessions.get(sessionKey);
    if (existingSession && existingSession.status === "running") {
      // Queue the message instead of blocking
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: context.threadTs,
        text: "📝 Message queued - I'll process this after completing the current task.",
        mrkdwn: true,
      });
      
      // Store the queued message for later processing
      // Note: In stateless approach, the next worker will pick up all conversation history
      return;
    }

    try {
      // Parallel API calls for better performance
      const parallelStartTime = Date.now();
      
      // Start all parallel operations
      const [username, conversationHistory] = await Promise.all([
        // Get or create user's GitHub username mapping
        this.getOrCreateUserMapping(context.userId, client),
        
        // Fetch conversation history from Slack if this is a thread
        context.threadTs 
          ? this.fetchConversationHistory(context.channelId, context.threadTs, client)
          : Promise.resolve([{
              role: 'user',
              content: userRequest,
              timestamp: parseFloat(context.messageTs) * 1000
            }])
      ]);
      
      logger.info(`[TIMING] Parallel operations took ${Date.now() - parallelStartTime}ms`);
      logger.info(`Session ${sessionKey} - fetched ${conversationHistory.length} messages from thread`);
      
      // Check repository cache first
      let repository;
      const cachedRepo = this.repositoryCache.get(username);
      if (cachedRepo && Date.now() - cachedRepo.timestamp < this.CACHE_TTL) {
        repository = cachedRepo.repository;
        logger.info(`Using cached repository for ${username}`);
      } else {
        // Ensure user repository exists
        repository = await this.repoManager.ensureUserRepository(username);
        // Cache the repository info
        this.repositoryCache.set(username, { repository, timestamp: Date.now() });
      }
      
      // If this is not already a thread, use the current message timestamp as thread_ts
      const threadTs = context.threadTs || context.messageTs;
      
      // Create thread session BEFORE posting to Slack
      const threadSession: ThreadSession = {
        sessionKey,
        threadTs: threadTs,
        channelId: context.channelId,
        userId: context.userId,
        username,
        repositoryUrl: repository.repositoryUrl,
        lastActivity: Date.now(),
        status: "pending",
        createdAt: Date.now(),
      };

      this.activeSessions.set(sessionKey, threadSession);
      
      // Store message info for reaction updates
      this.messageReactions.set(sessionKey, {
        channel: context.channelId,
        ts: context.messageTs,
      });

      // Post initial Slack response with conversation history in metadata
      logger.info(`[TIMING] Posting initial response at: ${new Date().toISOString()}`);
      const initialResponse = await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: threadTs,
        text: "🚀 Starting Claude session...",
        blocks: this.formatInitialResponseBlocks(sessionKey, username, repository.repositoryUrl, undefined, "🚀 Starting Claude session..."),
        metadata: {
          event_type: "claude_session",
          event_payload: {
            sessionKey,
            conversationHistory: JSON.stringify(conversationHistory),
            lastActivity: Date.now(),
            repositoryUrl: repository.repositoryUrl
          }
        }
      });
      
      // Now create the Kubernetes job with the Slack response timestamp
      logger.info(`[TIMING] Creating worker job at: ${new Date().toISOString()}`);
      const jobCreateStart = Date.now();
      
      const jobRequest: WorkerJobRequest = {
        sessionKey,
        userId: context.userId,
        username,
        channelId: context.channelId,
        threadTs: threadTs,
        userPrompt: userRequest,
        repositoryUrl: repository.repositoryUrl,
        slackResponseChannel: context.channelId,
        slackResponseTs: initialResponse.ts!, // Now we have the actual timestamp
        originalMessageTs: context.messageTs,
        claudeOptions: {
          ...this.config.claude,
          timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
        },
        conversationHistory,
      };

      const jobName = await this.jobManager.createWorkerJob(jobRequest);
      logger.info(`[TIMING] Worker job created in ${Date.now() - jobCreateStart}ms`);
      
      // Update session with job info
      threadSession.jobName = jobName;
      threadSession.status = "starting";
      
      // Start monitoring job for status updates
      this.monitorJobStatus(sessionKey, jobName, context.channelId, context.messageTs, client);
      
      logger.info(`Created worker job ${jobName} for session ${sessionKey}`);

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
      
      // Format error message with debugging info
      let errorMessage = `❌ *Error:* ${error instanceof Error ? error.message : "Unknown error occurred"}`;
      
      // If we have a job name, add debugging commands
      const session = this.activeSessions.get(sessionKey);
      if (session?.jobName) {
        errorMessage += `\n\n${this.formatKubectlCommands(session.jobName, this.config.kubernetes.namespace)}`;
      }
      
      // Add generic debugging tips
      errorMessage += `\n\n*💡 Troubleshooting Tips:*
• Check dispatcher logs: \`kubectl logs -n ${this.config.kubernetes.namespace} -l app.kubernetes.io/component=dispatcher --tail=100\`
• Check events: \`kubectl get events -n ${this.config.kubernetes.namespace} --sort-by='.lastTimestamp'\`
• Check job quota: \`kubectl describe resourcequota -n ${this.config.kubernetes.namespace}\``;
      
      // Post error message - ALWAYS in thread
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
    // Comprehensive debug logging
    logger.debug("=== FULL SLACK EVENT DEBUG ===");
    logger.debug("Event type:", event.type);
    logger.debug("Event subtype:", event.subtype);
    logger.debug("Event user:", event.user);
    logger.debug("Event bot_id:", (event as any).bot_id);
    logger.debug("Event channel:", event.channel);
    logger.debug("Event channel_type:", event.channel_type);
    logger.debug("Event team:", event.team);
    logger.debug("Event ts:", event.ts);
    logger.debug("Event thread_ts:", event.thread_ts);
    logger.debug("Full event JSON:", JSON.stringify(event, null, 2));
    logger.debug("=== END EVENT DEBUG ===");
    
    // Log if this is a bot message (but don't ignore it)
    if ((event as any).bot_id || event.subtype === 'bot_message') {
      logger.debug("Processing bot message from bot_id:", (event as any).bot_id);
    }
    
    return {
      channelId: event.channel,
      userId: event.user,
      teamId: event.team || "",
      threadTs: event.thread_ts,
      messageTs: event.ts,
      text: event.text || "",
    };
  }

  /**
   * Extract user request from mention text
   */
  private extractUserRequest(text: string): string {
    // Remove bot mention and clean up text
    // Only remove Slack's formatted mentions like <@U123456>
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
    
    // Check blocked users first
    if (blockedUsers?.includes(userId)) {
      return false;
    }
    
    // If allowedUsers is specified, user must be in the list
    if (allowedUsers && allowedUsers.length > 0) {
      return allowedUsers.includes(userId);
    }
    
    // Default to allow if no restrictions specified
    return true;
  }

  /**
   * Fetch conversation history from Slack thread
   */
  private async fetchConversationHistory(
    channelId: string, 
    threadTs: string | undefined,
    client: any
  ): Promise<Array<{ role: string; content: string; timestamp: number }>> {
    if (!threadTs) {
      return [];
    }

    try {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 100, // Get up to 100 messages in the thread
      });

      if (!result.messages || result.messages.length === 0) {
        return [];
      }

      // Convert Slack messages to conversation format
      const conversation = result.messages
        .filter((msg: any) => msg.text && msg.user) // Filter out system messages
        .map((msg: any) => ({
          role: msg.user === this.config.slack.botUserId ? 'assistant' : 'user',
          content: msg.text,
          timestamp: parseFloat(msg.ts) * 1000, // Convert Slack timestamp to milliseconds
        }));

      logger.info(`Fetched ${conversation.length} messages from thread ${threadTs}`);
      return conversation;
    } catch (error) {
      logger.error(`Failed to fetch conversation history: ${error}`);
      return [];
    }
  }

  /**
   * Get or create GitHub username mapping for Slack user
   */
  private async getOrCreateUserMapping(slackUserId: string | undefined, client: any): Promise<string> {
    // Handle undefined user ID
    if (!slackUserId) {
      logger.error("Slack user ID is undefined");
      return "user-unknown";
    }
    
    // Check if mapping already exists
    const existingMapping = this.userMappings.get(slackUserId);
    if (existingMapping) {
      return existingMapping;
    }

    // Get user info from Slack
    try {
      const userInfo = await client.users.info({ user: slackUserId });
      const user = userInfo.user;
      
      // Try to use Slack display name or real name as GitHub username
      let username = user.profile?.display_name || user.profile?.real_name || user.name;
      
      // Clean up username for GitHub (remove spaces, special chars, etc.)
      username = username.toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      
      // Ensure username is valid and unique
      username = `user-${username}`;
      
      // Store mapping
      this.userMappings.set(slackUserId, username);
      
      logger.info(`Created user mapping: ${slackUserId} -> ${username}`);
      return username;
      
    } catch (error) {
      logger.error(`Failed to get user info for ${slackUserId}:`, error);
      
      // Fallback to generic username
      const fallbackUsername = slackUserId ? `user-${slackUserId.substring(0, 8)}` : "user-unknown";
      if (slackUserId) {
        this.userMappings.set(slackUserId, fallbackUsername);
      }
      return fallbackUsername;
    }
  }

  /**
   * Format initial response message as blocks
   */
  private formatInitialResponseBlocks(sessionKey: string, username: string, repositoryUrl: string, _jobName?: string, statusText: string = "🔄 Creating pod..."): any[] {
    const blocks: any[] = [];
    
    // Context header with key info
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `🔖 ${sessionKey}`
        },
        {
          type: "mrkdwn",
          text: `📁 <${repositoryUrl.replace('github.com', 'github.dev')}|${username}>`
        },
        {
          type: "mrkdwn",
          text: `🔀 <${repositoryUrl}/compare|Create PR>`
        }
      ]
    });
    
    // Divider
    blocks.push({
      type: "divider"
    });
    
    // Status message
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: statusText
      }
    });
    
    return blocks;
  }

  /**
   * Format kubectl commands for debugging
   */
  private formatKubectlCommands(jobName: string, namespace: string): string {
    return `
*🛠️ Debugging Commands:*
\`\`\`
# Watch job logs in real-time
kubectl logs -n ${namespace} job/${jobName} -f

# Get job status
kubectl get job/${jobName} -n ${namespace} -o wide

# Get pod details
kubectl get pods -n ${namespace} -l job-name=${jobName} -o wide

# Describe job for events
kubectl describe job/${jobName} -n ${namespace}

# Get pod logs if job failed
kubectl logs -n ${namespace} -l job-name=${jobName} --tail=100
\`\`\``;
  }

  /**
   * Monitor job status and update reactions
   */
  private async monitorJobStatus(
    sessionKey: string,
    jobName: string,
    channelId: string,
    messageTs: string,
    client: any
  ): Promise<void> {
    const maxAttempts = 120; // Monitor for up to 10 minutes (5s intervals)
    let attempts = 0;
    let lastStatus: string | null = null;
    
    const checkStatus = async () => {
      try {
        attempts++;
        
        // Get job status from job manager
        const jobStatus = await this.jobManager.getJobStatus(jobName);
        
        // Update reaction based on status change
        if (jobStatus !== lastStatus) {
          logger.info(`Job ${jobName} status changed: ${lastStatus} -> ${jobStatus}`);
          
          // Remove previous reaction if exists
          if (lastStatus) {
            const previousEmoji = this.getEmojiForStatus(lastStatus);
            if (previousEmoji) {
              try {
                await client.reactions.remove({
                  channel: channelId,
                  timestamp: messageTs,
                  name: previousEmoji,
                });
              } catch (e) {
                // Ignore removal errors
              }
            }
          }
          
          // Add new reaction
          const newEmoji = this.getEmojiForStatus(jobStatus);
          if (newEmoji) {
            try {
              await client.reactions.add({
                channel: channelId,
                timestamp: messageTs,
                name: newEmoji,
              });
            } catch (e) {
              logger.error(`Failed to add ${newEmoji} reaction:`, e);
            }
          }
          
          lastStatus = jobStatus;
        }
        
        // Check if job is complete
        if (jobStatus === "completed" || jobStatus === "failed" || jobStatus === "error") {
          logger.info(`Job ${jobName} monitoring complete with status: ${jobStatus}`);
          const session = this.activeSessions.get(sessionKey);
          if (session) {
            session.status = jobStatus as any;
            session.lastActivity = Date.now();
          }
          
          // Clean up session after 5-minute delay for worker reuse
          setTimeout(() => {
            this.activeSessions.delete(sessionKey);
            this.messageReactions.delete(sessionKey);
            logger.info(`Session ${sessionKey} cleaned up after 5-minute reuse window`);
          }, 5 * 60 * 1000); // 5 minutes for worker reuse
          
          return; // Stop monitoring
        }
        
        // Continue monitoring if not complete and under max attempts
        if (attempts < maxAttempts) {
          setTimeout(checkStatus, 5000); // Check every 5 seconds
        } else {
          logger.warn(`Job ${jobName} monitoring timeout after ${maxAttempts} attempts`);
          // Set timeout reaction
          try {
            await client.reactions.remove({
              channel: channelId,
              timestamp: messageTs,
              name: this.getEmojiForStatus(lastStatus) || "eyes",
            });
            await client.reactions.add({
              channel: channelId,
              timestamp: messageTs,
              name: "hourglass",
            });
          } catch (e) {
            logger.error("Failed to set timeout reaction:", e);
          }
        }
      } catch (error) {
        logger.error(`Error monitoring job ${jobName}:`, error);
        // Continue monitoring on error
        if (attempts < maxAttempts) {
          setTimeout(checkStatus, 5000);
        }
      }
    };
    
    // Start monitoring
    setTimeout(checkStatus, 1000); // Start checking after 1 second
  }
  
  /**
   * Get emoji for job status
   */
  private getEmojiForStatus(status: string): string | null {
    switch (status) {
      case "pending":
      case "starting":
        return "eyes";
      case "running":
        return "gear";
      case "completed":
        return "white_check_mark";
      case "failed":
      case "error":
        return "x";
      case "timeout":
        return "hourglass";
      default:
        return null;
    }
  }
  
  /**
   * Handle job completion notification
   */
  async handleJobCompletion(sessionKey: string, success: boolean, client?: any): Promise<void> {
    const session = this.activeSessions.get(sessionKey);
    if (!session) return;

    session.status = success ? "completed" : "error";
    session.lastActivity = Date.now();

    // Log completion
    logger.info(`Job completed for session ${sessionKey}: ${success ? "success" : "failure"}`);
    
    // Update reaction on original message
    const messageInfo = this.messageReactions.get(sessionKey);
    if (messageInfo && client) {
      try {
        // Remove "eyes" reaction
        await client.reactions.remove({
          channel: messageInfo.channel,
          timestamp: messageInfo.ts,
          name: "eyes",
        });
        
        // Add completion reaction
        await client.reactions.add({
          channel: messageInfo.channel,
          timestamp: messageInfo.ts,
          name: success ? "white_check_mark" : "x",
        });
      } catch (reactionError) {
        logger.error("Failed to update completion reaction:", reactionError);
      }
    }
    
    // Clean up session after some time
    setTimeout(() => {
      this.activeSessions.delete(sessionKey);
    }, 60000); // Clean up after 1 minute
  }

  /**
   * Handle job timeout
   */
  async handleJobTimeout(sessionKey: string): Promise<void> {
    const session = this.activeSessions.get(sessionKey);
    if (!session) return;

    session.status = "timeout";
    session.lastActivity = Date.now();

    logger.warn(`Job timed out for session ${sessionKey}`);
    
    // Clean up immediately
    this.activeSessions.delete(sessionKey);
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
   * Handle block actions from interactive components
   */
  private async handleBlockAction(
    actionId: string,
    userId: string,
    channelId: string,
    messageTs: string,
    body: any,
    client: any
  ): Promise<void> {
    logger.info(`Processing action: ${actionId}`);
    logger.debug('Action body type:', body.type);
    logger.debug('Action body:', JSON.stringify(body, null, 2).substring(0, 500));
    
    // Get user's GitHub username
    const githubUsername = await this.getOrCreateUserMapping(userId, client);
    
    // Extract action value (script content) if present
    const action = body.actions?.[0];
    const scriptContent = action?.value;
    
    // Check if this is a blockkit action that should open a dialog
    if (actionId.startsWith('blockkit_') && action?.type === 'button') {
      // Extract the blockkit content from the button value
      const blockContent = scriptContent;
      if (blockContent) {
        try {
          const blocks = JSON.parse(blockContent);
          
          // Check if this should open a modal/dialog
          if (action.confirm || blocks.type === 'modal') {
            // Open a modal with the blockkit content
            await client.views.open({
              trigger_id: (body as any).trigger_id,
              view: {
                type: 'modal',
                callback_id: actionId,
                title: {
                  type: 'plain_text',
                  text: action.text?.text || 'Input Required'
                },
                blocks: blocks.blocks || blocks,
                submit: {
                  type: 'plain_text',
                  text: 'Submit'
                },
                close: {
                  type: 'plain_text',
                  text: 'Cancel'
                },
                private_metadata: JSON.stringify({
                  channel_id: channelId,
                  thread_ts: messageTs,
                  action_id: actionId
                })
              }
            });
            return;
          }
        } catch (e) {
          logger.error('Failed to parse blockkit content:', e);
        }
      }
    }
    
    // Check if this is a script execution action (starts with language prefix)
    if (actionId.startsWith('bash_') || actionId.startsWith('python_') || 
        actionId.startsWith('javascript_') || actionId.startsWith('typescript_')) {
      
      const language = actionId.split('_')[0] || '';
      await this.handleScriptExecution(
        language,
        scriptContent || '',
        userId,
        githubUsername,
        channelId,
        messageTs,
        client
      );
      return;
    }
    
    // Handle predefined actions
    switch (actionId) {
      case "deploy_production":
        await this.handleDeployAction(userId, githubUsername, channelId, messageTs, client, "production");
        break;
        
      case "deploy_staging":
        await this.handleDeployAction(userId, githubUsername, channelId, messageTs, client, "staging");
        break;
        
      case "run_tests":
        await this.handleRunTestsAction(userId, githubUsername, channelId, messageTs, client);
        break;
        
      case "create_pr":
        await this.handleCreatePRAction(userId, githubUsername, channelId, messageTs, client);
        break;
        
      case "approve_changes":
        await this.handleApproveAction(userId, githubUsername, channelId, messageTs, client);
        break;
        
      default:
        // For custom actions, create a new Claude session with the action as a command
        await this.handleCustomAction(actionId, userId, githubUsername, channelId, messageTs, client, body);
        break;
    }
  }
  
  /**
   * Handle deployment actions
   */
  private async handleDeployAction(
    userId: string,
    githubUsername: string,
    channelId: string,
    messageTs: string,
    client: any,
    environment: string
  ): Promise<void> {
    // Create a new Claude session to handle the deployment
    const deployCommand = `Deploy the current changes to ${environment}`;
    await this.createActionWorkerJob(userId, githubUsername, channelId, messageTs, deployCommand, client);
  }
  
  /**
   * Handle run tests action
   */
  private async handleRunTestsAction(
    userId: string,
    githubUsername: string,
    channelId: string,
    messageTs: string,
    client: any
  ): Promise<void> {
    const testCommand = "Run all tests and show me the results";
    await this.createActionWorkerJob(userId, githubUsername, channelId, messageTs, testCommand, client);
  }
  
  /**
   * Handle create PR action
   */
  private async handleCreatePRAction(
    userId: string,
    githubUsername: string,
    channelId: string,
    messageTs: string,
    client: any
  ): Promise<void> {
    const prCommand = "Create a pull request with the current changes";
    await this.createActionWorkerJob(userId, githubUsername, channelId, messageTs, prCommand, client);
  }
  
  /**
   * Handle approve action
   */
  private async handleApproveAction(
    userId: string,
    _githubUsername: string,
    channelId: string,
    _messageTs: string,
    client: any
  ): Promise<void> {
    // Send confirmation message
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: "✅ Changes approved! The modifications have been marked as reviewed.",
    });
  }
  
  /**
   * Handle script execution actions
   */
  private async handleScriptExecution(
    language: string,
    scriptContent: string,
    userId: string,
    githubUsername: string,
    channelId: string,
    messageTs: string,
    client: any
  ): Promise<void> {
    // Construct command based on language
    let command = '';
    switch (language) {
      case 'bash':
        command = `Run the following bash script:\n\`\`\`bash\n${scriptContent}\n\`\`\``;
        break;
      case 'python':
        command = `Run the following Python script using uv:\n\`\`\`python\n${scriptContent}\n\`\`\``;
        break;
      case 'javascript':
      case 'typescript':
        command = `Run the following ${language} script using bun:\n\`\`\`${language}\n${scriptContent}\n\`\`\``;
        break;
      default:
        command = `Execute: ${scriptContent}`;
    }
    
    // Create a worker job to execute the script
    await this.createActionWorkerJob(userId, githubUsername, channelId, messageTs, command, client);
  }
  
  /**
   * Get user display name
   */
  private async getUserDisplayName(userId: string, client: any): Promise<string> {
    try {
      const userInfo = await client.users.info({ user: userId });
      return userInfo.user?.real_name || userInfo.user?.name || "Unknown User";
    } catch (error) {
      logger.error(`Failed to get user info for ${userId}:`, error);
      return "Unknown User";
    }
  }

  /**
   * Handle custom actions
   */
  private async handleCustomAction(
    actionId: string,
    userId: string,
    _githubUsername: string,
    channelId: string,
    messageTs: string,
    client: any,
    body?: any
  ): Promise<void> {
    // Get the actual button that was clicked
    const action = body?.actions?.[0];
    const buttonText = action?.text?.text || actionId.replace(/_/g, " ");
    const buttonValue = action?.value || "";
    
    // Check if this is in a thread (indicates ongoing conversation)
    const threadTs = body?.message?.thread_ts || messageTs;
    
    // Post a message indicating what the user clicked
    const clickMessage = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🔘 <@${userId}> clicked: "${buttonText}"`,
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `<@${userId}> selected *${buttonText}*`
            }
          ]
        }
      ]
    });
    
    // Construct a meaningful prompt for Claude
    let prompt = `The user clicked the "${buttonText}" button`;
    if (buttonValue && buttonValue !== actionId) {
      prompt += ` (value: ${buttonValue})`;
    }
    if (actionId && actionId !== buttonText.replace(/\s+/g, "_")) {
      prompt += ` [action_id: ${actionId}]`;
    }
    prompt += `. Please proceed with this selection and help them accordingly.`;
    
    // Create context for continuing the conversation
    const context: SlackContext = {
      channelId,
      userId,
      userDisplayName: await this.getUserDisplayName(userId, client),
      teamId: (body as any).team?.id || "",
      messageTs: clickMessage.ts as string,
      threadTs: threadTs,
      text: prompt,
    };
    
    // Handle as a continuation of the conversation
    await this.handleUserRequest(context, prompt, client);
  }
  
  /**
   * Create a worker job for an action
   */
  private async createActionWorkerJob(
    userId: string,
    _githubUsername: string,
    channelId: string,
    messageTs: string,
    command: string,
    client: any
  ): Promise<void> {
    // Get user info for context
    const userInfo = await client.users.info({ user: userId });
    const userDisplayName = userInfo.user?.real_name || userInfo.user?.name || "Unknown User";
    
    // Create context for the action
    const context: SlackContext = {
      channelId,
      userId,
      userDisplayName,
      teamId: "", // Will be filled if needed
      messageTs,
      threadTs: messageTs, // Use message as thread
      text: command,
    };
    
    // Handle the request as a new command
    await this.handleUserRequest(context, command, client);
  }

  /**
   * Extract user inputs from view state
   */
  private extractViewInputs(stateValues: any): string {
    const inputs: string[] = [];
    
    // Iterate through all blocks and actions to extract values
    for (const blockId in stateValues) {
      const block = stateValues[blockId];
      for (const actionId in block) {
        const action = block[actionId];
        
        // Handle different input types
        if (action.type === 'plain_text_input') {
          inputs.push(action.value || '');
        } else if (action.type === 'static_select') {
          const selected = action.selected_option;
          if (selected) {
            inputs.push(`Selected: ${selected.text?.text || selected.value}`);
          }
        } else if (action.type === 'multi_static_select') {
          const selected = action.selected_options || [];
          const values = selected.map((opt: any) => opt.text?.text || opt.value);
          if (values.length > 0) {
            inputs.push(`Selected: ${values.join(', ')}`);
          }
        } else if (action.type === 'checkboxes') {
          const selected = action.selected_options || [];
          const values = selected.map((opt: any) => opt.text?.text || opt.value);
          if (values.length > 0) {
            inputs.push(`Checked: ${values.join(', ')}`);
          }
        } else if (action.type === 'radio_buttons') {
          const selected = action.selected_option;
          if (selected) {
            inputs.push(`Selected: ${selected.text?.text || selected.value}`);
          }
        } else if (action.type === 'datepicker') {
          if (action.selected_date) {
            inputs.push(`Date: ${action.selected_date}`);
          }
        } else if (action.type === 'timepicker') {
          if (action.selected_time) {
            inputs.push(`Time: ${action.selected_time}`);
          }
        } else if (action.value) {
          // Generic fallback for any input with a value
          inputs.push(action.value);
        }
      }
    }
    
    // Join all inputs or return a default message
    return inputs.length > 0 ? inputs.join('\n') : 'Form submitted';
  }

  /**
   * Pre-warm caches for frequently used data
   */
  private startCachePrewarming(): void {
    // Clean up stale cache entries periodically
    setInterval(() => {
      const now = Date.now();
      for (const [username, cached] of this.repositoryCache.entries()) {
        if (now - cached.timestamp > this.CACHE_TTL) {
          this.repositoryCache.delete(username);
          logger.info(`Evicted stale repository cache for ${username}`);
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Cleanup all sessions
   */
  async cleanup(): Promise<void> {
    // Clear local maps
    this.activeSessions.clear();
    this.userMappings.clear();
    this.repositoryCache.clear();
  }
}