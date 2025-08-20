import * as k8s from "@kubernetes/client-node";
import { Operator } from "k8s-operator-node";
import winston from "winston";
import { ClaudeSession } from "./types/claude-session";
import { ClaudeSessionController } from "./controllers/claude-session-controller";
import { claudeSessionCRD } from "./crds/claude-session-crd";

class ClaudeOperator {
  private logger: winston.Logger;
  private kc: k8s.KubeConfig;
  private operator: Operator;
  private controller: ClaudeSessionController;
  private k8sApi: k8s.BatchV1Api;
  private k8sCoreApi: k8s.CoreV1Api;
  private customObjectsApi: k8s.CustomObjectsApi;
  private apiExtensionsApi: k8s.ApiextensionsV1Api;
  private namespace: string;
  private workerImage: string;

  constructor() {
    // Initialize logger
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console()
      ]
    });

    // Configuration from environment
    this.namespace = process.env.NAMESPACE || "peerbot";
    this.workerImage = process.env.WORKER_IMAGE || "claude-worker:latest";

    // Initialize Kubernetes config
    this.kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      this.kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      this.kc.loadFromCluster();
    }

    // Initialize Kubernetes API clients
    this.k8sApi = this.kc.makeApiClient(k8s.BatchV1Api);
    this.k8sCoreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    this.apiExtensionsApi = this.kc.makeApiClient(k8s.ApiextensionsV1Api);

    // Initialize controller
    this.controller = new ClaudeSessionController(
      this.k8sCoreApi,
      this.customObjectsApi,
      this.logger,
      this.namespace,
      this.workerImage
    );

    // Initialize operator
    this.operator = new Operator(this.kc, this.logger);
  }

  async start(): Promise<void> {
    this.logger.info("Starting Claude Operator...");

    try {
      // Ensure CRD is installed
      await this.ensureCRD();

      // Watch ClaudeSession resources
      await this.operator.watchResource(
        "claude.ai",
        "v1",
        "claudesessions",
        async (e) => {
          try {
            const resource = e.object as ClaudeSession;
            
            // Handle different event types
            switch (e.type) {
              case "ADDED":
              case "MODIFIED":
                await this.controller.reconcile(resource);
                break;
              case "DELETED":
                this.logger.info(`ClaudeSession ${resource.metadata?.name} deleted`);
                break;
            }
          } catch (error) {
            this.logger.error("Error handling watch event:", error);
          }
        },
        (error) => {
          this.logger.error("Watch error:", error);
        }
      );

      this.logger.info("✅ Claude Operator started successfully");

      // Handle graceful shutdown
      const shutdown = async (signal: string) => {
        this.logger.info(`Received ${signal}, shutting down gracefully...`);
        try {
          await this.operator.stop();
          this.logger.info("Operator stopped");
          process.exit(0);
        } catch (error) {
          this.logger.error("Error during shutdown:", error);
          process.exit(1);
        }
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));

    } catch (error) {
      this.logger.error("Failed to start operator:", error);
      process.exit(1);
    }
  }

  /**
   * Ensure ClaudeSession CRD is installed in the cluster
   */
  private async ensureCRD(): Promise<void> {
    try {
      // Check if CRD already exists
      try {
        await this.apiExtensionsApi.readCustomResourceDefinition({
          name: claudeSessionCRD.metadata!.name!
        });
        this.logger.info("ClaudeSession CRD already exists");
        return;
      } catch (error) {
        // CRD doesn't exist, create it
        if ((error as any)?.response?.statusCode === 404) {
          this.logger.info("Creating ClaudeSession CRD...");
          await this.apiExtensionsApi.createCustomResourceDefinition({
            body: claudeSessionCRD
          });
          this.logger.info("✅ ClaudeSession CRD created");
          
          // Wait a bit for the CRD to be established
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          throw error;
        }
      }
    } catch (error) {
      this.logger.error("Failed to ensure CRD:", error);
      throw error;
    }
  }
}

// Start the operator if this file is executed directly
if (require.main === module) {
  const operator = new ClaudeOperator();
  operator.start().catch((error) => {
    console.error("Failed to start operator:", error);
    process.exit(1);
  });
}

export { ClaudeOperator };