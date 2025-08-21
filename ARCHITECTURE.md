# Architecture Documentation

## Executive Summary

The Claude Code Slack integration is a cloud-native architecture that brings AI-powered programming assistance directly to Slack workspaces. 
Built on Kubernetes with a dispatcher-worker pattern, the system creates isolated, ephemeral environments for each coding session while maintaining persistent conversation history and user workspaces.

**Key Innovation**: Each Slack thread becomes a persistent AI coding session with dedicated compute resources, user-specific GitHub repositories, and conversation continuity across interactions.

## System Architecture Overview

```mermaid
graph TB
    subgraph "Slack Platform"
        USER[Slack User]
        THREAD[Thread Message]
    end
    
    subgraph "Kubernetes Cluster"
        subgraph "Long-lived Services"
            DISPATCHER[Dispatcher Pod<br/>Slack Event Handler]
        end
        
        subgraph "Ephemeral Workloads"
            WORKER1[Worker Pod 1<br/>Session A]
            WORKER2[Worker Pod 2<br/>Session B]
            WORKERN[Worker Pod N<br/>Session N]
        end
    end
    
    subgraph "External Services"
        SLACK_API[Slack API]
        GITHUB[GitHub API]
        CLAUDE[Claude API]
        GCS[Google Cloud Storage]
    end
    
    USER -->|@peerbotai message| SLACK_API
    SLACK_API -->|Event Webhook| DISPATCHER
    DISPATCHER -->|Create Job| WORKER1
    DISPATCHER -->|Create Job| WORKER2
    WORKER1 -->|Stream Updates| SLACK_API
    WORKER1 -->|Repository Access| GITHUB
    WORKER1 -->|AI Requests| CLAUDE
    WORKER1 -->|Store History| GCS
    
    classDef ephemeral fill:#f9d71c,stroke:#333,stroke-width:2px
    classDef persistent fill:#27ae60,stroke:#333,stroke-width:2px
    classDef external fill:#3498db,stroke:#333,stroke-width:2px
    
    class WORKER1,WORKER2,WORKERN ephemeral
    class DISPATCHER persistent
    class SLACK_API,GITHUB,CLAUDE,GCS external
```

## Core Components

### 1. Dispatcher (packages/dispatcher/)

The **Dispatcher** is a long-lived Kubernetes deployment that acts as the central event processor and orchestrator.

**Responsibilities:**
- **Slack Event Processing**: Receives and validates Slack app_mention events
- **Rate Limiting**: Enforces per-user limits (5 jobs per 15-minute window by default)
- **Job Management**: Creates, monitors, and cleans up Kubernetes worker jobs
- **Session Routing**: Determines if a thread has an existing session or needs a new one
- **Repository Management**: Ensures user repositories exist and are accessible

**Key Files:**
- `packages/dispatcher/src/kubernetes/job-manager.ts` - Kubernetes job orchestration
- `packages/dispatcher/src/slack/event-handler.ts` - Slack event processing

### 2. Worker (packages/worker/)

**Workers** are ephemeral Kubernetes jobs that execute individual coding sessions with dedicated resources.

**Responsibilities:**
- **Workspace Setup**: Clones user repository and creates session branch
- **Claude Integration**: Executes AI-powered coding sessions with context
- **Real-time Communication**: Streams progress updates back to Slack
- **Git Operations**: Commits changes and pushes to session branches
- **Resource Management**: Self-terminates after session completion (5-minute timeout)

**Key Files:**
- `packages/worker/src/index.ts` - Main worker execution logic
- `packages/worker/src/workspace-setup.ts` - Git repository management

### 3. Core Runner (packages/core-runner/)

The **Core Runner** provides the Claude Code CLI integration and session management.

**Responsibilities:**
- **Claude API Integration**: Manages Claude Code CLI sessions
- **Conversation History**: Handles message persistence and context
- **Progress Streaming**: Provides real-time execution updates
- **Tool Access**: Enables file operations, code execution, and web access

**Key Files:**
- `packages/core-runner/src/session-manager.ts` - Session lifecycle management

## Data Flow and Message Processing

