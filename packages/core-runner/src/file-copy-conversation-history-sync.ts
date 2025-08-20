#!/usr/bin/env bun

import { promises as fs } from 'fs';
import path from 'path';
import logger from './logger';
import type { 
  ConversationHistorySync, 
  ConversationHistoryEntry, 
  WorkspaceEntry 
} from './conversation-history-sync';

/**
 * File-based conversation history sync implementation (Git-based persistence)
 * This is a refactor of the existing Git-based approach into the interface
 */
export class FileCopyConversationHistorySync implements ConversationHistorySync {
  private baseDirectory: string;

  constructor(baseDirectory?: string) {
    // Default to workspace directory structure
    this.baseDirectory = baseDirectory || `/workspace/${process.env.USERNAME || 'default'}`;
  }

  /**
   * Get the session directory for a specific tenant
   */
  private getSessionDirectory(tenantId: string): string {
    return path.join(this.baseDirectory, '.claude', 'projects', process.env.USERNAME || 'default');
  }

  /**
   * Get the mapping file path for a session
   */
  private getMappingFilePath(sessionKey: string, tenantId: string): string {
    const sessionDir = this.getSessionDirectory(tenantId);
    return path.join(sessionDir, `${sessionKey}.mapping`);
  }

  /**
   * Ensure session directory exists
   */
  private async ensureSessionDirectoryExists(tenantId: string): Promise<void> {
    const sessionDir = this.getSessionDirectory(tenantId);
    try {
      await fs.mkdir(sessionDir, { recursive: true });
    } catch (error) {
      logger.error(`Failed to create session directory ${sessionDir}:`, error);
      throw error;
    }
  }

