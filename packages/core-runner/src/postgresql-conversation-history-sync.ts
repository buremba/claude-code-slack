#!/usr/bin/env bun

import { Pool } from 'pg';
import logger from './logger';
import type { 
  ConversationHistorySync, 
  ConversationHistoryEntry, 
  WorkspaceEntry 
} from './conversation-history-sync';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * PostgreSQL-based conversation history sync implementation
 */
export class PostgreSQLConversationHistorySync implements ConversationHistorySync {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
    });
    
    // Initialize database schema on startup
    this.initializeSchema().catch(error => {
      logger.error('Failed to initialize PostgreSQL schema:', error);
    });
  }

  /**
   * Initialize database schema with conversations and workspaces tables
   */
  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Create workspaces table
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id SERIAL PRIMARY KEY,
          tenant_type VARCHAR(50) NOT NULL,
          tenant_id VARCHAR(255) NOT NULL UNIQUE,
          display_name VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      // Create index on tenant_id for fast lookups
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_id 
        ON workspaces(tenant_id);
      `);
      
      // Create conversations table
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id SERIAL PRIMARY KEY,
          session_key VARCHAR(255) NOT NULL,
          claude_session_id VARCHAR(255) NOT NULL,
          tenant_id VARCHAR(255) NOT NULL,
          from_user_id VARCHAR(255) NOT NULL,
          bot_id VARCHAR(255),
          conversation_data JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_key, tenant_id)
        );
      `);
      
      // Create indexes for efficient queries
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_conversations_session_tenant 
        ON conversations(session_key, tenant_id);
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_conversations_claude_session 
        ON conversations(claude_session_id);
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_conversations_user_tenant 
        ON conversations(from_user_id, tenant_id);
      `);
      
      // Create trigger to update updated_at timestamp
      await client.query(`
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';
      `);
      
      await client.query(`
        DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
        CREATE TRIGGER update_conversations_updated_at
          BEFORE UPDATE ON conversations
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
      `);
      
      await client.query(`
        DROP TRIGGER IF EXISTS update_workspaces_updated_at ON workspaces;
        CREATE TRIGGER update_workspaces_updated_at
          BEFORE UPDATE ON workspaces
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
      `);
      
      await client.query('COMMIT');
      logger.info('PostgreSQL schema initialized successfully');
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to initialize PostgreSQL schema:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ensure workspace exists in the database
   */
  private async ensureWorkspaceExists(tenantId: string, tenantType: 'slack' | 'discord' | 'teams' = 'slack'): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Note: With RLS enabled, users can only insert/access workspaces matching their tenant pattern
      await client.query(
        `INSERT INTO workspaces (tenant_type, tenant_id, display_name) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantType, tenantId, `${tenantType}-${tenantId}`]
      );
    } catch (error) {
      logger.error(`Failed to ensure workspace exists for ${tenantId}:`, error);
      throw error;
    } finally {
      client.release();
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
    await this.ensureWorkspaceExists(tenantId);
    
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO conversations (session_key, claude_session_id, tenant_id, from_user_id, bot_id) 
         VALUES ($1, $2, $3, $4, $5) 
         ON CONFLICT (session_key, tenant_id) 
         DO UPDATE SET 
           claude_session_id = EXCLUDED.claude_session_id,
           from_user_id = EXCLUDED.from_user_id,
           bot_id = EXCLUDED.bot_id,
           updated_at = CURRENT_TIMESTAMP`,
        [sessionKey, claudeSessionId, tenantId, userId, botId]
      );
      
      logger.info(`Saved session mapping: ${sessionKey} -> ${claudeSessionId} (tenant: ${tenantId})`);
    } catch (error) {
      logger.error(`Failed to save session mapping for ${sessionKey}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Load session mapping to resume conversations
   */
  async loadSessionMapping(sessionKey: string, tenantId: string): Promise<string | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT claude_session_id FROM conversations WHERE session_key = $1 AND tenant_id = $2',
        [sessionKey, tenantId]
      );
      
      if (result.rows.length > 0) {
        const claudeSessionId = result.rows[0].claude_session_id;
        logger.info(`Loaded session mapping: ${sessionKey} -> ${claudeSessionId} (tenant: ${tenantId})`);
        return claudeSessionId;
      }
      
      return undefined;
    } catch (error) {
      logger.error(`Failed to load session mapping for ${sessionKey}:`, error);
      return undefined;
    } finally {
      client.release();
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
      // Read the conversation file from Claude's output
      const claudeProjectsDir = path.join('/home/claude/.claude/projects');
      const conversationFile = path.join(claudeProjectsDir, process.env.USERNAME || 'default', `${claudeSessionId}.jsonl`);
      
      let conversationData: any = {};
      
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
      } catch (fileError) {
        logger.warn(`Could not read conversation file ${conversationFile}, using empty data:`, fileError);
        conversationData = {
          entries: [],
          totalLines: 0,
          lastModified: new Date().toISOString(),
          error: 'Conversation file not found'
        };
      }

      await this.ensureWorkspaceExists(tenantId);
      
      const client = await this.pool.connect();
      try {
        await client.query(
          `INSERT INTO conversations (session_key, claude_session_id, tenant_id, from_user_id, bot_id, conversation_data) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (session_key, tenant_id) 
           DO UPDATE SET 
             claude_session_id = EXCLUDED.claude_session_id,
             from_user_id = EXCLUDED.from_user_id,
             bot_id = EXCLUDED.bot_id,
             conversation_data = EXCLUDED.conversation_data,
             updated_at = CURRENT_TIMESTAMP`,
          [sessionKey, claudeSessionId, tenantId, userId, botId, JSON.stringify(conversationData)]
        );
        
        logger.info(`Synced conversation data to PostgreSQL: ${sessionKey} (${conversationData.totalLines} entries)`);
      } catch (error) {
        logger.error(`Failed to sync conversation data for ${sessionKey}:`, error);
        throw error;
      } finally {
        client.release();
      }
      
    } catch (error) {
      logger.error('Error syncing conversation files to PostgreSQL:', error);
      throw error;
    }
  }

  /**
   * Check if a session exists
   */
  async sessionExists(sessionKey: string, tenantId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT 1 FROM conversations WHERE session_key = $1 AND tenant_id = $2 LIMIT 1',
        [sessionKey, tenantId]
      );
      
      return result.rows.length > 0;
    } catch (error) {
      logger.error(`Failed to check if session exists for ${sessionKey}:`, error);
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Get conversation history for a session
   */
  async getConversationHistory(sessionKey: string, tenantId: string): Promise<ConversationHistoryEntry[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, session_key, claude_session_id, tenant_id, from_user_id, bot_id, 
                conversation_data, created_at, updated_at 
         FROM conversations 
         WHERE session_key = $1 AND tenant_id = $2 
         ORDER BY updated_at DESC`,
        [sessionKey, tenantId]
      );
      
      return result.rows.map(row => ({
        id: row.id.toString(),
        sessionKey: row.session_key,
        claudeSessionId: row.claude_session_id,
        tenantId: row.tenant_id,
        fromUserId: row.from_user_id,
        botId: row.bot_id,
        conversationData: row.conversation_data,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      logger.error(`Failed to get conversation history for ${sessionKey}:`, error);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    try {
      await this.pool.end();
      logger.info('PostgreSQL connection pool closed');
    } catch (error) {
      logger.error('Error closing PostgreSQL connection pool:', error);
    }
  }
}