```mermaid
sequenceDiagram
    participant User as Slack User
    participant Slack as Slack API
    participant Dispatcher as Dispatcher Pod
    participant K8s as Kubernetes API
    participant Worker as Worker Pod
    participant Claude as Claude API
    participant GitHub as GitHub API
    participant GCS as Google Cloud Storage

    User->>Slack: @peerbotai create a React component
    Slack->>Dispatcher: app_mention event
    Dispatcher->>Dispatcher: Check rate limits & permissions
    Dispatcher->>GCS: Fetch conversation history
    Dispatcher->>GitHub: Ensure user repository exists
    Dispatcher->>K8s: Create worker job with session context
    K8s->>Worker: Start ephemeral pod
    Dispatcher->>Slack: Post initial response with job details
    
    Worker->>GitHub: Clone user repository
    Worker->>Worker: Setup workspace & create session branch
    Worker->>Claude: Execute session with conversation history
    Claude-->>Worker: Stream progress updates
    Worker->>Slack: Stream progress to thread
    Claude->>Worker: Final response with code changes
    Worker->>GitHub: Commit & push changes to branch
    Worker->>Slack: Post final response with PR links
    Worker->>GCS: Save conversation state
    Worker->>Worker: Cleanup and terminate
    K8s->>K8s: Remove completed job
```

### Message Processing Steps

1. **Event Reception**: Slack sends app_mention event to dispatcher webhook
2. **Validation & Rate Limiting**: Dispatcher validates user permissions and rate limits
3. **Session Resolution**: Check if thread has existing active job or needs new session
4. **Job Creation**: Create Kubernetes job with session context and conversation history
5. **Workspace Preparation**: Worker clones repository and sets up isolated environment
6. **Claude Execution**: Execute AI session with full context and streaming updates
7. **Code Management**: Commit changes to session branch and push to GitHub
8. **Cleanup**: Save conversation state and terminate worker resources

## Thread-Based Session Management

### Session Lifecycle

Each Slack thread represents a persistent conversation context that spans multiple interactions:

```mermaid
stateDiagram-v2
    [*] --> NewThread: User mentions bot
    NewThread --> ActiveSession: Create worker job
    ActiveSession --> StreamingUpdates: Claude processing
    StreamingUpdates --> Completed: Session finished
    Completed --> [*]: Worker terminated
    
    Completed --> ActiveSession: User replies in thread
    ActiveSession --> ResumedSession: Load conversation history
    ResumedSession --> StreamingUpdates: Continue with context
```

### Conversation Persistence

**Storage Strategy**: 
- **Google Cloud Storage**: Conversation history stored by thread ID
- **Stateless Workers**: Each worker loads complete conversation context
- **Slack as Truth**: Slack thread serves as primary conversation interface

**Session Keys**: Generated format `{channel}-{timestamp}-{random}` for unique identification

## Workspace and Repository Management

### User Isolation Model

Every user receives a dedicated GitHub repository following the pattern:
- **Repository**: `{organization}/user-{username}`
- **Branch Strategy**: Session branches `claude/session-{session-key}`
- **Workspace Directory**: `/workspace/{username}` in worker containers

### Git Operations Flow

```mermaid
flowchart TD
    START[Worker Starts] --> CLONE[Clone User Repository]
    CLONE --> BRANCH[Create Session Branch]
    BRANCH --> SETUP[Setup Git Config]
    SETUP --> READY[Workspace Ready]
    READY --> CHANGES[Claude Makes Changes]
    CHANGES --> COMMIT[Auto-commit Changes]
    COMMIT --> PUSH[Push to Remote Branch]
    PUSH --> PR[Enable PR Creation]
    PR --> CLEANUP[Worker Cleanup]
```

**Repository Structure:**
```
user-{username}/
├── projects/           # User projects
├── scripts/           # Utility scripts
├── workspace/         # Session work areas
└── .gitignore        # Auto-generated
```

## Kubernetes Integration

### Pod Architecture

**Dispatcher Pod:**
- **Type**: Kubernetes Deployment (replica: 1)
- **Resources**: 500m CPU, 1Gi memory
- **Persistence**: Stateless (uses K8s API as state store)
- **Networking**: Receives Slack webhooks, creates worker jobs

**Worker Pods:**
- **Type**: Kubernetes Jobs (ephemeral)
- **Resources**: 2 CPU cores, 4Gi memory (configurable)
- **Timeout**: 5 minutes (300 seconds)
- **Storage**: 10Gi emptyDir volume for workspace
- **Isolation**: Each pod runs in isolation with dedicated resources