  /**
   * Save session mapping (links session key to Claude session ID)
   */
  async saveSessionMapping(
    sessionKey: string, 
    claudeSessionId: string, 
    tenantId: string, 
    userId: string, 
    botId?: string
  ): Promise<void> {
    try {
      await this.ensureSessionDirectoryExists(tenantId);
      
      const mappingFile = this.getMappingFilePath(sessionKey, tenantId);
      
      // Create mapping data with metadata
      const mappingData = {
        claudeSessionId,
        tenantId,
        userId,
        botId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      await fs.writeFile(mappingFile, JSON.stringify(mappingData, null, 2), 'utf8');
      
      logger.info(`Saved session mapping: ${sessionKey} -> ${claudeSessionId} (tenant: ${tenantId})`);
    } catch (error) {
      logger.error(`Failed to save session mapping for ${sessionKey}:`, error);
      throw error;
    }
  }

  /**
   * Load session mapping to resume conversations
   */
  async loadSessionMapping(sessionKey: string, tenantId: string): Promise<string | undefined> {
    try {
      const mappingFile = this.getMappingFilePath(sessionKey, tenantId);
      
      try {
        const mappingContent = await fs.readFile(mappingFile, 'utf8');
        
        // Try to parse as JSON first (new format)
        try {
          const mappingData = JSON.parse(mappingContent);
          logger.info(`Loaded session mapping: ${sessionKey} -> ${mappingData.claudeSessionId} (tenant: ${tenantId})`);
          return mappingData.claudeSessionId;
        } catch {
          // Fallback to plain text format (legacy)
          const claudeSessionId = mappingContent.trim();
          logger.info(`Loaded legacy session mapping: ${sessionKey} -> ${claudeSessionId} (tenant: ${tenantId})`);
          return claudeSessionId;
        }
      } catch (error) {
        if ((error as any).code !== 'ENOENT') {
          logger.error(`Failed to read session mapping file for ${sessionKey}:`, error);
        }
        return undefined;
      }
    } catch (error) {
      logger.error(`Failed to load session mapping for ${sessionKey}:`, error);
      return undefined;
    }
  }

  /**
   * Sync conversation files after Claude execution
   */
  async syncConversationFiles(
    sessionKey: string, 
    claudeSessionId: string, 
    tenantId: string, 
    userId: string, 
    botId?: string
  ): Promise<void> {
    try {
      logger.info("Syncing conversation file for current session...");
      
      // Paths for the conversation file
      const homeClaudeDir = '/home/claude/.claude/projects';
      const workspaceName = process.env.USERNAME || 'default';
      const sessionFile = `${claudeSessionId}.jsonl`;
      
      const srcPath = path.join(homeClaudeDir, workspaceName, sessionFile);
      const destDir = path.join(this.baseDirectory, '.claude', 'projects');
      const destPath = path.join(destDir, sessionFile);
      
      logger.info(`Copying conversation file from ${srcPath} to ${destPath}`);
      
      // Check if source file exists
      try {
        await fs.access(srcPath);
      } catch {
        logger.info(`No conversation file found at ${srcPath}`);
        return;
      }
      
      // Ensure destination directory exists
      await fs.mkdir(destDir, { recursive: true });
      
      // Copy the conversation file
      await fs.copyFile(srcPath, destPath);
      logger.info(`Successfully synced conversation file: ${sessionFile}`);
      
      // Also save metadata file alongside the conversation
      const metadataPath = path.join(destDir, `${sessionFile}.meta`);
      const metadata = {
        sessionKey,
        claudeSessionId,
        tenantId,
        userId,
        botId,
        syncedAt: new Date().toISOString()
      };
      
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
      
      logger.info(`Conversation synced to Git-based storage: ${sessionKey}`);
      
    } catch (error) {
      logger.error("Error syncing conversation files:", error);
      throw error;
    }
  }

  /**
   * Check if a session exists
   */
  async sessionExists(sessionKey: string, tenantId: string): Promise<boolean> {
    try {
      const mappingFile = this.getMappingFilePath(sessionKey, tenantId);
      
      try {
        await fs.access(mappingFile);
        return true;
      } catch (error) {
        if ((error as any).code === 'ENOENT') {
          return false;
        }
        logger.error(`Failed to check if session exists for ${sessionKey}:`, error);
        return false;
      }
    } catch (error) {
      logger.error(`Failed to check if session exists for ${sessionKey}:`, error);
      return false;
    }
  }

  /**
   * Get conversation history for a session
   */
  async getConversationHistory(sessionKey: string, tenantId: string): Promise<ConversationHistoryEntry[]> {
    try {
      const sessionMapping = await this.loadSessionMapping(sessionKey, tenantId);
      if (!sessionMapping) {
        return [];
      }

      const sessionDir = this.getSessionDirectory(tenantId);
      const conversationFile = path.join(this.baseDirectory, '.claude', 'projects', `${sessionMapping}.jsonl`);
      const metadataFile = path.join(this.baseDirectory, '.claude', 'projects', `${sessionMapping}.jsonl.meta`);
      
      let conversationData: any = {};
      let metadata: any = {};
      
      // Try to read conversation file
      try {
        const conversationContent = await fs.readFile(conversationFile, 'utf-8');
        const lines = conversationContent.split('\n').filter(line => line.trim());
        conversationData = {
          entries: lines.map(line => {
            try {
              return JSON.parse(line);
            } catch {
              return { content: line };
            }
          }),
          totalLines: lines.length,
          lastModified: new Date().toISOString()
        };
      } catch (error) {
        logger.warn(`Could not read conversation file ${conversationFile}:`, error);
        conversationData = { entries: [], totalLines: 0 };
      }
      
      // Try to read metadata file
      try {
        const metadataContent = await fs.readFile(metadataFile, 'utf-8');
        metadata = JSON.parse(metadataContent);
      } catch (error) {
        logger.warn(`Could not read metadata file ${metadataFile}:`, error);
        metadata = {
          sessionKey,
          claudeSessionId: sessionMapping,
          tenantId,
          userId: 'unknown',
          syncedAt: new Date().toISOString()
        };
      }

      // Get file stats for timestamps
      let createdAt = new Date();
      let updatedAt = new Date();
      
      try {
        const stats = await fs.stat(conversationFile);
        createdAt = stats.birthtime;
        updatedAt = stats.mtime;
      } catch (error) {
        logger.warn(`Could not get file stats for ${conversationFile}:`, error);
      }

      return [{
        id: `${sessionKey}-${tenantId}`,
        sessionKey,
        claudeSessionId: sessionMapping,
        tenantId,
        fromUserId: metadata.userId || 'unknown',
        botId: metadata.botId,
        conversationData,
        createdAt,
        updatedAt,
      }];
      
    } catch (error) {
      logger.error(`Failed to get conversation history for ${sessionKey}:`, error);
      return [];
    }
  }

  /**
   * Cleanup resources (no-op for file-based implementation)
   */
  async cleanup(): Promise<void> {
    logger.info('FileCopy conversation history sync cleanup completed (no resources to clean)');
  }
}