#!/usr/bin/env bun

import { Pool, PoolClient } from "pg";

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

export interface DatabasePoolOptions {
  maxConnections?: number;
  minConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/**
 * Shared database connection pool service
 * Can be used across different packages (dispatcher, orchestrator, worker)
 */
export class DatabasePoolService {
  private static instances: Map<string, DatabasePoolService> = new Map();
  private pool: Pool;
  private config: DatabaseConfig;
  private poolKey: string;

  private constructor(config: DatabaseConfig, options: DatabasePoolOptions = {}, poolKey: string) {
    this.config = config;
    this.poolKey = poolKey;
    
    const {
      maxConnections = 20,
      minConnections = 2,
      idleTimeoutMs = 60000,
      connectionTimeoutMs = 15000
    } = options;

    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl,
      max: maxConnections,
      min: minConnections,
      idleTimeoutMillis: idleTimeoutMs,
      connectionTimeoutMillis: connectionTimeoutMs,
      acquireTimeoutMillis: 30000,
    });

    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error(`Database pool error (${poolKey}):`, err);
    });

    // Handle client errors
    this.pool.on('connect', (client) => {
      client.on('error', (err) => {
        console.error(`Database client error (${poolKey}):`, err);
      });
    });
  }

  /**
   * Get or create a database pool instance
   * Uses a key-based approach to allow different pool configurations
   */
  static getInstance(
    poolKey: string,
    config?: DatabaseConfig, 
    options?: DatabasePoolOptions
  ): DatabasePoolService {
    let instance = DatabasePoolService.instances.get(poolKey);
    
    if (!instance) {
      if (!config) {
        throw new Error(`DatabasePoolService requires config for first initialization of pool: ${poolKey}`);
      }
      instance = new DatabasePoolService(config, options, poolKey);
      DatabasePoolService.instances.set(poolKey, instance);
    }
    
    return instance;
  }

  /**
   * Get a database client with user context set for RLS
   */
  async getClientWithUserContext(userId: string): Promise<PoolClient> {
    let client: PoolClient;
    
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new Error(`Failed to get database client: ${error}`);
    }
    
    try {
      // Set user context for RLS policies using PostgreSQL session configuration
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      return client;
    } catch (error) {
      // Release client back to pool if context setting fails
      client.release();
      throw new Error(`Failed to set user context for user ${userId}: ${error}`);
    }
  }

  /**
   * Get a raw database client without user context
   */
  async getClient(): Promise<PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw new Error(`Failed to get database client: ${error}`);
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
      throw new Error(`Query failed: ${error}`);
    } finally {
      client.release();
    }
  }

  /**
   * Execute a query without user context (admin operations)
   */
  async query<T = any>(text: string, params?: any[]): Promise<T> {
    const client = await this.getClient();
    
    try {
      const result = await client.query(text, params);
      return result.rows;
    } catch (error) {
      throw new Error(`Query failed: ${error}`);
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
      throw new Error(`Transaction failed: ${error}`);
    } finally {
      client.release();
    }
  }

  /**
   * Check pool health and connection status
   */
  async healthCheck(): Promise<{ 
    status: 'healthy' | 'degraded' | 'unhealthy'; 
    details: any;
    poolKey: string;
  }> {
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
          },
          poolKey: this.poolKey
        };
      } finally {
        client.release();
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        details: { error: error instanceof Error ? error.message : 'Unknown error' },
        poolKey: this.poolKey
      };
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      poolKey: this.poolKey,
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingConnections: this.pool.waitingCount,
    };
  }

  /**
   * Graceful shutdown of the connection pool
   */
  async shutdown(): Promise<void> {
    try {
      await this.pool.end();
      DatabasePoolService.instances.delete(this.poolKey);
      console.log(`Database pool shutdown completed: ${this.poolKey}`);
    } catch (error) {
      console.error(`Error during database pool shutdown (${this.poolKey}):`, error);
    }
  }

  /**
   * Shutdown all pool instances
   */
  static async shutdownAll(): Promise<void> {
    const shutdownPromises = Array.from(DatabasePoolService.instances.values()).map(
      instance => instance.shutdown()
    );
    
    await Promise.allSettled(shutdownPromises);
    console.log('All database pools shutdown completed');
  }
}