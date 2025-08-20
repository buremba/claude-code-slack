#!/usr/bin/env bun

/**
 * Conversation History Sync Interface
 * 
 * Provides an interface for persisting conversation history across different storage backends:
 * - FileCopySync: Git-based persistence (current implementation)
 * - PostgreSQLSync: Database-based persistence (new implementation)
 */

export interface ConversationHistorySync {
  /**
   * Save session mapping (links session key to Claude session ID)
   */
  saveSessionMapping(sessionKey: string, claudeSessionId: string, tenantId: string, userId: string, botId?: string): Promise<void>;
  
  /**
   * Load session mapping to resume conversations
   */
  loadSessionMapping(sessionKey: string, tenantId: string): Promise<string | undefined>;
  
  /**
   * Sync conversation files after Claude execution
   */
  syncConversationFiles(sessionKey: string, claudeSessionId: string, tenantId: string, userId: string, botId?: string): Promise<void>;
  
  /**
   * Check if a session exists
   */
  sessionExists(sessionKey: string, tenantId: string): Promise<boolean>;
  
  /**
   * Get conversation history for a session
   */
  getConversationHistory(sessionKey: string, tenantId: string): Promise<ConversationHistoryEntry[]>;
  
  /**
   * Cleanup resources
   */
  cleanup?(): Promise<void>;
}

export interface ConversationHistoryEntry {
  id: string;
  sessionKey: string;
  claudeSessionId: string;
  tenantId: string;
  fromUserId: string;
  botId?: string;
  conversationData: any; // JSONB data containing the actual conversation
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceEntry {
  id: string;
  tenantType: 'slack' | 'discord' | 'teams';
  tenantId: string; // workspace ID
  displayName?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Factory function to create the appropriate sync implementation based on environment
 */
export function createConversationHistorySync(): ConversationHistorySync {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (databaseUrl) {
    // Use PostgreSQL implementation
    const { PostgreSQLConversationHistorySync } = require('./postgresql-conversation-history-sync');
    return new PostgreSQLConversationHistorySync(databaseUrl);
  } else {
    // Use FileCopy implementation (Git-based)
    const { FileCopyConversationHistorySync } = require('./file-copy-conversation-history-sync');
    return new FileCopyConversationHistorySync();
  }
}