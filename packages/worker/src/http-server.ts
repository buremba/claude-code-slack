#!/usr/bin/env bun

import logger from "./logger";
import type { TaskRequest, TaskResponse, WorkerState } from "./types";

export class WorkerHttpServer {
  private server: any;
  private port: number;
  private onTaskReceived?: (taskData: TaskRequest) => Promise<TaskResponse>;
  private getWorkerState?: () => WorkerState;

  constructor(
    port: number,
    onTaskReceived?: (taskData: TaskRequest) => Promise<TaskResponse>,
    getWorkerState?: () => WorkerState
  ) {
    this.port = port;
    this.onTaskReceived = onTaskReceived;
    this.getWorkerState = getWorkerState;
  }

  async start(): Promise<void> {
    try {
      // Using Bun's built-in server
      this.server = Bun.serve({
        port: this.port,
        fetch: this.handleRequest.bind(this),
      });

      logger.info(`Worker HTTP server started on port ${this.port}`);
    } catch (error) {
      logger.error("Failed to start HTTP server:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      logger.info("Worker HTTP server stopped");
    }
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Add CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
      // Health check endpoint
      if (pathname === "/health" && request.method === "GET") {
        const state = this.getWorkerState ? this.getWorkerState() : "unknown";
        const healthData = {
          status: "healthy",
          workerState: state,
          timestamp: new Date().toISOString(),
        };

        return new Response(JSON.stringify(healthData), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        });
      }

      // Task submission endpoint
      if (pathname === "/task" && request.method === "POST") {
        if (!this.onTaskReceived) {
          return new Response(
            JSON.stringify({
              success: false,
              message: "Task handler not configured",
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }

        const contentType = request.headers.get("Content-Type");
        if (!contentType || !contentType.includes("application/json")) {
          return new Response(
            JSON.stringify({
              success: false,
              message: "Content-Type must be application/json",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }

        let taskData: TaskRequest;
        try {
          taskData = await request.json();
        } catch (error) {
          return new Response(
            JSON.stringify({
              success: false,
              message: "Invalid JSON in request body",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }

        // Validate required fields
        if (!taskData.sessionKey || !taskData.userId || !taskData.userPrompt) {
          return new Response(
            JSON.stringify({
              success: false,
              message: "Missing required fields: sessionKey, userId, userPrompt",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }

        logger.info(`Received task request for session: ${taskData.sessionKey}`);

        try {
          const response = await this.onTaskReceived(taskData);
          return new Response(JSON.stringify(response), {
            status: response.success ? 200 : 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          });
        } catch (error) {
          logger.error("Error processing task request:", error);
          return new Response(
            JSON.stringify({
              success: false,
              message: "Internal server error while processing task",
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }
      }

      // Not found
      return new Response(
        JSON.stringify({
          success: false,
          message: "Endpoint not found",
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    } catch (error) {
      logger.error("Error handling HTTP request:", error);
      return new Response(
        JSON.stringify({
          success: false,
          message: "Internal server error",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }
  }
}