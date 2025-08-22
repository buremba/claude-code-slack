#!/usr/bin/env bun

import { Pool, PoolClient } from "pg";
import type { OrchestratorConfig } from "./types";
import { OrchestratorError, ErrorCode } from "./types";

/**
 * Shared database connection pool service
 * Singleton pattern to ensure single pool instance across all components
 */
export class SharedDatabasePool {
  private static instance: SharedDatabasePool;
  private pool: Pool;
  private config: OrchestratorConfig;

  private constructor(config: OrchestratorConfig) {
    this.config = config;
    this.pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.username,
      password: config.database.password,
      ssl: config.database.ssl,
      max: 25, // Increased for shared usage
      min: 5,  // Higher minimum for better performance
      idleTimeoutMillis: 60000, // Increased timeout
      connectionTimeoutMillis: 15000,
      acquireTimeoutMillis: 30000, // Timeout for acquiring connection
    });

    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error('Shared database pool error:', err);
    });
  }

  /**
   * Get or create the singleton instance
   */
  static getInstance(config?: OrchestratorConfig): SharedDatabasePool {
    if (!SharedDatabasePool.instance) {
      if (!config) {
        throw new Error('SharedDatabasePool requires config for first initialization');
      }
      SharedDatabasePool.instance = new SharedDatabasePool(config);
    }
    return SharedDatabasePool.instance;
  }

  /**
   * Get a database client with user context set for RLS
   */
  async getClientWithUserContext(userId: string): Promise<PoolClient> {
    let client: PoolClient;
    
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw OrchestratorError.databaseError('getClientWithUserContext', error as Error);
    }
    
    try {
      // Set user context for RLS policies using PostgreSQL session configuration
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      return client;
    } catch (error) {
      // Release client back to pool if context setting fails
      client.release();
      throw new OrchestratorError(
        ErrorCode.DATABASE_ERROR,
        `Failed to set user context for user ${userId}`,
        error as Error,
        { userId }
      );
    }
  }

  /**
   * Execute a query with user context
   */
  async queryWithUserContext<T = any>(
    userId: string, 
    text: string, 
    params?: any[]
  ): Promise<T> {
    const client = await this.getClientWithUserContext(userId);
    
    try {
      const result = await client.query(text, params);
      return result.rows;
    } catch (error) {
      throw OrchestratorError.databaseError('queryWithUserContext', error as Error);
    } finally {
      client.release();
    }
  }

  /**
   * Execute a transaction with user context
   */
  async transactionWithUserContext<T>(
    userId: string,
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.getClientWithUserContext(userId);
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw OrchestratorError.databaseError('transactionWithUserContext', error as Error);
    } finally {
      client.release();
    }
  }

  /**
   * Create user-specific database credentials
   * This function should be called when a new user is registered
   */
  async createUserCredentials(userId: string): Promise<{ username: string; password: string }> {
    const username = `user_${userId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const password = this.generateSecurePassword();
    
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create user role if it doesn't exist
      await client.query(`SELECT create_user_role($1, $2)`, [userId, password]);
      
      await client.query('COMMIT');
      
      return { username, password };
    } catch (error) {
      await client.query('ROLLBACK');
      throw OrchestratorError.databaseError('createUserCredentials', error as Error);
    } finally {
      client.release();
    }
  }

  /**
   * Check pool health and connection status
   */
  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; details: any }> {
    try {
      const startTime = Date.now();
      const client = await this.pool.connect();
      
      try {
        await client.query('SELECT 1');
        const responseTime = Date.now() - startTime;
        
        return {
          status: responseTime > 1000 ? 'degraded' : 'healthy',
          details: {
            totalConnections: this.pool.totalCount,
            idleConnections: this.pool.idleCount,
            waitingConnections: this.pool.waitingCount,
            responseTime
          }
        };
      } finally {
        client.release();
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        details: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  /**
   * Generate secure password for database users
   */
  private generateSecurePassword(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 32; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  /**
   * Graceful shutdown of the connection pool
   */
  async shutdown(): Promise<void> {
    try {
      await this.pool.end();
      console.log('Shared database pool shutdown completed');
    } catch (error) {
      console.error('Error during database pool shutdown:', error);
    }
  }
}