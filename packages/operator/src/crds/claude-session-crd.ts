import { V1CustomResourceDefinition } from "@kubernetes/client-node";

export const claudeSessionCRD: V1CustomResourceDefinition = {
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: {
    name: "claudesessions.claude.ai",
    labels: {
      app: "claude-operator",
      "app.kubernetes.io/name": "claude-operator",
      "app.kubernetes.io/component": "crd"
    }
  },
  spec: {
    group: "claude.ai",
    versions: [
      {
        name: "v1",
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: "object",
            properties: {
              spec: {
                type: "object",
                required: [
                  "sessionKey",
                  "userId",
                  "username", 
                  "channelId",
                  "repositoryUrl",
                  "userPrompt",
                  "slackResponseChannel",
                  "slackResponseTs"
                ],
                properties: {
                  sessionKey: {
                    type: "string",
                    description: "Unique identifier for the session"
                  },
                  userId: {
                    type: "string",
                    description: "Slack user ID who initiated the session"
                  },
                  username: {
                    type: "string",
                    description: "GitHub username for repository access"
                  },
                  channelId: {
                    type: "string",
                    description: "Slack channel ID where the request originated"
                  },
                  threadTs: {
                    type: "string",
                    description: "Slack thread timestamp for conversation continuity"
                  },
                  repositoryUrl: {
                    type: "string",
                    description: "GitHub repository URL to work on"
                  },
                  userPrompt: {
                    type: "string",
                    description: "Base64 encoded user prompt for Claude"
                  },
                  slackResponseChannel: {
                    type: "string",
                    description: "Slack channel to send responses to"
                  },
                  slackResponseTs: {
                    type: "string", 
                    description: "Slack message timestamp for response updates"
                  },
                  originalMessageTs: {
                    type: "string",
                    description: "Original Slack message timestamp"
                  },
                  claudeOptions: {
                    type: "string",
                    description: "JSON string of Claude configuration options"
                  },
                  resumeSessionId: {
                    type: "string",
                    description: "Claude session ID to resume from"
                  },
                  resources: {
                    type: "object",
                    properties: {
                      cpu: {
                        type: "string",
                        default: "500m"
                      },
                      memory: {
                        type: "string", 
                        default: "1Gi"
                      }
                    }
                  },
                  timeoutSeconds: {
                    type: "integer",
                    default: 300,
                    minimum: 60,
                    maximum: 3600
                  }
                }
              },
              status: {
                type: "object",
                properties: {
                  phase: {
                    type: "string",
                    enum: ["Pending", "Running", "Succeeded", "Failed", "Terminated"]
                  },
                  jobName: {
                    type: "string"
                  },
                  startTime: {
                    type: "string",
                    format: "date-time"
                  },
                  completionTime: {
                    type: "string",
                    format: "date-time"
                  },
                  message: {
                    type: "string"
                  },
                  conditions: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["type", "status", "lastTransitionTime"],
                      properties: {
                        type: {
                          type: "string"
                        },
                        status: {
                          type: "string",
                          enum: ["True", "False", "Unknown"]
                        },
                        lastTransitionTime: {
                          type: "string",
                          format: "date-time"
                        },
                        reason: {
                          type: "string"
                        },
                        message: {
                          type: "string"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        subresources: {
          status: {}
        },
        additionalPrinterColumns: [
          {
            name: "Phase",
            type: "string",
            jsonPath: ".status.phase"
          },
          {
            name: "Job",
            type: "string", 
            jsonPath: ".status.jobName"
          },
          {
            name: "User",
            type: "string",
            jsonPath: ".spec.userId"
          },
          {
            name: "Age",
            type: "date",
            jsonPath: ".metadata.creationTimestamp"
          }
        ]
      }
    ],
    scope: "Namespaced",
    names: {
      plural: "claudesessions",
      singular: "claudesession",
      kind: "ClaudeSession",
      shortNames: ["cs", "session"]
    }
  }
};