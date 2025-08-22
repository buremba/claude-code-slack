#!/usr/bin/env bun

import { Pool, PoolClient } from "pg";
import type { OrchestratorConfig } from "./types";
import { OrchestratorError, ErrorCode } from "./types";

/**
 * Database connection pool with RLS support
 * Manages bot-specific database connections with proper isolation
 */
export class DatabasePool {
  private pool: Pool;
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.username,
      password: config.database.password,
      ssl: config.database.ssl,
      max: 20, // Maximum number of clients in pool
      min: 2,  // Minimum number of clients in pool
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
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
        'getClientWithUserContext',
        ErrorCode.RLS_CONTEXT_FAILED,
        `Failed to set RLS context for user ${userId}: ${(error as Error).message}`,
        error as Error
      );
    }
  }

  /**
   * Execute a query with user context
   */
  async queryWithUserContext<T>(
    userId: string,
    query: string,
    params?: any[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    const client = await this.getClientWithUserContext(userId);
    
    try {
      const result = await client.query(query, params);
      return {
        rows: result.rows,
        rowCount: result.rowCount || 0
      };
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
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update job status using the database function
   */
  async updateJobStatus(
    jobId: string,
    status: 'pending' | 'active' | 'completed' | 'failed',
    retryCount?: number
  ): Promise<void> {
    try {
      const query = 'SELECT update_job_status($1, $2, $3)';
      const params = [jobId, status, retryCount || null];
      
      await this.pool.query(query, params);
    } catch (error) {
      throw OrchestratorError.databaseError('updateJobStatus', error as Error);
    }
  }

  /**
   * Close the database pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Create user-specific database credentials
   */
  async createUserCredentials(platformUserId: string, password: string): Promise<string> {
    try {
      const result = await this.pool.query(
        'SELECT create_user_role($1, $2) as role_name',
        [platformUserId, password]
      );
      return result.rows[0].role_name;
    } catch (error) {
      throw OrchestratorError.databaseError('createUserCredentials', error as Error);
    }
  }

  /**
   * Check if pool is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch {
      return false;
    }
  }
}