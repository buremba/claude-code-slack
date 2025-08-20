#!/usr/bin/env bun

import { exec } from "child_process";
import { promisify } from "util";
import { mkdir, stat, rm } from "fs/promises";
import { join } from "path";
import logger from "./logger";
import type { 
  WorkspaceSetupConfig, 
  WorkspaceInfo, 
  GitRepository
} from "./types";
import { WorkspaceError } from "./types";

const execAsync = promisify(exec);

export class WorkspaceManager {
  private config: WorkspaceSetupConfig;
  private workspaceInfo?: WorkspaceInfo;

  constructor(config: WorkspaceSetupConfig) {
    this.config = config;
  }

  /**
   * Setup workspace by cloning repository
   */
  async setupWorkspace(repositoryUrl: string, username: string, sessionKey?: string): Promise<WorkspaceInfo> {
    try {
      logger.info(`Setting up workspace for ${username}...`);
      
      const userDirectory = join(this.config.baseDirectory, username);
      
      // Ensure base directory exists
      await this.ensureDirectory(this.config.baseDirectory);
      
      // Check if user directory already exists
      const userDirExists = await this.directoryExists(userDirectory);
      
      if (userDirExists) {
        logger.info(`User directory ${userDirectory} already exists, checking if it's a git repository...`);
        
        // Check if it's a git repository
        const isGitRepo = await this.isGitRepository(userDirectory);
        
        if (isGitRepo) {
          logger.info("Existing git repository found, updating...");
          await this.updateRepository(userDirectory, sessionKey);
        } else {
          logger.info("Directory exists but is not a git repository, removing and re-cloning...");
          await rm(userDirectory, { recursive: true, force: true });
          await this.cloneRepository(repositoryUrl, userDirectory);
        }
      } else {
        logger.info("User directory does not exist, cloning repository...");
        await this.cloneRepository(repositoryUrl, userDirectory);
      }

      // Setup git configuration
      await this.setupGitConfig(userDirectory, username);
      
      // Get repository info
      const repository = await this.getRepositoryInfo(userDirectory, repositoryUrl);
      
      // Create workspace info
      this.workspaceInfo = {
        baseDirectory: this.config.baseDirectory,
        userDirectory,
        repository,
        setupComplete: true,
      };

      logger.info(`Workspace setup completed for ${username} at ${userDirectory}`);
      return this.workspaceInfo;

    } catch (error) {
      throw new WorkspaceError(
        "setupWorkspace",
        `Failed to setup workspace for ${username}`,
        error as Error
      );
    }
  }

  /**
   * Clone repository to specified directory
   */
  private async cloneRepository(repositoryUrl: string, targetDirectory: string): Promise<void> {
    try {
      logger.info(`Cloning repository ${repositoryUrl} to ${targetDirectory}...`);
      
      // Use GitHub token for authentication
      const authenticatedUrl = this.addGitHubAuth(repositoryUrl);
      
      const { stderr } = await execAsync(
        `git clone "${authenticatedUrl}" "${targetDirectory}"`,
        { timeout: 60000 } // 1 minute timeout
      );
      
      if (stderr && !stderr.includes("Cloning into")) {
        logger.warn("Git clone warnings:", stderr);
      }
      
      logger.info("Repository cloned successfully");
      
    } catch (error) {
      throw new WorkspaceError(
        "cloneRepository",
        `Failed to clone repository ${repositoryUrl}`,
        error as Error
      );
    }
  }

  /**
   * Update existing repository
   */
  private async updateRepository(repositoryDirectory: string, sessionKey?: string): Promise<void> {
    try {
      logger.info(`Updating repository at ${repositoryDirectory}...`);
      
      // Fetch latest changes
      await execAsync("git fetch origin", { 
        cwd: repositoryDirectory,
        timeout: 30000 
      });
      
      // If sessionKey provided, check if session branch exists
      if (sessionKey) {
        // Use the thread timestamp directly in the branch name
        const branchName = `claude/${sessionKey.replace(/\./g, "-")}`;
        
        try {
          // Check if the branch exists on remote
          const { stdout } = await execAsync(
            `git ls-remote --heads origin ${branchName}`,
            { cwd: repositoryDirectory, timeout: 10000 }
          );
          
          if (stdout.trim()) {
            logger.info(`Session branch ${branchName} exists on remote, checking it out...`);
            
            // Branch exists on remote, check it out
            try {
              // Try to checkout existing local branch
              await execAsync(`git checkout "${branchName}"`, {
                cwd: repositoryDirectory,
                timeout: 10000
              });
              // Pull latest changes
              await execAsync(`git pull origin "${branchName}"`, {
                cwd: repositoryDirectory,
                timeout: 30000
              });
            } catch (checkoutError) {
              // Local branch doesn't exist, create it from remote
              await execAsync(`git checkout -b "${branchName}" "origin/${branchName}"`, {
                cwd: repositoryDirectory,
                timeout: 10000
              });
            }
            
            logger.info(`Successfully checked out session branch ${branchName}`);
            return;
          }
        } catch (error) {
          logger.info(`Session branch not found on remote, will use main/master`);
        }
      }
      
      // No session branch or sessionKey not provided, reset to main/master
      try {
        await execAsync("git reset --hard origin/main", { 
          cwd: repositoryDirectory,
          timeout: 10000 
        });
      } catch (error) {
        // Try master if main doesn't exist
        await execAsync("git reset --hard origin/master", { 
          cwd: repositoryDirectory,
          timeout: 10000 
        });
      }
      
      logger.info("Repository updated successfully");
      
    } catch (error) {
      throw new WorkspaceError(
        "updateRepository",
        `Failed to update repository at ${repositoryDirectory}`,
        error as Error
      );
    }
  }

