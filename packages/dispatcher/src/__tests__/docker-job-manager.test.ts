#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import Docker from "dockerode";
import { DockerJobManager } from "../docker/job-manager";
import type { DockerConfig, WorkerJobRequest } from "../types";

// Mock Dockerode
jest.mock("dockerode");
const MockedDocker = Docker as jest.MockedClass<typeof Docker>;

describe("DockerJobManager", () => {
  let jobManager: DockerJobManager;
  let mockDocker: jest.Mocked<Docker>;
  let mockContainer: jest.Mocked<Docker.Container>;

  const mockConfig: DockerConfig = {
    socketPath: "/var/run/docker.sock",
    workspaceVolumeHost: "/tmp/test-workspaces",
    network: "test-network",
    removeContainers: true,
    workerImage: "test/worker:latest",
    cpu: "500m",
    memory: "1Gi",
    timeoutSeconds: 3600,
  };

  const mockJobRequest: WorkerJobRequest = {
    sessionKey: "test-session-123",
    userId: "U123456",
    username: "testuser",
    channelId: "C123456",
    threadTs: "1234567890.123456",
    repositoryUrl: "https://github.com/test/repo",
    userPrompt: "Help me with this code",
    slackResponseChannel: "C123456",
    slackResponseTs: "1234567890.123456",
    claudeOptions: { model: "claude-3-sonnet" },
    recoveryMode: false,
  };

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock container
    mockContainer = {
      id: "container-123",
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      wait: jest.fn().mockResolvedValue({ StatusCode: 0 }),
      inspect: jest.fn().mockResolvedValue({
        State: {
          Running: false,
          Status: "exited",
          ExitCode: 0,
        },
      }),
    } as any;

    // Setup mock Docker API
    mockDocker = {
      createContainer: jest.fn().mockResolvedValue(mockContainer),
      getContainer: jest.fn().mockReturnValue(mockContainer),
      listContainers: jest.fn().mockResolvedValue([]),
    } as any;

    // Configure Docker mock
    MockedDocker.mockImplementation(() => mockDocker as any);

    // Create job manager instance
    jobManager = new DockerJobManager(mockConfig);
  });

  afterEach(async () => {
    // Clean up any running timers
    await jobManager.cleanup();
  });

  describe("Initialization", () => {
    it("should initialize with provided configuration", () => {
      expect(MockedDocker).toHaveBeenCalledWith({
        socketPath: mockConfig.socketPath,
      });
    });

    it("should use default values for optional config", () => {
      const minimalConfig: DockerConfig = {
        workerImage: "test/worker:latest",
        timeoutSeconds: 300,
      };

      const manager = new DockerJobManager(minimalConfig);
      
      // Access private config to verify defaults
      const config = (manager as any).config;
      expect(config.socketPath).toBe("/var/run/docker.sock");
      expect(config.removeContainers).toBe(true);
    });
  });

  describe("Rate Limiting", () => {
    it("should allow jobs within rate limits", async () => {
      // First job should succeed
      const containerId1 = await jobManager.createWorkerJob(mockJobRequest);
      expect(containerId1).toBe("container-123");
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);

      // Second job should also succeed
      const request2 = { ...mockJobRequest, sessionKey: "test-session-124" };
      const containerId2 = await jobManager.createWorkerJob(request2);
      expect(containerId2).toBe("container-123");
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(2);
    });

    it("should enforce rate limits per user", async () => {
      // Create 5 jobs (should be at the limit)
      for (let i = 0; i < 5; i++) {
        const request = { ...mockJobRequest, sessionKey: `test-session-${i}` };
        await jobManager.createWorkerJob(request);
      }

      expect(mockDocker.createContainer).toHaveBeenCalledTimes(5);

      // 6th job should be rate limited
      const request6 = { ...mockJobRequest, sessionKey: "test-session-6" };
      await expect(
        jobManager.createWorkerJob(request6)
      ).rejects.toThrow("Rate limit exceeded for user U123456");
    });

    it("should not affect different users", async () => {
      // Create 5 jobs for first user
      for (let i = 0; i < 5; i++) {
        const request = { ...mockJobRequest, sessionKey: `test-session-${i}` };
        await jobManager.createWorkerJob(request);
      }

      // Different user should still be able to create jobs
      const differentUserRequest = {
        ...mockJobRequest,
        userId: "U999999",
        sessionKey: "different-user-session",
      };

      const containerId = await jobManager.createWorkerJob(differentUserRequest);
      expect(containerId).toBeDefined();
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(6);
    });

    it("should reset rate limits after time window", async () => {
      // Fill up the rate limit
      for (let i = 0; i < 5; i++) {
        const request = { ...mockJobRequest, sessionKey: `test-session-${i}` };
        await jobManager.createWorkerJob(request);
      }

      // Mock time advancement (15+ minutes)
      const originalNow = Date.now;
      Date.now = jest.fn().mockReturnValue(originalNow() + 16 * 60 * 1000);

      // Should be able to create jobs again
      const request = { ...mockJobRequest, sessionKey: "new-window-session" };
      const containerId = await jobManager.createWorkerJob(request);
      expect(containerId).toBeDefined();

      // Restore Date.now
      Date.now = originalNow;
    });

    it("should clean up expired rate limit entries", (done) => {
      // Access private rate limit map for testing
      const rateLimitMap = (jobManager as any).rateLimitMap;

      // Add some entries
      rateLimitMap.set("user1", { count: 3, windowStart: Date.now() - 20 * 60 * 1000 });
      rateLimitMap.set("user2", { count: 2, windowStart: Date.now() - 10 * 60 * 1000 });
      rateLimitMap.set("user3", { count: 1, windowStart: Date.now() });

      expect(rateLimitMap.size).toBe(3);

      // Wait for cleanup to run
      setTimeout(() => {
        // Only recent entry should remain
        expect(rateLimitMap.size).toBeLessThanOrEqual(1);
        done();
      }, 100);
    });
  });

  describe("Container Creation", () => {
    it("should create container with correct configuration", async () => {
      const containerId = await jobManager.createWorkerJob(mockJobRequest);

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: mockConfig.workerImage,
          name: expect.stringMatching(/^claude-worker-.*$/),
          WorkingDir: "/workspace",
          Cmd: ["/app/scripts/entrypoint.sh"],
          Labels: expect.objectContaining({
            app: "claude-worker",
            component: "worker",
            "claude.ai/session-key": mockJobRequest.sessionKey,
            "claude.ai/user-id": mockJobRequest.userId,
            "claude.ai/username": mockJobRequest.username,
          }),
          HostConfig: expect.objectContaining({
            AutoRemove: true,
            NetworkMode: mockConfig.network,
          }),
        })
      );
    });

    it("should generate unique container names", async () => {
      const containerId1 = await jobManager.createWorkerJob(mockJobRequest);
      
      const request2 = { ...mockJobRequest, sessionKey: "different-session" };
      const containerId2 = await jobManager.createWorkerJob(request2);

      expect(containerId1).toBe("container-123");
      expect(containerId2).toBe("container-123");
      
      // Check that different names were generated
      const calls = mockDocker.createContainer.mock.calls;
      expect(calls[0][0].name).not.toBe(calls[1][0].name);
      expect(calls[0][0].name).toMatch(/^claude-worker-.*$/);
      expect(calls[1][0].name).toMatch(/^claude-worker-.*$/);
    });

    it("should return existing container ID for duplicate session", async () => {
      const containerId1 = await jobManager.createWorkerJob(mockJobRequest);
      const containerId2 = await jobManager.createWorkerJob(mockJobRequest);

      expect(containerId1).toBe(containerId2);
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);
    });

    it("should base64 encode user prompt", async () => {
      const request = { ...mockJobRequest, userPrompt: "Hello World!" };
      await jobManager.createWorkerJob(request);

      const createCall = mockDocker.createContainer.mock.calls[0];
      const containerConfig = createCall[0];
      
      const userPromptEnv = containerConfig.Env.find((env: string) => 
        env.startsWith("USER_PROMPT=")
      );
      expect(userPromptEnv).toBe(`USER_PROMPT=${Buffer.from("Hello World!").toString("base64")}`);
    });

    it("should include all required environment variables", async () => {
      await jobManager.createWorkerJob(mockJobRequest);

      const createCall = mockDocker.createContainer.mock.calls[0];
      const containerConfig = createCall[0];
      
      const envVars = containerConfig.Env;
      const requiredEnvs = [
        "SESSION_KEY",
        "USER_ID", 
        "USERNAME",
        "CHANNEL_ID",
        "REPOSITORY_URL",
        "USER_PROMPT",
        "SLACK_RESPONSE_CHANNEL",
        "SLACK_RESPONSE_TS",
        "CLAUDE_OPTIONS",
        "RECOVERY_MODE",
      ];

      for (const envName of requiredEnvs) {
        expect(envVars.some((env: string) => env.startsWith(`${envName}=`))).toBe(true);
      }
    });

    it("should set resource limits when specified", async () => {
      await jobManager.createWorkerJob(mockJobRequest);

      const createCall = mockDocker.createContainer.mock.calls[0];
      const containerConfig = createCall[0];
      
      expect(containerConfig.HostConfig.Memory).toBeGreaterThan(0);
      expect(containerConfig.HostConfig.CpuShares).toBeGreaterThan(0);
    });

    it("should mount workspace volume when specified", async () => {
      await jobManager.createWorkerJob(mockJobRequest);

      const createCall = mockDocker.createContainer.mock.calls[0];
      const containerConfig = createCall[0];
      
      expect(containerConfig.HostConfig.Binds).toContain(
        `${mockConfig.workspaceVolumeHost}:/workspace:rw`
      );
    });

    it("should handle container creation errors", async () => {
      mockDocker.createContainer.mockRejectedValue(new Error("Docker API error"));

      await expect(
        jobManager.createWorkerJob(mockJobRequest)
      ).rejects.toThrow("Failed to create container for session test-session-123");
    });
  });

  describe("Container Monitoring", () => {
    it("should monitor container completion", async () => {
      const containerId = await jobManager.createWorkerJob(mockJobRequest);

      // Wait for monitoring to start
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockContainer.wait).toHaveBeenCalled();
    });

    it("should clean up completed containers from tracking", async () => {
      mockContainer.wait.mockResolvedValue({ StatusCode: 0 });

      const containerId = await jobManager.createWorkerJob(mockJobRequest);
      
      // Wait for monitoring to process completion
      await new Promise(resolve => setTimeout(resolve, 100));

      const activeJobs = await jobManager.listActiveJobs();
      expect(activeJobs.find(job => job.name === containerId)).toBeUndefined();
    });

    it("should handle failed containers", async () => {
      mockContainer.wait.mockResolvedValue({ StatusCode: 1 });

      const containerId = await jobManager.createWorkerJob(mockJobRequest);
      
      // Wait for monitoring to process failure
      await new Promise(resolve => setTimeout(resolve, 100));

      const activeJobs = await jobManager.listActiveJobs();
      expect(activeJobs.find(job => job.name === containerId)).toBeUndefined();
    });
  });

  describe("Container Management", () => {
    it("should delete containers", async () => {
      await jobManager.deleteJob("test-container");

      expect(mockDocker.getContainer).toHaveBeenCalledWith("test-container");
      expect(mockContainer.stop).toHaveBeenCalled();
    });

    it("should handle container deletion errors gracefully", async () => {
      mockContainer.stop.mockRejectedValue(new Error("Container already stopped"));
      mockContainer.remove.mockRejectedValue(new Error("Container already removed"));

      // Should not throw - errors are logged
      await expect(jobManager.deleteJob("test-container")).resolves.toBeUndefined();
    });

    it("should get container status", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: {
          Running: false,
          Status: "exited",
          ExitCode: 0,
        },
      } as any);

      const status = await jobManager.getJobStatus("test-container");
      expect(status).toBe("completed");
    });

    it("should handle different container statuses", async () => {
      const statusTests = [
        { 
          mockState: { Running: true }, 
          expected: "running" 
        },
        { 
          mockState: { Running: false, Status: "exited", ExitCode: 0 }, 
          expected: "completed" 
        },
        { 
          mockState: { Running: false, Status: "exited", ExitCode: 1 }, 
          expected: "failed" 
        },
        { 
          mockState: { Status: "created" }, 
          expected: "created" 
        },
      ];

      for (const test of statusTests) {
        mockContainer.inspect.mockResolvedValueOnce({
          State: test.mockState
        } as any);

        const status = await jobManager.getJobStatus("test-container");
        expect(status).toBe(test.expected);
      }
    });

    it("should return unknown status on errors", async () => {
      mockContainer.inspect.mockRejectedValue(new Error("Container not found"));

      const status = await jobManager.getJobStatus("test-container");
      expect(status).toBe("unknown");
    });
  });

  describe("Memory and CPU Parsing", () => {
    it("should parse memory values correctly", () => {
      const manager = jobManager as any;
      
      expect(manager.parseMemory("1Gi")).toBe(1024 * 1024 * 1024);
      expect(manager.parseMemory("2G")).toBe(2 * 1024 * 1024 * 1024);
      expect(manager.parseMemory("512Mi")).toBe(512 * 1024 * 1024);
      expect(manager.parseMemory("1024K")).toBe(1024 * 1024);
      expect(manager.parseMemory("invalid")).toBe(0);
    });

    it("should parse CPU values correctly", () => {
      const manager = jobManager as any;
      
      expect(manager.parseCpu("1000m")).toBe(1024); // 1 CPU = 1024 shares
      expect(manager.parseCpu("500m")).toBe(512);   // 0.5 CPU = 512 shares
      expect(manager.parseCpu("2")).toBe(2048);     // 2 CPU = 2048 shares
      expect(manager.parseCpu("1.5")).toBe(1536);  // 1.5 CPU = 1536 shares
    });
  });

  describe("Active Container Tracking", () => {
    it("should list active containers", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: { Running: true }
      } as any);

      const containerId1 = await jobManager.createWorkerJob(mockJobRequest);
      const request2 = { ...mockJobRequest, sessionKey: "session-2" };
      const containerId2 = await jobManager.createWorkerJob(request2);

      const activeJobs = await jobManager.listActiveJobs();

      expect(activeJobs).toHaveLength(2);
      expect(activeJobs.find(job => job.name === containerId1)).toBeDefined();
      expect(activeJobs.find(job => job.name === containerId2)).toBeDefined();
    });

    it("should return correct active container count", async () => {
      expect(jobManager.getActiveJobCount()).toBe(0);

      await jobManager.createWorkerJob(mockJobRequest);
      expect(jobManager.getActiveJobCount()).toBe(1);

      const request2 = { ...mockJobRequest, sessionKey: "session-2" };
      await jobManager.createWorkerJob(request2);
      expect(jobManager.getActiveJobCount()).toBe(2);
    });

    it("should cleanup all containers", async () => {
      await jobManager.createWorkerJob(mockJobRequest);
      const request2 = { ...mockJobRequest, sessionKey: "session-2" };
      await jobManager.createWorkerJob(request2);

      expect(jobManager.getActiveJobCount()).toBe(2);

      await jobManager.cleanup();

      expect(jobManager.getActiveJobCount()).toBe(0);
      expect(mockContainer.stop).toHaveBeenCalledTimes(2);
    });
  });

  describe("AgentManager Interface Compliance", () => {
    it("should implement all AgentManager interface methods", () => {
      // Test that all required methods exist and are callable
      expect(typeof jobManager.createWorkerJob).toBe("function");
      expect(typeof jobManager.deleteJob).toBe("function");
      expect(typeof jobManager.getJobStatus).toBe("function");
      expect(typeof jobManager.listActiveJobs).toBe("function");
      expect(typeof jobManager.getActiveJobCount).toBe("function");
      expect(typeof jobManager.cleanup).toBe("function");
    });

    it("should return consistent data types from interface methods", async () => {
      // createWorkerJob should return string
      const containerId = await jobManager.createWorkerJob(mockJobRequest);
      expect(typeof containerId).toBe("string");

      // getJobStatus should return string
      const status = await jobManager.getJobStatus("test");
      expect(typeof status).toBe("string");

      // listActiveJobs should return array
      const jobs = await jobManager.listActiveJobs();
      expect(Array.isArray(jobs)).toBe(true);

      // getActiveJobCount should return number
      const count = jobManager.getActiveJobCount();
      expect(typeof count).toBe("number");
    });
  });
});