#!/usr/bin/env bun

import { KubernetesApi } from '@kubernetes/client-node';
import { DatabasePoolService } from '../shared/database-pool-service';
import { OrchestratorError, ErrorCode } from './types';

export interface SecretConfig {
  namespace: string;
  secretName: string;
  userSecretPrefix: string;
  passwordSecretPrefix: string;
  externalSecretOperator: boolean;
  externalSecretStore: string;
}

export interface UserCredentials {
  username: string;
  password: string;
  secretName: string;
}

/**
 * Secret management service for user-specific database credentials
 * Handles both native Kubernetes secrets and External Secret Operator
 */
export class SecretManager {
  private k8sApi: KubernetesApi;
  private dbPool: DatabasePoolService;
  private config: SecretConfig;
  private credentialCache: Map<string, UserCredentials> = new Map();

  constructor(
    k8sApi: KubernetesApi,
    dbPool: DatabasePoolService,
    config: SecretConfig
  ) {
    this.k8sApi = k8sApi;
    this.dbPool = dbPool;
    this.config = config;
  }

  /**
   * Get or create user-specific database credentials
   */
  async getUserCredentials(userId: string): Promise<UserCredentials> {
    // Check cache first
    const cached = this.credentialCache.get(userId);
    if (cached) {
      return cached;
    }

    try {
      // Try to get existing credentials from Kubernetes secrets
      const existingCredentials = await this.getExistingCredentials(userId);
      if (existingCredentials) {
        this.credentialCache.set(userId, existingCredentials);
        return existingCredentials;
      }

      // Create new credentials if they don't exist
      const newCredentials = await this.createUserCredentials(userId);
      this.credentialCache.set(userId, newCredentials);
      return newCredentials;

    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.KUBERNETES_ERROR,
        `Failed to get user credentials for ${userId}`,
        error as Error,
        { userId }
      );
    }
  }

  /**
   * Get existing credentials from Kubernetes secrets
   */
  private async getExistingCredentials(userId: string): Promise<UserCredentials | null> {
    try {
      const response = await this.k8sApi.coreV1Api.readNamespacedSecret({
        name: this.config.secretName,
        namespace: this.config.namespace
      });

      const secretData = response.body.data;
      if (!secretData) {
        return null;
      }

      const usernameKey = `${this.config.userSecretPrefix}${userId}`;
      const passwordKey = `${this.config.passwordSecretPrefix}${userId}`;

      const username = secretData[usernameKey];
      const password = secretData[passwordKey];

      if (!username || !password) {
        return null;
      }

      return {
        username: Buffer.from(username, 'base64').toString('utf-8'),
        password: Buffer.from(password, 'base64').toString('utf-8'),
        secretName: this.config.secretName
      };

    } catch (error: any) {
      if (error.statusCode === 404) {
        return null; // Secret doesn't exist yet
      }
      throw error;
    }
  }

  /**
   * Create new user credentials and store them in Kubernetes secrets
   */
  private async createUserCredentials(userId: string): Promise<UserCredentials> {
    // Generate database user and password
    const username = `user_${userId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const password = this.generateSecurePassword();

    try {
      // Create database user role
      await this.createDatabaseUser(userId, username, password);

      // Store credentials in Kubernetes secret
      await this.storeCredentialsInSecret(userId, username, password);

      console.log(`Created user credentials for user: ${userId}`);

      return {
        username,
        password,
        secretName: this.config.secretName
      };

    } catch (error) {
      // Clean up on failure
      try {
        await this.cleanupDatabaseUser(username);
      } catch (cleanupError) {
        console.error('Failed to cleanup database user after error:', cleanupError);
      }

      throw new OrchestratorError(
        ErrorCode.DATABASE_ERROR,
        `Failed to create user credentials for ${userId}`,
        error as Error,
        { userId, username }
      );
    }
  }

  /**
   * Create database user role with proper permissions
   */
  private async createDatabaseUser(userId: string, username: string, password: string): Promise<void> {
    try {
      await this.dbPool.query('SELECT create_user_role($1, $2)', [userId, password]);
      console.log(`Created database user role for: ${username}`);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DATABASE_ERROR,
        `Failed to create database user role for ${username}`,
        error as Error,
        { userId, username }
      );
    }
  }

  /**
   * Store user credentials in Kubernetes secret
   */
  private async storeCredentialsInSecret(userId: string, username: string, password: string): Promise<void> {
    const usernameKey = `${this.config.userSecretPrefix}${userId}`;
    const passwordKey = `${this.config.passwordSecretPrefix}${userId}`;

    try {
      // Try to patch existing secret first
      await this.patchSecret(userId, usernameKey, passwordKey, username, password);
    } catch (patchError: any) {
      if (patchError.statusCode === 404) {
        // Secret doesn't exist, create it
        await this.createSecret(userId, usernameKey, passwordKey, username, password);
      } else {
        throw patchError;
      }
    }
  }

  /**
   * Patch existing secret with new user credentials
   */
  private async patchSecret(
    userId: string,
    usernameKey: string,
    passwordKey: string,
    username: string,
    password: string
  ): Promise<void> {
    const patchData = {
      data: {
        [usernameKey]: Buffer.from(username).toString('base64'),
        [passwordKey]: Buffer.from(password).toString('base64')
      }
    };

    await this.k8sApi.coreV1Api.patchNamespacedSecret({
      name: this.config.secretName,
      namespace: this.config.namespace,
      body: patchData
    });

    console.log(`Updated secret with credentials for user: ${userId}`);
  }

  /**
   * Create new secret with user credentials
   */
  private async createSecret(
    userId: string,
    usernameKey: string,
    passwordKey: string,
    username: string,
    password: string
  ): Promise<void> {
    const secretData = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.config.secretName,
        namespace: this.config.namespace,
        labels: {
          'app.kubernetes.io/name': 'peerbot',
          'app.kubernetes.io/component': 'orchestrator',
          'app.kubernetes.io/managed-by': 'peerbot-orchestrator'
        }
      },
      type: 'Opaque',
      data: {
        [usernameKey]: Buffer.from(username).toString('base64'),
        [passwordKey]: Buffer.from(password).toString('base64')
      }
    };

    await this.k8sApi.coreV1Api.createNamespacedSecret({
      namespace: this.config.namespace,
      body: secretData
    });

    console.log(`Created secret with credentials for user: ${userId}`);
  }

  /**
   * Clean up database user role
   */
  private async cleanupDatabaseUser(username: string): Promise<void> {
    try {
      await this.dbPool.query('DROP ROLE IF EXISTS $1', [username]);
      console.log(`Cleaned up database user role: ${username}`);
    } catch (error) {
      console.error(`Failed to cleanup database user ${username}:`, error);
    }
  }

  /**
   * Rotate user credentials
   */
  async rotateUserCredentials(userId: string): Promise<UserCredentials> {
    console.log(`Rotating credentials for user: ${userId}`);

    try {
      // Get existing credentials
      const existing = await this.getExistingCredentials(userId);
      if (!existing) {
        throw new Error('No existing credentials found to rotate');
      }

      // Generate new password
      const newPassword = this.generateSecurePassword();

      // Update database user password
      await this.dbPool.query(
        'ALTER ROLE $1 WITH PASSWORD $2',
        [existing.username, newPassword]
      );

      // Update secret
      const usernameKey = `${this.config.userSecretPrefix}${userId}`;
      const passwordKey = `${this.config.passwordSecretPrefix}${userId}`;
      
      await this.patchSecret(userId, usernameKey, passwordKey, existing.username, newPassword);

      // Update cache
      const rotatedCredentials = {
        username: existing.username,
        password: newPassword,
        secretName: existing.secretName
      };
      
      this.credentialCache.set(userId, rotatedCredentials);

      console.log(`Successfully rotated credentials for user: ${userId}`);
      return rotatedCredentials;

    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DATABASE_ERROR,
        `Failed to rotate credentials for user ${userId}`,
        error as Error,
        { userId }
      );
    }
  }

  /**
   * Delete user credentials and database user
   */
  async deleteUserCredentials(userId: string): Promise<void> {
    console.log(`Deleting credentials for user: ${userId}`);

    try {
      const existing = await this.getExistingCredentials(userId);
      if (!existing) {
        console.log(`No credentials found for user ${userId}, skipping deletion`);
        return;
      }

      // Clean up database user
      await this.cleanupDatabaseUser(existing.username);

      // Remove from secret (patch to remove keys)
      const usernameKey = `${this.config.userSecretPrefix}${userId}`;
      const passwordKey = `${this.config.passwordSecretPrefix}${userId}`;

      // Get current secret and remove user-specific keys
      const secretResponse = await this.k8sApi.coreV1Api.readNamespacedSecret({
        name: this.config.secretName,
        namespace: this.config.namespace
      });

      const currentData = secretResponse.body.data || {};
      delete currentData[usernameKey];
      delete currentData[passwordKey];

      await this.k8sApi.coreV1Api.replaceNamespacedSecret({
        name: this.config.secretName,
        namespace: this.config.namespace,
        body: {
          ...secretResponse.body,
          data: currentData
        }
      });

      // Remove from cache
      this.credentialCache.delete(userId);

      console.log(`Successfully deleted credentials for user: ${userId}`);

    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.KUBERNETES_ERROR,
        `Failed to delete credentials for user ${userId}`,
        error as Error,
        { userId }
      );
    }
  }

  /**
   * Generate secure password
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
   * Get secret management statistics
   */
  getStats() {
    return {
      cachedCredentials: this.credentialCache.size,
      config: {
        secretName: this.config.secretName,
        namespace: this.config.namespace,
        externalSecretOperator: this.config.externalSecretOperator
      }
    };
  }

  /**
   * Clear credential cache
   */
  clearCache(): void {
    this.credentialCache.clear();
    console.log('Secret manager cache cleared');
  }
}