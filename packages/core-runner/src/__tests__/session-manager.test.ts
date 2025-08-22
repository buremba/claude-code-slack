#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
jest.mock = mock.module;
import { SessionManager } from "../session-manager";
import { GcsStorage } from "../storage/gcs";
import type { SessionContext, ConversationMessage, ProgressUpdate, SessionError } from "../types";

// Mock GcsStorage
jest.mock("../storage/gcs", () => ({
  GcsStorage: jest.fn(),
}));
const MockedGcsStorage = GcsStorage as jest.MockedClass<typeof GcsStorage>;

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let mockGcsStorage: jest.Mocked<GcsStorage>;

  const mockConfig = {
    bucketName: "test-bucket",
    projectId: "test-project",
    keyFile: "/path/to/key.json",
    timeoutMinutes: 5,
  };

  const mockContext: SessionContext = {
    platform: "slack",
    userId: "U123456",
    username: "testuser",
    channelId: "C123456",
    messageTs: "1234567890.123456",
    threadTs: "1234567890.123456",
    customInstructions: "Test instructions",
  };

  beforeEach(() => {
    MockedGcsStorage.mockClear();
    mockGcsStorage = new MockedGcsStorage(mockConfig) as jest.Mocked<GcsStorage>;
    sessionManager = new SessionManager(mockConfig);
    
    // Mock GCS methods
    mockGcsStorage.loadSessionState = jest.fn();
    mockGcsStorage.saveSessionState = jest.fn();
    mockGcsStorage.sessionExists = jest.fn();
    
    // Replace the internal GCS storage with our mock
    (sessionManager as any).gcsStorage = mockGcsStorage;
  });

  afterEach(() => {
    // Clean up any active sessions and timeouts
    (sessionManager as any).cleanupAll();
  });

  describe("Session Key Validation", () => {
    it("should accept valid session keys", async () => {
      const validKeys = [
        "C123456-1234567890.123456",
        "user-session-123",
        "valid_key.with-dots",
        "UPPERCASE123",
        "simple123",
      ];

      for (const key of validKeys) {
        await expect(
          sessionManager.createSession(key, mockContext)
        ).resolves.toBeTruthy();
      }
    });

    it("should reject session keys with path traversal patterns", async () => {
      const maliciousKeys = [
        "../../../etc/passwd",
        "..\\windows\\system32",
        "session/../../../secret",
        "normal..malicious",
      ];

      for (const key of maliciousKeys) {
        await expect(
          sessionManager.createSession(key, mockContext)
        ).rejects.toThrow("Session key contains invalid characters or patterns");
      }
    });

    it("should reject session keys with invalid characters", async () => {
      const invalidKeys = [
        "session/with/slashes",
        "session\\with\\backslashes",
        "session with spaces",
        "session<with>brackets",
        "session:with:colons",
        'session"with"quotes',
        "session|with|pipes",
        "session?with?questions",
        "session*with*asterisks",
        "session\x00with\x00nulls",
      ];

      for (const key of invalidKeys) {
        await expect(
          sessionManager.createSession(key, mockContext)
        ).rejects.toThrow("Session key contains invalid characters or patterns");
      }
    });

    it("should reject empty or null session keys", async () => {
      await expect(
        sessionManager.createSession("", mockContext)
      ).rejects.toThrow("Session key must be a non-empty string");

      await expect(
        sessionManager.createSession(null as any, mockContext)
      ).rejects.toThrow("Session key must be a non-empty string");

      await expect(
        sessionManager.createSession(undefined as any, mockContext)
      ).rejects.toThrow("Session key must be a non-empty string");
    });

    it("should reject session keys that are too long", async () => {
      const longKey = "a".repeat(101);
      await expect(
        sessionManager.createSession(longKey, mockContext)
      ).rejects.toThrow("Session key too long");
    });
  });

  describe("Session Creation", () => {
    it("should create a new session successfully", async () => {
      const sessionKey = "test-session-123";
      const session = await sessionManager.createSession(sessionKey, mockContext);

      expect(session.sessionKey).toBe(sessionKey);
      expect(session.context).toEqual(mockContext);
      expect(session.conversation).toHaveLength(1); // System message
      expect(session.conversation[0].role).toBe("system");
      expect(session.conversation[0].content).toBe(mockContext.customInstructions);
      expect(session.status).toBe("active");
      expect(session.createdAt).toBeDefined();
      expect(session.lastActivity).toBeDefined();
    });

    it("should create session without custom instructions", async () => {
      const contextWithoutInstructions = { ...mockContext, customInstructions: undefined };
      const session = await sessionManager.createSession("test-session", contextWithoutInstructions);

      expect(session.conversation).toHaveLength(0);
    });
  });

  describe("Session Recovery", () => {
    it("should recover session from memory if already active", async () => {
      const sessionKey = "test-session-recovery";
      const originalSession = await sessionManager.createSession(sessionKey, mockContext);

      const recoveredSession = await sessionManager.recoverSession(sessionKey);

      expect(recoveredSession).toBe(originalSession);
      expect(mockGcsStorage.loadSessionState).not.toHaveBeenCalled();
    });

    it("should recover session from GCS if not in memory", async () => {
      const sessionKey = "gcs-session";
      const gcsSessionData = {
        sessionKey,
        context: mockContext,
        conversation: [
          { role: "user" as const, content: "Hello", timestamp: Date.now() },
          { role: "assistant" as const, content: "Hi there", timestamp: Date.now() },
        ],
        createdAt: Date.now() - 1000,
        lastActivity: Date.now() - 500,
        status: "completed" as const,
      };

      mockGcsStorage.loadSessionState.mockResolvedValue(gcsSessionData);

      const recoveredSession = await sessionManager.recoverSession(sessionKey);

      expect(mockGcsStorage.loadSessionState).toHaveBeenCalledWith(sessionKey);
      expect(recoveredSession.sessionKey).toBe(sessionKey);
      expect(recoveredSession.conversation).toHaveLength(2);
      expect(recoveredSession.status).toBe("active"); // Should be set to active
    });

    it("should throw error if session not found in GCS", async () => {
      const sessionKey = "non-existent-session";
      mockGcsStorage.loadSessionState.mockResolvedValue(null);

      await expect(
        sessionManager.recoverSession(sessionKey)
      ).rejects.toThrow("Session non-existent-session not found in GCS");
    });

    it("should handle GCS errors during recovery", async () => {
      const sessionKey = "error-session";
      mockGcsStorage.loadSessionState.mockRejectedValue(new Error("GCS connection failed"));

      await expect(
        sessionManager.recoverSession(sessionKey)
      ).rejects.toThrow("Failed to recover session from GCS");
    });
  });

  describe("Message Management", () => {
    let sessionKey: string;

    beforeEach(async () => {
      sessionKey = "message-test-session";
      await sessionManager.createSession(sessionKey, mockContext);
    });

    it("should add messages to conversation", async () => {
      const message: ConversationMessage = {
        role: "user",
        content: "Hello Claude",
        timestamp: Date.now(),
      };

      await sessionManager.addMessage(sessionKey, message);

      const session = sessionManager.getSession(sessionKey);
      expect(session?.conversation).toContain(message);
    });

    it("should update last activity when adding messages", async () => {
      const session = sessionManager.getSession(sessionKey);
      const originalActivity = session?.lastActivity;

      // Wait a bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      const message: ConversationMessage = {
        role: "user",
        content: "Test message",
        timestamp: Date.now(),
      };

      await sessionManager.addMessage(sessionKey, message);

      const updatedSession = sessionManager.getSession(sessionKey);
      expect(updatedSession?.lastActivity).toBeGreaterThan(originalActivity!);
    });

    it("should throw error when adding message to non-existent session", async () => {
      const message: ConversationMessage = {
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      };

      await expect(
        sessionManager.addMessage("non-existent", message)
      ).rejects.toThrow("Session not found");
    });
  });

  describe("Progress Updates", () => {
    let sessionKey: string;

    beforeEach(async () => {
      sessionKey = "progress-test-session";
      await sessionManager.createSession(sessionKey, mockContext);
    });

    it("should update session progress", async () => {
      const update: ProgressUpdate = {
        type: "progress",
        message: "Processing request",
        timestamp: Date.now(),
      };

      await sessionManager.updateProgress(sessionKey, update);

      const session = sessionManager.getSession(sessionKey);
      expect(session?.progress?.lastUpdate).toEqual(update);
    });

    it("should add completion updates as messages", async () => {
      const update: ProgressUpdate = {
        type: "completion",
        message: "Task completed",
        timestamp: Date.now(),
      };

      await sessionManager.updateProgress(sessionKey, update);

      const session = sessionManager.getSession(sessionKey);
      const lastMessage = session?.conversation[session.conversation.length - 1];
      expect(lastMessage?.role).toBe("assistant");
      expect(lastMessage?.content).toBe("Progress update: completion");
      expect(lastMessage?.metadata?.progressUpdate).toEqual(update);
    });

    it("should handle progress update for non-existent session gracefully", async () => {
      const update: ProgressUpdate = {
        type: "progress",
        message: "Test update",
        timestamp: Date.now(),
      };

      // Should not throw error
      await expect(
        sessionManager.updateProgress("non-existent", update)
      ).resolves.toBeUndefined();
    });
  });

  describe("Session Persistence", () => {
    let sessionKey: string;

    beforeEach(async () => {
      sessionKey = "persistence-test-session";
      await sessionManager.createSession(sessionKey, mockContext);
    });

    it("should persist session to GCS", async () => {
      mockGcsStorage.saveSessionState.mockResolvedValue("/path/to/session");

      const gcsPath = await sessionManager.persistSession(sessionKey);

      expect(mockGcsStorage.saveSessionState).toHaveBeenCalled();
      expect(gcsPath).toBe("/path/to/session");
    });

    it("should throw error when persisting non-existent session", async () => {
      await expect(
        sessionManager.persistSession("non-existent")
      ).rejects.toThrow("Session not found for persistence");
    });
  });

  describe("Session Cleanup", () => {
    let sessionKey: string;

    beforeEach(async () => {
      sessionKey = "cleanup-test-session";
      await sessionManager.createSession(sessionKey, mockContext);
    });

    it("should clean up session successfully", async () => {
      mockGcsStorage.saveSessionState.mockResolvedValue("/path/to/session");

      await sessionManager.cleanup(sessionKey);

      const session = sessionManager.getSession(sessionKey);
      expect(session).toBeNull();
      expect(mockGcsStorage.saveSessionState).toHaveBeenCalled();
    });

    it("should handle cleanup of non-existent session", async () => {
      // Should not throw error
      await expect(
        sessionManager.cleanup("non-existent")
      ).resolves.toBeUndefined();
    });
  });

  describe("Session Key Generation", () => {
    it("should generate thread-based session key", () => {
      const contextWithThread = {
        ...mockContext,
        threadTs: "1234567890.123456",
      };

      const key = SessionManager.generateSessionKey(contextWithThread);
      expect(key).toBe("C123456-1234567890.123456");
    });

    it("should generate message-based session key for new conversation", () => {
      const contextWithoutThread = {
        ...mockContext,
        threadTs: undefined,
      };

      const key = SessionManager.generateSessionKey(contextWithoutThread);
      expect(key).toBe("C123456-1234567890.123456");
    });
  });

  describe("Session Monitoring", () => {
    it("should return correct session status", () => {
      const status = sessionManager.getSessionStatus();
      expect(status.activeSessions).toBe(0);
      expect(status.sessionsWithTimeouts).toBe(0);
      expect(status.sessionKeys).toEqual([]);
    });

    it("should track active sessions in status", async () => {
      await sessionManager.createSession("session1", mockContext);
      await sessionManager.createSession("session2", mockContext);

      const status = sessionManager.getSessionStatus();
      expect(status.activeSessions).toBe(2);
      expect(status.sessionKeys).toContain("session1");
      expect(status.sessionKeys).toContain("session2");
    });
  });
});