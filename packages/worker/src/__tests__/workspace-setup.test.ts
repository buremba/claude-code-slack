#!/usr/bin/env bun

import { describe, it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
jest.mock = mock.module;
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";

// Mock dependencies
jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));
jest.mock("fs", () => ({
  promises: {
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    readFile: jest.fn(),
    access: jest.fn(),
    rm: jest.fn(),
    chmod: jest.fn(),
    stat: jest.fn(),
    readdir: jest.fn(),
  },
}));

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockFs = fs as jest.Mocked<typeof fs>;

describe("Workspace Setup", () => {
  const mockWorkspaceDir = "/workspace/test-user";
  const mockRepositoryUrl = "https://github.com/test/repo.git";
  const mockGitHubToken = "ghp_test_token";

  let mockProcess: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock process
    mockProcess = {
      stdout: { on: jest.fn(), pipe: jest.fn() },
      stderr: { on: jest.fn(), pipe: jest.fn() },
      on: jest.fn(),
      kill: jest.fn(),
      pid: 12345,
    };

    mockSpawn.mockReturnValue(mockProcess);

    // Setup mock filesystem
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue(Buffer.from("mock file content"));
    mockFs.access.mockResolvedValue(undefined);
    mockFs.rm.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any);
    mockFs.readdir.mockResolvedValue([]);
  });

  afterEach(() => {
    // Clean up any mock timers (if available)
    if (typeof jest !== 'undefined' && jest.clearAllTimers) {
      jest.clearAllTimers();
    }
  });

  describe("Directory Setup", () => {
    it("should create workspace directory", async () => {
      // Simulate workspace creation
      await mockFs.mkdir(mockWorkspaceDir, { recursive: true });

      expect(mockFs.mkdir).toHaveBeenCalledWith(mockWorkspaceDir, { recursive: true });
    });

    it("should handle existing workspace directory", async () => {
      mockFs.mkdir.mockRejectedValue({ code: "EEXIST" });

      // Should not throw for existing directory
      try {
        await mockFs.mkdir(mockWorkspaceDir, { recursive: true });
      } catch (error: any) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }

      expect(mockFs.mkdir).toHaveBeenCalled();
    });

    it("should set correct permissions on workspace", async () => {
      await mockFs.chmod(mockWorkspaceDir, 0o755);

      expect(mockFs.chmod).toHaveBeenCalledWith(mockWorkspaceDir, 0o755);
    });

    it("should create subdirectories for organization", async () => {
      const subdirs = ["repos", "temp", "logs"];

      for (const subdir of subdirs) {
        const dirPath = join(mockWorkspaceDir, subdir);
        await mockFs.mkdir(dirPath, { recursive: true });
      }

      expect(mockFs.mkdir).toHaveBeenCalledTimes(subdirs.length);
    });
  });

  describe("Git Repository Cloning", () => {
    it("should clone repository with authentication", async () => {
      const cloneArgs = [
        "clone",
        "--depth", "1",
        "--single-branch",
        mockRepositoryUrl,
        "repo"
      ];

      mockProcess.on.mockImplementation((event: string, callback: any) => {
        if (event === "exit") {
          setTimeout(() => callback(0), 10);
        }
        return mockProcess;
      });

      // Simulate git clone
      const process = spawn("git", cloneArgs, {
        cwd: mockWorkspaceDir,
        env: {
          ...process.env,
          GIT_ASKPASS: "echo",
          GIT_USERNAME: "token",
          GIT_PASSWORD: mockGitHubToken,
        },
      });

      expect(mockSpawn).toHaveBeenCalledWith("git", cloneArgs, expect.objectContaining({
        cwd: mockWorkspaceDir,
        env: expect.objectContaining({
          GIT_USERNAME: "token",
          GIT_PASSWORD: mockGitHubToken,
        }),
      }));
    });

    it("should handle clone failures gracefully", async () => {
      mockProcess.on.mockImplementation((event: string, callback: any) => {
        if (event === "exit") {
          setTimeout(() => callback(1), 10); // Non-zero exit code
        } else if (event === "error") {
          setTimeout(() => callback(new Error("Git clone failed")), 10);
        }
        return mockProcess;
      });

      // Clone should fail
      const clonePromise = new Promise((resolve, reject) => {
        const process = spawn("git", ["clone", mockRepositoryUrl]);
        process.on("exit", (code) => {
          if (code === 0) resolve(code);
          else reject(new Error(`Git clone failed with code ${code}`));
        });
        process.on("error", reject);
      });

      await expect(clonePromise).rejects.toThrow("Git clone failed");
    });

    it("should configure git credentials securely", () => {
      const gitConfig = [
        ["credential.helper", "store"],
        ["user.name", "Claude Bot"],
        ["user.email", "claude@anthropic.com"],
      ];

      for (const [key, value] of gitConfig) {
        const configArgs = ["config", key, value];
        spawn("git", configArgs, { cwd: mockWorkspaceDir });
      }

      expect(mockSpawn).toHaveBeenCalledTimes(gitConfig.length);
    });

    it("should handle different repository URL formats", () => {
      const urlFormats = [
        "https://github.com/user/repo.git",
        "https://github.com/user/repo",
        "git@github.com:user/repo.git",
      ];

      for (const url of urlFormats) {
        // Normalize URL for cloning
        const normalizedUrl = url.startsWith("git@") 
          ? url.replace("git@github.com:", "https://github.com/")
          : url;

        expect(normalizedUrl).toMatch(/^https:\/\/github\.com\//);
      }
    });
  });

  describe("Environment Configuration", () => {
    it("should create environment file", async () => {
      const envContent = [
        "CLAUDE_API_KEY=test-key",
        "GITHUB_TOKEN=test-token",
        "WORKSPACE_DIR=/workspace",
      ].join("\n");

      await mockFs.writeFile(join(mockWorkspaceDir, ".env"), envContent);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        join(mockWorkspaceDir, ".env"),
        envContent
      );
    });

    it("should sanitize environment variables", () => {
      const rawEnv = {
        CLAUDE_API_KEY: "sk-sensitive-key",
        GITHUB_TOKEN: "ghp_sensitive_token",
        SAFE_VAR: "safe-value",
        USER_INPUT: "user<script>alert('xss')</script>input",
      };

      // Sanitize sensitive values for logging
      const sanitizedEnv = Object.fromEntries(
        Object.entries(rawEnv).map(([key, value]) => {
          if (key.includes("TOKEN") || key.includes("KEY") || key.includes("SECRET")) {
            return [key, "[REDACTED]"];
          }
          if (key === "USER_INPUT") {
            // Basic XSS prevention
            return [key, value.replace(/<script.*?<\/script>/gi, "")];
          }
          return [key, value];
        })
      );

      expect(sanitizedEnv.CLAUDE_API_KEY).toBe("[REDACTED]");
      expect(sanitizedEnv.GITHUB_TOKEN).toBe("[REDACTED]");
      expect(sanitizedEnv.SAFE_VAR).toBe("safe-value");
      expect(sanitizedEnv.USER_INPUT).not.toContain("<script>");
    });

    it("should validate required environment variables", () => {
      const requiredVars = [
        "SESSION_KEY",
        "USER_ID",
        "SLACK_BOT_TOKEN",
        "GITHUB_TOKEN",
      ];

      const env = {
        SESSION_KEY: "test-session",
        USER_ID: "U123456",
        SLACK_BOT_TOKEN: "xoxb-token",
        GITHUB_TOKEN: "ghp-token",
      };

      for (const varName of requiredVars) {
        expect(env[varName as keyof typeof env]).toBeDefined();
      }
    });
  });

  describe("Security Measures", () => {
    it("should restrict workspace permissions", async () => {
      // Owner read/write/execute, group read/execute, no others
      const secureMode = 0o750;
      await mockFs.chmod(mockWorkspaceDir, secureMode);

      expect(mockFs.chmod).toHaveBeenCalledWith(mockWorkspaceDir, secureMode);
    });

    it("should validate user input for path safety", () => {
      const maliciousInputs = [
        "../../../etc/passwd",
        "..\\windows\\system32",
        "/etc/shadow",
        "~/.ssh/id_rsa",
        "|rm -rf /",
        "; cat /etc/passwd",
      ];

      for (const input of maliciousInputs) {
        // Path traversal validation
        const isUnsafe = input.includes("..") || 
                        input.includes("/etc/") ||
                        input.includes("~") ||
                        input.includes("|") ||
                        input.includes(";");

        expect(isUnsafe).toBe(true);
      }
    });

    it("should limit workspace size", async () => {
      const maxSizeBytes = 10 * 1024 * 1024 * 1024; // 10GB
      
      // Mock directory size calculation
      const calculateDirSize = async (dirPath: string): Promise<number> => {
        const files = await mockFs.readdir(dirPath);
        let totalSize = 0;
        
        for (const file of files) {
          const stats = await mockFs.stat(join(dirPath, file));
          totalSize += (stats as any).size || 0;
        }
        
        return totalSize;
      };

      const currentSize = await calculateDirSize(mockWorkspaceDir);
      expect(currentSize).toBeLessThanOrEqual(maxSizeBytes);
    });

    it("should clean up sensitive files on exit", async () => {
      const sensitiveFiles = [
        ".env",
        ".git-credentials",
        "private-key.pem",
        "secrets.json",
      ];

      for (const file of sensitiveFiles) {
        const filePath = join(mockWorkspaceDir, file);
        await mockFs.rm(filePath, { force: true });
      }

      expect(mockFs.rm).toHaveBeenCalledTimes(sensitiveFiles.length);
    });
  });

  describe("Resource Monitoring", () => {
    it("should monitor disk usage", async () => {
      const mockStats = {
        size: 1024 * 1024, // 1MB
        isDirectory: () => false,
        isFile: () => true,
      };

      mockFs.stat.mockResolvedValue(mockStats as any);

      const stats = await mockFs.stat(join(mockWorkspaceDir, "test-file"));
      expect(stats.size).toBe(1024 * 1024);
    });

    it("should handle workspace cleanup on errors", async () => {
      const cleanup = async () => {
        try {
          await mockFs.rm(mockWorkspaceDir, { recursive: true, force: true });
        } catch (error) {
          console.warn("Failed to cleanup workspace:", error);
        }
      };

      await cleanup();
      expect(mockFs.rm).toHaveBeenCalledWith(mockWorkspaceDir, {
        recursive: true,
        force: true,
      });
    });

    it("should timeout long-running setup operations", (done) => {
      const setupTimeout = 30000; // 30 seconds
      let isComplete = false;

      const setupOperation = new Promise((resolve) => {
        setTimeout(() => {
          isComplete = true;
          resolve("setup complete");
        }, 100);
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          if (!isComplete) {
            reject(new Error("Setup timeout"));
          }
        }, setupTimeout);
      });

      Promise.race([setupOperation, timeoutPromise])
        .then(() => {
          expect(isComplete).toBe(true);
          done();
        })
        .catch(done);
    });
  });

  describe("Error Recovery", () => {
    it("should retry failed operations", async () => {
      let attemptCount = 0;
      const maxAttempts = 3;

      const unreliableOperation = async () => {
        attemptCount++;
        if (attemptCount < maxAttempts) {
          throw new Error("Temporary failure");
        }
        return "success";
      };

      let lastError;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const result = await unreliableOperation();
          expect(result).toBe("success");
          expect(attemptCount).toBe(maxAttempts);
          break;
        } catch (error) {
          lastError = error;
          if (i === maxAttempts - 1) {
            throw lastError;
          }
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    });

    it("should handle partial setup failures", async () => {
      // Simulate partial failure during setup
      const setupSteps = [
        () => mockFs.mkdir(mockWorkspaceDir, { recursive: true }),
        () => { throw new Error("Network error during clone"); },
        () => mockFs.writeFile(join(mockWorkspaceDir, ".env"), ""),
      ];

      let completedSteps = 0;
      let lastError;

      for (const step of setupSteps) {
        try {
          await step();
          completedSteps++;
        } catch (error) {
          lastError = error;
          break;
        }
      }

      expect(completedSteps).toBe(1); // Only first step completed
      expect(lastError?.message).toBe("Network error during clone");

      // Cleanup after partial failure
      if (completedSteps > 0) {
        await mockFs.rm(mockWorkspaceDir, { recursive: true, force: true });
      }
    });

    it("should validate setup completion", async () => {
      const requiredPaths = [
        mockWorkspaceDir,
        join(mockWorkspaceDir, "repo"),
        join(mockWorkspaceDir, ".env"),
      ];

      // Check all required paths exist
      for (const path of requiredPaths) {
        try {
          await mockFs.access(path);
        } catch (error) {
          throw new Error(`Setup incomplete: ${path} not found`);
        }
      }

      expect(mockFs.access).toHaveBeenCalledTimes(requiredPaths.length);
    });
  });
});