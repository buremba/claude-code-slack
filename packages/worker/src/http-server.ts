#!/usr/bin/env bun

import logger from "./logger";
import type { TaskRequest } from "./types";

export class WorkerHttpServer {
  private server: any = null;
  private port: number;
  private isShuttingDown = false;

  constructor(port: number = 8080) {
    this.port = port;
  }

  /**
   * Start the HTTP server
   */
  async start(
    onTaskReceived: (task: TaskRequest) => Promise<void>
  ): Promise<void> {
    try {
      this.server = Bun.serve({
        port: this.port,
        fetch: async (req) => {
          const url = new URL(req.url);
          
          // Log all requests
          logger.info(`HTTP ${req.method} ${url.pathname}`);

          try {
            // Health check endpoint
            if (url.pathname === '/health' && req.method === 'GET') {
              return new Response(JSON.stringify({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                shutting_down: this.isShuttingDown
              }), {
                headers: { 'Content-Type': 'application/json' }
              });
            }

            // Task endpoint
            if (url.pathname === '/task' && req.method === 'POST') {
              if (this.isShuttingDown) {
                return new Response(JSON.stringify({
                  error: 'Worker is shutting down'
                }), {
                  status: 503,
                  headers: { 'Content-Type': 'application/json' }
                });
              }

              const body = await req.json() as TaskRequest;
              
              // Validate request
              if (!body.userRequest || !body.sessionKey) {
                return new Response(JSON.stringify({
                  error: 'Missing required fields: userRequest, sessionKey'
                }), {
                  status: 400,
                  headers: { 'Content-Type': 'application/json' }
                });
              }

              // Process task asynchronously
              onTaskReceived(body).catch(error => {
                logger.error('Error processing task:', error);
              });

              return new Response(JSON.stringify({
                success: true,
                message: 'Task received and queued for processing'
              }), {
                headers: { 'Content-Type': 'application/json' }
              });
            }

            // Not found
            return new Response(JSON.stringify({
              error: 'Not found'
            }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' }
            });

          } catch (error) {
            logger.error('HTTP request error:', error);
            return new Response(JSON.stringify({
              error: 'Internal server error'
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }
      });

      logger.info(`HTTP server started on port ${this.port}`);
    } catch (error) {
      logger.error(`Failed to start HTTP server on port ${this.port}:`, error);
      throw error;
    }
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    try {
      this.isShuttingDown = true;
      
      if (this.server) {
        this.server.stop();
        this.server = null;
        logger.info('HTTP server stopped');
      }
    } catch (error) {
      logger.error('Error stopping HTTP server:', error);
    }
  }
}