### Resource Management

**Scaling Strategy:**
```yaml
# From charts/peerbot/values.yaml
dispatcher:
  replicas: 1
  resources:
    requests:
      cpu: 500m
      memory: 1Gi

worker:
  resources:
    requests:
      cpu: 2000m
      memory: 4Gi
    limits:
      cpu: 2000m
      memory: 4Gi
```

**Node Affinity:**
- **Spot Instances**: Preferred for cost optimization
- **Tolerations**: Configured for GKE spot nodes
- **Auto-scaling**: Kubernetes handles pod placement and scaling

## Current Implementation: Kubernetes Job Manager

### Job Creation Process

The `KubernetesJobManager` class orchestrates worker lifecycle:

```typescript
// From packages/dispatcher/src/kubernetes/job-manager.ts
async createWorkerJob(request: WorkerJobRequest): Promise<string> {
  // 1. Rate limiting check
  if (!this.checkRateLimit(request.userId)) {
    throw new KubernetesError("Rate limit exceeded");
  }

  // 2. Check for existing job
  const existingJob = await this.findExistingJobForSession(request.sessionKey);
  
  // 3. Create job manifest
  const jobManifest = this.createJobManifest(jobName, request);
  
  // 4. Deploy to Kubernetes
  await this.k8sApi.createNamespacedJob({ /* ... */ });
  
  // 5. Start monitoring
  this.monitorJob(jobName, request.sessionKey);
}
```

### Job Manifest Structure

Worker jobs are deployed with comprehensive environment configuration:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: claude-worker-{hash}-{timestamp}
  annotations:
    claude.ai/session-key: "{sessionKey}"
    claude.ai/user-id: "{userId}"
spec:
  activeDeadlineSeconds: 300  # 5 minute timeout
  template:
    spec:
      containers:
      - name: claude-worker
        image: claude-worker:latest
        resources:
          requests: { cpu: 2000m, memory: 4Gi }
          limits: { cpu: 2000m, memory: 4Gi }
        env:
        - name: SESSION_KEY
          value: "{sessionKey}"
        - name: CONVERSATION_HISTORY
          value: "{base64EncodedHistory}"
        # ... additional environment variables
        volumeMounts:
        - name: workspace
          mountPath: /workspace
      volumes:
      - name: workspace
        emptyDir: { sizeLimit: 10Gi }
```

## Future Architecture

### Docker-in-Docker Support

**Planned Enhancement**: Support Docker-in-Docker execution for enhanced development environments.

```mermaid
graph LR
    subgraph "Future Architecture"
        DISPATCHER[Dispatcher]
        DIND[Docker-in-Docker Worker]
        K8S_WORKER[Kubernetes Worker]
    end
    
    DISPATCHER -->|Container Strategy| DIND
    DISPATCHER -->|Pod Strategy| K8S_WORKER
    
    DIND -->|Full Docker Access| DEV_TOOLS[Development Tools]
    K8S_WORKER -->|Isolated Environment| CLAUDE_CLI[Claude CLI]
```

**Benefits:**
- **Enhanced Development**: Full Docker daemon access for complex builds
- **Tool Compatibility**: Support for tools requiring Docker
- **Flexible Deployment**: Choice between K8s pods and Docker containers

### Anthropic Proxy and Smart Routing

**Vision**: Integrate with Anthropic proxy for intelligent model routing and resource optimization.

```mermaid
flowchart TD
    USER[User Request] --> DISPATCHER[Dispatcher]
    DISPATCHER --> PROXY[Anthropic Proxy]
    PROXY --> ROUTING{Smart Routing}
    ROUTING -->|GPU Tasks| GPU_VENDOR[Vanda GPU]
    ROUTING -->|Standard Tasks| STANDARD[Standard Claude]
    ROUTING -->|Code Tasks| SPECIALIZED[Code-Specialized Model]
    
    GPU_VENDOR --> WORKER[Worker Pod]
    STANDARD --> WORKER
    SPECIALIZED --> WORKER