  /**
   * Setup git configuration for the user
   */
  private async setupGitConfig(repositoryDirectory: string, username: string): Promise<void> {
    try {
      logger.info(`Setting up git configuration for ${username}...`);
      
      // Set user name and email
      await execAsync(`git config user.name "Claude Code Bot (${username})"`, {
        cwd: repositoryDirectory,
      });
      
      await execAsync(`git config user.email "claude-code-bot+${username}@noreply.github.com"`, {
        cwd: repositoryDirectory,
      });
      
      // Set push default
      await execAsync("git config push.default simple", {
        cwd: repositoryDirectory,
      });
      
      logger.info("Git configuration completed");
      
    } catch (error) {
      throw new WorkspaceError(
        "setupGitConfig",
        `Failed to setup git configuration for ${username}`,
        error as Error
      );
    }
  }


  /**
   * Get repository information
   */
  private async getRepositoryInfo(repositoryDirectory: string, repositoryUrl: string): Promise<GitRepository> {
    try {
      // Get current branch
      const { stdout: branchOutput } = await execAsync("git branch --show-current", {
        cwd: repositoryDirectory,
      });
      const branch = branchOutput.trim();
      
      // Get last commit hash
      const { stdout: commitOutput } = await execAsync("git rev-parse HEAD", {
        cwd: repositoryDirectory,
      });
      const lastCommit = commitOutput.trim();
      
      return {
        url: repositoryUrl,
        branch,
        directory: repositoryDirectory,
        lastCommit,
      };
      
    } catch (error) {
      throw new WorkspaceError(
        "getRepositoryInfo",
        `Failed to get repository information`,
        error as Error
      );
    }
  }

  /**
   * Add GitHub authentication to URL
   */
  private addGitHubAuth(repositoryUrl: string): string {
    try {
      const url = new URL(repositoryUrl);
      
      if (url.hostname === "github.com") {
        // Convert to authenticated HTTPS URL
        url.username = "x-access-token";
        url.password = this.config.githubToken;
        return url.toString();
      }
      
      return repositoryUrl;
      
    } catch (error) {
      logger.warn("Failed to parse repository URL, using as-is:", error);
      return repositoryUrl;
    }
  }

