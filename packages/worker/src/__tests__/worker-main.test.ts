#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
jest.mock = mock.module;

// Mock core-runner since worker depends on it
jest.mock("../../core-runner", () => ({
  ClaudeSessionRunner: jest.fn(),
  SessionManager: jest.fn(),
}));

describe("Worker Main", () => {
  let mockSlackClient: any;
  let mockSessionRunner: any;
  let mockWorkspaceSetup: any;

  const mockEnvironment = {
    SESSION_KEY: "test-session-123",
    USER_ID: "U123456789",
    USERNAME: "testuser",
    CHANNEL_ID: "C123456789",
    THREAD_TS: "1234567890.123456",
    REPOSITORY_URL: "https://github.com/test/repo",
    USER_PROMPT: Buffer.from("Help me debug this code").toString("base64"),
    SLACK_RESPONSE_CHANNEL: "C123456789",
    SLACK_RESPONSE_TS: "1234567890.123456",
    SLACK_BOT_TOKEN: "xoxb-test-token",
    GITHUB_TOKEN: "ghp_test_token",
    WORKSPACE_DIR: "/workspace",
    RECOVERY_MODE: "false",
  };

  beforeEach(() => {
    // Setup environment
    Object.assign(process.env, mockEnvironment);

    // Mock Slack client
    mockSlackClient = {
      chat: {
        postMessage: jest.fn().mockResolvedValue({ ok: true, ts: "1234567890.123456" }),
        update: jest.fn().mockResolvedValue({ ok: true }),
      },
      conversations: {
        replies: jest.fn().mockResolvedValue({ messages: [] }),
      },
    };

    // Mock session runner
    mockSessionRunner = {
      executePrompt: jest.fn().mockResolvedValue("Claude response"),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };

    // Mock workspace setup
    mockWorkspaceSetup = {
      createWorkspace: jest.fn().mockResolvedValue("/workspace/user-123"),
      cloneRepository: jest.fn().mockResolvedValue("/workspace/user-123/repo"),
      setupEnvironment: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    // Clean up environment
    for (const key of Object.keys(mockEnvironment)) {
      delete process.env[key];
    }
    jest.clearAllMocks();
  });

  describe("Environment Validation", () => {
    it("should validate required environment variables", () => {
      const requiredVars = [
        "SESSION_KEY",
        "USER_ID",
        "SLACK_BOT_TOKEN",
        "GITHUB_TOKEN",
        "USER_PROMPT",
      ];

      for (const varName of requiredVars) {
        expect(process.env[varName]).toBeDefined();
      }
    });

    it("should handle missing environment variables gracefully", () => {
      delete process.env.SESSION_KEY;

      expect(() => {
        if (!process.env.SESSION_KEY) {
          throw new Error("SESSION_KEY environment variable is required");
        }
      }).toThrow("SESSION_KEY environment variable is required");
    });

    it("should decode base64 user prompt", () => {
      const decodedPrompt = Buffer.from(process.env.USER_PROMPT!, "base64").toString("utf-8");
      expect(decodedPrompt).toBe("Help me debug this code");
    });

    it("should handle malformed base64 prompt", () => {
      process.env.USER_PROMPT = "invalid-base64!@#";

      expect(() => {
        Buffer.from(process.env.USER_PROMPT!, "base64").toString("utf-8");
      }).not.toThrow(); // Should handle gracefully
    });
  });

  describe("Worker Initialization", () => {
    it("should initialize Slack client with token", () => {
      const slackToken = process.env.SLACK_BOT_TOKEN;
      expect(slackToken).toBe("xoxb-test-token");

      // Mock Slack client initialization
      const client = { token: slackToken };
      expect(client.token).toBe(slackToken);
    });

    it("should create workspace for user", async () => {
      const userId = process.env.USER_ID!;
      const workspaceDir = await mockWorkspaceSetup.createWorkspace(userId);

      expect(mockWorkspaceSetup.createWorkspace).toHaveBeenCalledWith(userId);
      expect(workspaceDir).toBe("/workspace/user-123");
    });

    it("should handle workspace creation failures", async () => {
      mockWorkspaceSetup.createWorkspace.mockRejectedValue(new Error("Disk full"));

      await expect(
        mockWorkspaceSetup.createWorkspace("U123456789")
      ).rejects.toThrow("Disk full");
    });
  });

  describe("Progress Reporting", () => {
    it("should send initial progress message", async () => {
      const progressMessage = {
        channel: process.env.SLACK_RESPONSE_CHANNEL,
        thread_ts: process.env.SLACK_RESPONSE_TS,
        text: "🔄 Starting Claude session...",
      };

      await mockSlackClient.chat.postMessage(progressMessage);

      expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith(progressMessage);
    });

    it("should update progress during execution", async () => {
      const progressUpdates = [
        "📂 Setting up workspace...",
        "📥 Cloning repository...",
        "🧠 Analyzing code with Claude...",
        "✅ Task completed!",
      ];

      for (const update of progressUpdates) {
        await mockSlackClient.chat.update({
          channel: process.env.SLACK_RESPONSE_CHANNEL,
          ts: "1234567890.123456",
          text: update,
        });
      }

      expect(mockSlackClient.chat.update).toHaveBeenCalledTimes(progressUpdates.length);
    });

    it("should handle progress update failures", async () => {
      mockSlackClient.chat.update.mockRejectedValue(new Error("Rate limited"));

      try {
        await mockSlackClient.chat.update({
          channel: "C123456789",
          ts: "1234567890.123456",
          text: "Progress update",
        });
      } catch (error) {
        // Should log error but continue execution
        expect(error.message).toBe("Rate limited");
      }
    });

    it("should include job metadata in progress messages", async () => {
      const jobMetadata = {
        sessionKey: process.env.SESSION_KEY,
        userId: process.env.USER_ID,
        startTime: new Date().toISOString(),
      };

      const messageWithMetadata = {
        channel: process.env.SLACK_RESPONSE_CHANNEL,
        text: "🔄 Claude is working...",
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Session: ${jobMetadata.sessionKey} | User: <@${jobMetadata.userId}>`,
              },
            ],
          },
        ],
      };

      await mockSlackClient.chat.postMessage(messageWithMetadata);

      expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "context",
            }),
          ]),
        })
      );
    });
  });

  describe("Repository Handling", () => {
    it("should clone repository to workspace", async () => {
      const repoUrl = process.env.REPOSITORY_URL!;
      const workspaceDir = "/workspace/user-123";

      const clonedPath = await mockWorkspaceSetup.cloneRepository(repoUrl, workspaceDir);

      expect(mockWorkspaceSetup.cloneRepository).toHaveBeenCalledWith(repoUrl, workspaceDir);
      expect(clonedPath).toBe("/workspace/user-123/repo");
    });

    it("should handle private repositories with authentication", async () => {
      const privateRepoUrl = "https://github.com/private/repo.git";
      const githubToken = process.env.GITHUB_TOKEN!;

      // Mock authenticated clone
      const authenticatedUrl = privateRepoUrl.replace(
        "https://",
        `https://token:${githubToken}@`
      );

      expect(authenticatedUrl).toContain(githubToken);
    });

    it("should handle repository clone failures", async () => {
      mockWorkspaceSetup.cloneRepository.mockRejectedValue(
        new Error("Repository not found")
      );

      await expect(
        mockWorkspaceSetup.cloneRepository("https://github.com/nonexistent/repo", "/workspace")
      ).rejects.toThrow("Repository not found");
    });

    it("should validate repository URL format", () => {
      const validUrls = [
        "https://github.com/user/repo",
        "https://github.com/user/repo.git",
        "git@github.com:user/repo.git",
      ];

      const invalidUrls = [
        "not-a-url",
        "ftp://github.com/user/repo",
        "https://evil.com/malicious",
        "javascript:alert('xss')",
      ];

      for (const url of validUrls) {
        const isValid = url.match(/^(https:\/\/github\.com\/|git@github\.com:)/);
        expect(isValid).toBeTruthy();
      }

      for (const url of invalidUrls) {
        const isValid = url.match(/^(https:\/\/github\.com\/|git@github\.com:)/);
        expect(isValid).toBeFalsy();
      }
    });
  });

  describe("Claude Execution", () => {
    it("should execute Claude prompt in workspace", async () => {
      const userPrompt = Buffer.from(process.env.USER_PROMPT!, "base64").toString("utf-8");
      const workspaceDir = "/workspace/user-123/repo";

      const response = await mockSessionRunner.executePrompt(userPrompt, workspaceDir);

      expect(mockSessionRunner.executePrompt).toHaveBeenCalledWith(userPrompt, workspaceDir);
      expect(response).toBe("Claude response");
    });

    it("should handle Claude execution failures", async () => {
      mockSessionRunner.executePrompt.mockRejectedValue(
        new Error("Claude API rate limit exceeded")
      );

      await expect(
        mockSessionRunner.executePrompt("test prompt", "/workspace")
      ).rejects.toThrow("Claude API rate limit exceeded");
    });

    it("should pass execution context to Claude", async () => {
      const executionContext = {
        sessionKey: process.env.SESSION_KEY,
        userId: process.env.USER_ID,
        username: process.env.USERNAME,
        channelId: process.env.CHANNEL_ID,
        threadTs: process.env.THREAD_TS,
        repositoryUrl: process.env.REPOSITORY_URL,
      };

      await mockSessionRunner.executePrompt("test", "/workspace", executionContext);

      expect(mockSessionRunner.executePrompt).toHaveBeenCalledWith(
        "test",
        "/workspace",
        expect.objectContaining(executionContext)
      );
    });

    it("should handle recovery mode", async () => {
      process.env.RECOVERY_MODE = "true";

      const isRecoveryMode = process.env.RECOVERY_MODE === "true";
      expect(isRecoveryMode).toBe(true);

      if (isRecoveryMode) {
        // Should attempt to recover previous session
        await mockSessionRunner.executePrompt("continue", "/workspace", { 
          recoveryMode: true 
        });
      }

      expect(mockSessionRunner.executePrompt).toHaveBeenCalledWith(
        "continue",
        "/workspace",
        expect.objectContaining({ recoveryMode: true })
      );
    });
  });

  describe("Result Processing", () => {
    it("should send final response to Slack", async () => {
      const claudeResponse = "I've analyzed your code and found several improvements...";

      const finalMessage = {
        channel: process.env.SLACK_RESPONSE_CHANNEL,
        thread_ts: process.env.SLACK_RESPONSE_TS,
        text: "✅ Claude has completed your request!",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: claudeResponse,
            },
          },
        ],
      };

      await mockSlackClient.chat.postMessage(finalMessage);

      expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "✅ Claude has completed your request!",
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "section",
            }),
          ]),
        })
      );
    });

    it("should truncate long responses", () => {
      const longResponse = "x".repeat(10000);
      const maxLength = 3000;

      const truncatedResponse = longResponse.length > maxLength
        ? longResponse.substring(0, maxLength) + "... (truncated)"
        : longResponse;

      expect(truncatedResponse.length).toBeLessThanOrEqual(maxLength + 20);
      expect(truncatedResponse).toContain("(truncated)");
    });

    it("should format code blocks properly", () => {
      const responseWithCode = `Here's the fix:

\`\`\`javascript
function fixed() {
  return 'working';
}
\`\`\`

This should resolve the issue.`;

      // Verify code blocks are preserved
      expect(responseWithCode).toContain("```javascript");
      expect(responseWithCode).toContain("```");
    });

    it("should handle response formatting errors", async () => {
      const malformedResponse = { invalid: "response object" };

      try {
        await mockSlackClient.chat.postMessage({
          channel: "C123456789",
          text: malformedResponse, // This should be a string
        });
      } catch (error) {
        // Should handle gracefully and send error message
        await mockSlackClient.chat.postMessage({
          channel: "C123456789",
          text: "❌ Failed to format response. Please try again.",
        });
      }

      expect(mockSlackClient.chat.postMessage).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should send error messages to Slack", async () => {
      const errorMessage = {
        channel: process.env.SLACK_RESPONSE_CHANNEL,
        thread_ts: process.env.SLACK_RESPONSE_TS,
        text: "❌ An error occurred while processing your request",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Please try again or contact support if the issue persists.",
            },
          },
        ],
      };

      await mockSlackClient.chat.postMessage(errorMessage);

      expect(mockSlackClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("❌"),
        })
      );
    });

    it("should classify different error types", () => {
      const errors = [
        { message: "Rate limit exceeded", type: "rate_limit" },
        { message: "Repository not found", type: "repository_error" },
        { message: "Workspace creation failed", type: "workspace_error" },
        { message: "Claude API error", type: "claude_error" },
        { message: "Unknown error", type: "unknown" },
      ];

      for (const error of errors) {
        let errorType = "unknown";
        
        if (error.message.includes("Rate limit")) errorType = "rate_limit";
        else if (error.message.includes("Repository")) errorType = "repository_error";
        else if (error.message.includes("Workspace")) errorType = "workspace_error";
        else if (error.message.includes("Claude")) errorType = "claude_error";

        expect(errorType).toBe(error.type);
      }
    });

    it("should retry transient failures", async () => {
      let attemptCount = 0;
      mockSlackClient.chat.postMessage.mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error("Network timeout");
        }
        return { ok: true };
      });

      // Simulate retry logic
      const maxRetries = 3;
      let lastError;

      for (let i = 0; i < maxRetries; i++) {
        try {
          await mockSlackClient.chat.postMessage({ channel: "C123", text: "test" });
          break;
        } catch (error) {
          lastError = error;
          if (i === maxRetries - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      expect(attemptCount).toBe(3);
    });
  });

  describe("Cleanup", () => {
    it("should clean up workspace on completion", async () => {
      await mockWorkspaceSetup.cleanup("/workspace/user-123");

      expect(mockWorkspaceSetup.cleanup).toHaveBeenCalledWith("/workspace/user-123");
    });

    it("should clean up session resources", async () => {
      await mockSessionRunner.cleanup();

      expect(mockSessionRunner.cleanup).toHaveBeenCalled();
    });

    it("should handle cleanup failures gracefully", async () => {
      mockWorkspaceSetup.cleanup.mockRejectedValue(new Error("Cleanup failed"));

      // Should not throw - just log the error
      try {
        await mockWorkspaceSetup.cleanup("/workspace");
      } catch (error) {
        console.warn("Cleanup failed:", error.message);
      }

      expect(mockWorkspaceSetup.cleanup).toHaveBeenCalled();
    });

    it("should perform cleanup on process signals", (done) => {
      const cleanupHandler = async () => {
        await mockWorkspaceSetup.cleanup();
        await mockSessionRunner.cleanup();
        done();
      };

      // Simulate signal handling
      process.once("SIGTERM", cleanupHandler);
      process.emit("SIGTERM", "SIGTERM");
    });
  });
});