```

**Capabilities:**
- **GPU Acceleration**: Route compute-intensive tasks to GPU vendors
- **Model Selection**: Automatically choose optimal Claude model variant
- **Cost Optimization**: Balance performance and cost based on task complexity
- **Resource Management**: Scale compute resources based on demand

## Security and Isolation

### Multi-Tenant Isolation

**User Separation:**
- **Repository Isolation**: Each user has dedicated GitHub repository
- **Pod Isolation**: Kubernetes provides process and network isolation
- **Resource Limits**: CPU/memory quotas prevent resource exhaustion
- **Rate Limiting**: Per-user job limits prevent abuse

**Security Measures:**
```yaml
# Service Account with minimal permissions
apiVersion: v1
kind: ServiceAccount
metadata:
  name: claude-worker
  annotations:
    iam.gke.io/gcp-service-account: claude-worker@project.iam.gserviceaccount.com
```

**Secrets Management:**
- **Kubernetes Secrets**: Slack and GitHub tokens stored securely
- **Workload Identity**: GCP IAM integration for service account access
- **Environment Isolation**: Each worker has isolated environment variables

### Access Control

**Permission Model:**
- **Slack Integration**: App-level permissions with user validation
- **GitHub Access**: Per-repository permissions using GitHub tokens
- **Kubernetes RBAC**: Role-based access control for cluster resources
- **GCS Permissions**: Scoped access to conversation storage buckets

## Monitoring and Observability

### Logging Architecture

**Log Sources:**
- **Dispatcher Logs**: Job creation, user events, rate limiting
- **Worker Logs**: Session execution, Claude interactions, Git operations
- **Kubernetes Logs**: Pod lifecycle, resource usage, failures

**Log Aggregation:**
```yaml
# Example logging configuration
logging:
  level: INFO
  format: JSON
  outputs:
    - stdout          # Kubernetes log collection
    - stackdriver     # Google Cloud Logging
```

### Metrics and Monitoring

**Key Metrics:**
- **Session Success Rate**: Percentage of successful Claude executions
- **Resource Utilization**: CPU/memory usage across worker pods
- **Response Time**: Time from user message to first Claude response
- **Repository Activity**: Git operations, branch creation, commits

**Monitoring Stack:**
- **Prometheus**: Metrics collection and alerting
- **Grafana**: Visualization and dashboards
- **Google Cloud Monitoring**: Integration with GCP services
- **Kubernetes Events**: Pod lifecycle and error tracking

## Deployment Patterns

### Helm Chart Structure

```
charts/peerbot/
├── templates/
│   ├── dispatcher-deployment.yaml
│   ├── worker-rbac.yaml
│   ├── secrets.yaml
│   └── services.yaml
├── values.yaml              # Default configuration
└── values-local.yaml        # Development overrides
```

### Environment Configuration

**Production Deployment:**
```bash
helm upgrade --install peerbot charts/peerbot \
  --namespace peerbot \
  --set dispatcher.replicas=1 \
  --set worker.resources.cpu=2000m \
  --set worker.resources.memory=4Gi \
  --set gcs.bucketName=peerbot-conversations-prod
```

**Development Deployment:**
```bash
make dev  # Uses Skaffold for auto-rebuild and deployment
```

### Scaling Characteristics

**Horizontal Scaling:**
- **Dispatcher**: Single replica (event processing)
- **Workers**: Auto-scaled based on job queue
- **Storage**: GCS provides unlimited conversation storage
- **Compute**: Kubernetes cluster auto-scales based on resource demands

**Performance Characteristics:**
- **Cold Start Time**: ~10 seconds for worker pod initialization
- **Session Duration**: Average 2-3 minutes, maximum 5 minutes
- **Concurrent Users**: Limited by Kubernetes cluster capacity and rate limits
- **Throughput**: ~100 concurrent sessions per cluster (configurable)

---

## Development and Deployment

### Quick Start

```bash
# Clone repository
git clone https://github.com/buremba/claude-code-slack.git
cd claude-code-slack

# Development with auto-rebuild
make dev

# Production deployment
helm upgrade --install peerbot charts/peerbot \
  --namespace peerbot \
  --create-namespace \
  --set secrets.slackBotToken="xoxb-your-token" \
  --set secrets.githubToken="ghp_your-token"
```

### Testing

```bash
# Test the bot in Slack
@peerbotai help me create a React component for user authentication

# Monitor worker execution
kubectl get jobs -n peerbot -w
kubectl logs -f deployment/peerbot-dispatcher -n peerbot
```

This architecture provides a robust, scalable foundation for AI-powered coding assistance while maintaining security, isolation, and operational simplicity through cloud-native technologies.