  /**
   * Check if directory exists
   */
  private async directoryExists(path: string): Promise<boolean> {
    try {
      const stats = await stat(path);
      return stats.isDirectory();
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if directory is a git repository
   */
  private async isGitRepository(path: string): Promise<boolean> {
    try {
      await execAsync("git status", { cwd: path, timeout: 5000 });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Ensure directory exists
   */
  private async ensureDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  /**
   * Get workspace information
   */
  getWorkspaceInfo(): WorkspaceInfo | undefined {
    return this.workspaceInfo;
  }

  /**
   * Get current working directory
   */
  getCurrentWorkingDirectory(): string {
    return this.workspaceInfo?.userDirectory || this.config.baseDirectory;
  }

  /**
   * Get current working directory relative to project root
   */
  getRelativeWorkingDirectory(): string {
    if (!this.workspaceInfo?.userDirectory) {
      return "./";
    }
    
    try {
      // Get the current working directory from process.cwd() relative to the project root
      const currentDir = process.cwd();
      const projectRoot = this.workspaceInfo.userDirectory;
      
      // If we're at the project root, return "./"
      if (currentDir === projectRoot) {
        return "./";
      }
      
      // If we're inside the project, return relative path
      if (currentDir.startsWith(projectRoot)) {
        const relativePath = currentDir.substring(projectRoot.length + 1);
        return `./${relativePath}`;
      }
      
      // If we're outside the project, just return the directory name
      return "./";
    } catch (error) {
      // Fallback to default
      return "./";
    }
  }

  /**
   * Create a new branch for the session
   */
  async createSessionBranch(sessionKey: string): Promise<string> {
    if (!this.workspaceInfo) {
      throw new WorkspaceError("createSessionBranch", "Workspace not setup");
    }

    try {
      // Use the thread timestamp directly in the branch name
      // Replace dots with dashes for git branch naming conventions
      const branchName = `claude/${sessionKey.replace(/\./g, "-")}`;
      
      logger.info(`Checking if session branch exists: ${branchName}`);
      
      // Check if branch already exists locally or remotely
      try {
        // Try to checkout existing branch
        await execAsync(`git checkout "${branchName}"`, {
          cwd: this.workspaceInfo.userDirectory,
        });
        logger.info(`Session branch ${branchName} already exists locally, checked out`);
      } catch (checkoutError) {
        // Branch doesn't exist locally, check remote
        try {
          const { stdout } = await execAsync(
            `git ls-remote --heads origin ${branchName}`,
            { cwd: this.workspaceInfo.userDirectory, timeout: 10000 }
          );
          
          if (stdout.trim()) {
            // Branch exists on remote, checkout from remote
            await execAsync(`git checkout -b "${branchName}" "origin/${branchName}"`, {
              cwd: this.workspaceInfo.userDirectory,
            });
            logger.info(`Session branch ${branchName} exists on remote, checked out`);
          } else {
            // Branch doesn't exist anywhere, create new
            await execAsync(`git checkout -b "${branchName}"`, {
              cwd: this.workspaceInfo.userDirectory,
            });
            logger.info(`Created new session branch: ${branchName}`);
          }
        } catch (error) {
          // Error checking remote, create new branch
          await execAsync(`git checkout -b "${branchName}"`, {
            cwd: this.workspaceInfo.userDirectory,
          });
          logger.info(`Created new session branch: ${branchName}`);
        }
      }
      
      this.workspaceInfo.repository.branch = branchName;
      
      return branchName;
      
    } catch (error) {
      throw new WorkspaceError(
        "createSessionBranch",
        `Failed to create session branch for ${sessionKey}`,
        error as Error
      );
    }
  }

  /**
   * Commit and push changes
   */
  async commitAndPush(message: string): Promise<void> {
    if (!this.workspaceInfo) {
      throw new WorkspaceError("commitAndPush", "Workspace not setup");
    }

    try {
      const repoDir = this.workspaceInfo.userDirectory;
      
      // Sync Claude projects before committing
      try {
        await execAsync("/app/scripts/sync-claude-projects.sh", { cwd: repoDir });
        logger.info("Synced Claude projects");
      } catch (error) {
        logger.warn("Failed to sync Claude projects:", error);
      }
      
      // Add all changes
      await execAsync("git add .", { cwd: repoDir });
      
      // Check if there are changes to commit
      try {
        await execAsync("git diff --cached --exit-code", { cwd: repoDir });
        logger.info("No changes to commit");
        return;
      } catch (error) {
        // Changes exist, proceed with commit
      }
      
      // Commit changes
      await execAsync(`git commit -m "${message}"`, { cwd: repoDir });
      
      // Push to origin
      const branch = this.workspaceInfo.repository.branch;
      await execAsync(`git push -u origin "${branch}"`, { 
        cwd: repoDir,
        timeout: 30000 
      });
      
      logger.info(`Changes committed and pushed to ${branch}`);
      
    } catch (error) {
      throw new WorkspaceError(
        "commitAndPush",
        `Failed to commit and push changes`,
        error as Error
      );
    }
  }

  /**
   * Clean up workspace
   */
  async cleanup(): Promise<void> {
    try {
      logger.info("Cleaning up workspace...");
      
      if (this.workspaceInfo) {
        // Commit any final changes
        try {
          await this.commitAndPush("Final session cleanup by Claude Code Worker");
        } catch (error) {
          logger.warn("Failed to commit final changes:", error);
        }
      }
      
      logger.info("Workspace cleanup completed");
      
    } catch (error) {
      logger.error("Error during workspace cleanup:", error);
    }
  }

  /**
   * Get repository status
   */
  async getRepositoryStatus(): Promise<{
    branch: string;
    hasChanges: boolean;
    changedFiles: string[];
  }> {
    if (!this.workspaceInfo) {
      throw new WorkspaceError("getRepositoryStatus", "Workspace not setup");
    }

    try {
      const repoDir = this.workspaceInfo.userDirectory;
      
      // Get current branch
      const { stdout: branchOutput } = await execAsync("git branch --show-current", {
        cwd: repoDir,
      });
      const branch = branchOutput.trim();
      
      // Get status
      const { stdout: statusOutput } = await execAsync("git status --porcelain", {
        cwd: repoDir,
      });
      
      const changedFiles = statusOutput
        .split("\n")
        .filter(line => line.trim())
        .map(line => line.substring(3)); // Remove status prefix
      
      return {
        branch,
        hasChanges: changedFiles.length > 0,
        changedFiles,
      };
      
    } catch (error) {
      throw new WorkspaceError(
        "getRepositoryStatus",
        "Failed to get repository status",
        error as Error
      );
    }
  }
}