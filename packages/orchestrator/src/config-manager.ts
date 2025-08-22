#!/usr/bin/env bun

import { OrchestratorError, ErrorCode, type OrchestratorConfig } from './types';

/**
 * Configuration validation and management
 * Provides centralized config validation, defaults, and environment variable handling
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private config: OrchestratorConfig;
  private validationErrors: string[] = [];

  private constructor() {
    this.config = this.loadConfiguration();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Load and validate configuration from environment variables
   */
  private loadConfiguration(): OrchestratorConfig {
    this.validationErrors = [];

    const config: OrchestratorConfig = {
      database: {
        host: this.getRequiredEnv('DATABASE_HOST'),
        port: this.getEnvAsNumber('DATABASE_PORT', 5432),
        database: this.getRequiredEnv('DATABASE_NAME'),
        username: this.getRequiredEnv('DATABASE_USER'),
        password: this.getRequiredEnv('DATABASE_PASSWORD'),
        ssl: this.getEnvAsBoolean('DATABASE_SSL', false),
      },
      kubernetes: {
        namespace: this.getEnvWithDefault('KUBERNETES_NAMESPACE', 'peerbot'),
        cpu: this.getEnvWithDefault('WORKER_CPU', '1000m'),
        memory: this.getEnvWithDefault('WORKER_MEMORY', '2Gi'),
        image: this.getRequiredEnv('WORKER_IMAGE'),
        pullPolicy: this.getEnvWithDefault('IMAGE_PULL_POLICY', 'IfNotPresent') as 'Always' | 'IfNotPresent' | 'Never',
        nodeSelector: this.parseEnvAsObject('NODE_SELECTOR', {}),
        tolerations: this.parseEnvAsArray('TOLERATIONS', []),
        affinity: this.parseEnvAsObject('AFFINITY', {}),
      },
      queues: {
        directMessage: this.getEnvWithDefault('DIRECT_MESSAGE_QUEUE', 'direct_message'),
        messageQueue: this.getEnvWithDefault('MESSAGE_QUEUE', 'messageQueue'),
        concurrency: this.getEnvAsNumber('QUEUE_CONCURRENCY', 10),
        retryLimit: this.getEnvAsNumber('QUEUE_RETRY_LIMIT', 3),
        retryDelay: this.getEnvAsNumber('QUEUE_RETRY_DELAY', 30000),
        archiveCompletedAfterSeconds: this.getEnvAsNumber('QUEUE_ARCHIVE_AFTER', 3600),
      },
      server: {
        port: this.getEnvAsNumber('PORT', 3000),
        host: this.getEnvWithDefault('HOST', '0.0.0.0'),
        logLevel: this.getEnvWithDefault('LOG_LEVEL', 'info') as 'error' | 'warn' | 'info' | 'debug',
        healthCheckPath: this.getEnvWithDefault('HEALTH_CHECK_PATH', '/health'),
        metricsPath: this.getEnvWithDefault('METRICS_PATH', '/metrics'),
      },
      monitoring: {
        enabled: this.getEnvAsBoolean('MONITORING_ENABLED', true),
        namespace: this.getEnvWithDefault('KUBERNETES_NAMESPACE', 'peerbot'),
        maxRetries: this.getEnvAsNumber('MONITORING_MAX_RETRIES', 5),
        initialRetryDelay: this.getEnvAsNumber('MONITORING_INITIAL_RETRY_DELAY', 1000),
        maxRetryDelay: this.getEnvAsNumber('MONITORING_MAX_RETRY_DELAY', 30000),
        retryBackoffMultiplier: this.getEnvAsNumber('MONITORING_RETRY_BACKOFF_MULTIPLIER', 2),
      },
      recovery: {
        enabled: this.getEnvAsBoolean('RECOVERY_ENABLED', true),
        namespace: this.getEnvWithDefault('KUBERNETES_NAMESPACE', 'peerbot'),
        labelSelectors: {
          app: 'peerbot-worker',
          component: 'worker',
          ...this.parseEnvAsObject('RECOVERY_LABEL_SELECTORS', {})
        },
        maxAge: this.getEnvAsNumber('RECOVERY_MAX_AGE_MINUTES', 60),
        recoveryInterval: this.getEnvAsNumber('RECOVERY_INTERVAL_MS', 300000), // 5 minutes
      },
      secrets: {
        secretName: this.getEnvWithDefault('SECRET_NAME', 'peerbot-secrets'),
        userSecretPrefix: this.getEnvWithDefault('USER_SECRET_PREFIX', 'db-user-'),
        passwordSecretPrefix: this.getEnvWithDefault('PASSWORD_SECRET_PREFIX', 'db-password-'),
        externalSecretOperator: this.getEnvAsBoolean('EXTERNAL_SECRET_OPERATOR', false),
        externalSecretStore: this.getEnvWithDefault('EXTERNAL_SECRET_STORE', ''),
      },
    };

    // Validate the configuration
    this.validateConfiguration(config);

    if (this.validationErrors.length > 0) {
      const errorMessage = `Configuration validation failed:\n${this.validationErrors.join('\n')}`;
      throw new OrchestratorError(
        ErrorCode.CONFIGURATION_ERROR,
        errorMessage,
        new Error('Invalid configuration'),
        { errors: this.validationErrors }
      );
    }

    return config;
  }

  /**
   * Get required environment variable
   */
  private getRequiredEnv(key: string): string {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      this.validationErrors.push(`Required environment variable ${key} is not set`);
      return '';
    }
    return value.trim();
  }

  /**
   * Get environment variable with default value
   */
  private getEnvWithDefault(key: string, defaultValue: string): string {
    const value = process.env[key];
    return value && value.trim() !== '' ? value.trim() : defaultValue;
  }

  /**
   * Get environment variable as number
   */
  private getEnvAsNumber(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      return defaultValue;
    }

    const parsed = parseInt(value.trim(), 10);
    if (isNaN(parsed)) {
      this.validationErrors.push(`Environment variable ${key} must be a valid number, got: ${value}`);
      return defaultValue;
    }

    return parsed;
  }

  /**
   * Get environment variable as boolean
   */
  private getEnvAsBoolean(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      return defaultValue;
    }

    const lowercaseValue = value.trim().toLowerCase();
    if (lowercaseValue === 'true' || lowercaseValue === '1' || lowercaseValue === 'yes') {
      return true;
    }
    if (lowercaseValue === 'false' || lowercaseValue === '0' || lowercaseValue === 'no') {
      return false;
    }

    this.validationErrors.push(`Environment variable ${key} must be a boolean (true/false), got: ${value}`);
    return defaultValue;
  }

  /**
   * Parse environment variable as JSON object
   */
  private parseEnvAsObject(key: string, defaultValue: any): any {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      return defaultValue;
    }

    try {
      return JSON.parse(value.trim());
    } catch (error) {
      this.validationErrors.push(`Environment variable ${key} must be valid JSON, got: ${value}`);
      return defaultValue;
    }
  }

  /**
   * Parse environment variable as JSON array
   */
  private parseEnvAsArray(key: string, defaultValue: any[]): any[] {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      return defaultValue;
    }

    try {
      const parsed = JSON.parse(value.trim());
      if (!Array.isArray(parsed)) {
        this.validationErrors.push(`Environment variable ${key} must be a JSON array, got: ${value}`);
        return defaultValue;
      }
      return parsed;
    } catch (error) {
      this.validationErrors.push(`Environment variable ${key} must be valid JSON array, got: ${value}`);
      return defaultValue;
    }
  }

  /**
   * Validate the complete configuration
   */
  private validateConfiguration(config: OrchestratorConfig): void {
    // Database validation
    if (config.database.port < 1 || config.database.port > 65535) {
      this.validationErrors.push(`Database port must be between 1 and 65535, got: ${config.database.port}`);
    }

    // Queue validation
    if (config.queues.concurrency < 1) {
      this.validationErrors.push(`Queue concurrency must be at least 1, got: ${config.queues.concurrency}`);
    }

    if (config.queues.retryLimit < 0) {
      this.validationErrors.push(`Queue retry limit must be non-negative, got: ${config.queues.retryLimit}`);
    }

    if (config.queues.retryDelay < 1000) {
      this.validationErrors.push(`Queue retry delay must be at least 1000ms, got: ${config.queues.retryDelay}`);
    }

    // Server validation
    if (config.server.port < 1 || config.server.port > 65535) {
      this.validationErrors.push(`Server port must be between 1 and 65535, got: ${config.server.port}`);
    }

    const validLogLevels = ['error', 'warn', 'info', 'debug'];
    if (!validLogLevels.includes(config.server.logLevel)) {
      this.validationErrors.push(`Log level must be one of: ${validLogLevels.join(', ')}, got: ${config.server.logLevel}`);
    }

    // Monitoring validation
    if (config.monitoring.maxRetries < 1) {
      this.validationErrors.push(`Monitoring max retries must be at least 1, got: ${config.monitoring.maxRetries}`);
    }

    if (config.monitoring.initialRetryDelay < 100) {
      this.validationErrors.push(`Monitoring initial retry delay must be at least 100ms, got: ${config.monitoring.initialRetryDelay}`);
    }

    // Recovery validation
    if (config.recovery.maxAge < 5) {
      this.validationErrors.push(`Recovery max age must be at least 5 minutes, got: ${config.recovery.maxAge}`);
    }

    if (config.recovery.recoveryInterval < 60000) {
      this.validationErrors.push(`Recovery interval must be at least 60000ms (1 minute), got: ${config.recovery.recoveryInterval}`);
    }

    // Kubernetes validation
    const validPullPolicies = ['Always', 'IfNotPresent', 'Never'];
    if (!validPullPolicies.includes(config.kubernetes.pullPolicy)) {
      this.validationErrors.push(`Image pull policy must be one of: ${validPullPolicies.join(', ')}, got: ${config.kubernetes.pullPolicy}`);
    }
  }

  /**
   * Get the validated configuration
   */
  getConfig(): OrchestratorConfig {
    return this.config;
  }

  /**
   * Get configuration section
   */
  getDatabaseConfig() {
    return this.config.database;
  }

  getKubernetesConfig() {
    return this.config.kubernetes;
  }

  getQueuesConfig() {
    return this.config.queues;
  }

  getServerConfig() {
    return this.config.server;
  }

  getMonitoringConfig() {
    return this.config.monitoring;
  }

  getRecoveryConfig() {
    return this.config.recovery;
  }

  getSecretsConfig() {
    return this.config.secrets;
  }

  /**
   * Validate environment readiness
   */
  validateEnvironment(): string[] {
    const issues: string[] = [];

    // Check if all required services are accessible
    try {
      // This would be expanded with actual connectivity checks
      // For now, just check if critical env vars are set
      
      const criticalEnvVars = [
        'DATABASE_HOST',
        'DATABASE_NAME', 
        'DATABASE_USER',
        'DATABASE_PASSWORD',
        'WORKER_IMAGE'
      ];

      for (const envVar of criticalEnvVars) {
        if (!process.env[envVar]) {
          issues.push(`Critical environment variable ${envVar} is not set`);
        }
      }

    } catch (error) {
      issues.push(`Environment validation error: ${error}`);
    }

    return issues;
  }

  /**
   * Get configuration summary for logging/debugging
   */
  getConfigSummary() {
    return {
      database: {
        host: this.config.database.host,
        port: this.config.database.port,
        database: this.config.database.database,
        ssl: this.config.database.ssl,
      },
      kubernetes: {
        namespace: this.config.kubernetes.namespace,
        image: this.config.kubernetes.image,
        cpu: this.config.kubernetes.cpu,
        memory: this.config.kubernetes.memory,
      },
      queues: {
        directMessage: this.config.queues.directMessage,
        messageQueue: this.config.queues.messageQueue,
        concurrency: this.config.queues.concurrency,
      },
      server: {
        port: this.config.server.port,
        host: this.config.server.host,
        logLevel: this.config.server.logLevel,
      },
      features: {
        monitoring: this.config.monitoring.enabled,
        recovery: this.config.recovery.enabled,
        externalSecrets: this.config.secrets.externalSecretOperator,
      }
    };
  }
}