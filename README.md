# Claude Code Slack

A powerful [Claude Code](https://claude.ai/code) Slack application that brings AI-powered programming assistance directly to your Slack workspace with **Kubernetes-based scaling** and **persistent thread conversations**.

## 🎯 Key Features

### 💬 **Thread-Based Persistent Conversations**
- Each Slack thread becomes a dedicated AI coding session
- Full conversation history preserved across interactions
- Resume work exactly where you left off

### 🏗️ **Kubernetes-Powered Architecture**
- **Dispatcher-Worker Pattern**: Scalable, isolated execution
- **Per-User Containers**: Each session gets dedicated resources
- **5-Minute Sessions**: Focused, efficient coding sessions
- **Auto-Scaling**: Handles multiple users simultaneously

### 👤 **Individual GitHub Workspaces**  
- **Personal Repositories**: Each user gets `user-{username}` repository
- **Automatic Git Operations**: Code commits and branch management
- **GitHub.dev Integration**: Direct links to online code editor
- **Pull Request Creation**: Easy code review workflow

### 🔄 **Real-Time Progress Streaming**
- Live updates as Claude works on your code
- Worker resource monitoring (CPU, memory, timeout)
- Transparent execution with detailed progress logs

### 🛡️ **Enterprise-Ready**
- **GCS Persistence**: Conversation history in Google Cloud Storage
- **RBAC Security**: Kubernetes role-based access control
- **Workload Identity**: Secure GCP integration
- **Monitoring & Observability**: Full Kubernetes monitoring stack

## 🚀 Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Dispatcher    │    │   Worker Jobs   │    │  GCS + GitHub   │
│   (Long-lived)  │───▶│   (Ephemeral)   │───▶│  (Persistence)  │
│                 │    │                 │    │                 │
│ • Slack Events  │    │ • User Workspace│    │ • Conversations │
│ • Thread Routing│    │ • Claude CLI    │    │ • Code Changes  │
│ • Job Spawning  │    │ • 5min Timeout  │    │ • Session Data  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 📋 Deployment Options

Choose your deployment approach:

### 🐳 **Option 1: Local Development (Docker Compose)**
Perfect for development, testing, and small teams

**Benefits:**
- ✅ Quick setup with one command
- ✅ Hot reload for development
- ✅ Full Docker isolation
- ✅ No Kubernetes required
- ✅ Easy debugging and testing
- ❌ Single-node scaling only

**Prerequisites:**
- Docker and Docker Compose
- Slack app tokens
- GitHub personal access token

**Quick Start:**
```bash
npm run setup:local    # Setup environment
npm run dev:local      # Start development server
```

📖 **[→ Local Development Guide](./docs/local-development.md)**

### 🎯 **Option 2: Kubernetes (Production)**
Full-featured deployment with per-user isolation and persistence

**Benefits:**
- ✅ Per-user containers and GitHub repositories  
- ✅ Thread-based conversation persistence
- ✅ Horizontal scaling for large teams
- ✅ Enterprise security and monitoring
- ✅ GCS backup and recovery
- ✅ Cost optimization and auto-scaling

**Prerequisites:**
- Google Kubernetes Engine (GKE) cluster
- Google Cloud Storage bucket
- GitHub organization for user repositories

📖 **[→ Kubernetes Deployment Guide](./docs/kubernetes-deployment.md)**

### 🔧 **Option 3: Single Container (Legacy)**
Simple deployment for small teams and development

**Benefits:**
- ✅ Quick setup and testing
- ✅ Minimal infrastructure requirements
- ❌ Shared execution environment
- ❌ No conversation persistence
- ❌ Limited scaling

📖 **[→ Single Container Setup](#single-container-setup)**

---

## 🚀 Quick Start Comparison

| Feature | Local Docker | Kubernetes | Single Container |
|---------|-------------|------------|------------------|
| **Setup Time** | 5 minutes | 30+ minutes | 2 minutes |
| **Prerequisites** | Docker | K8s cluster | Node.js |
| **User Isolation** | ✅ | ✅ | ❌ |
| **Persistence** | ✅ | ✅ | ❌ |
| **Scalability** | Single node | Unlimited | Single process |
| **Hot Reload** | ✅ | ❌ | ✅ |
| **Production Ready** | ❌ | ✅ | ❌ |
| **Cost** | Free | Variable | Free |

**Recommendation:**
- **Development**: Use Local Docker
- **Production**: Use Kubernetes  
- **Quick Testing**: Use Single Container

---

## 🐳 Kubernetes Quick Start

### Prerequisites

- **GKE Autopilot Cluster**: Managed Kubernetes environment
- **Google Cloud Storage**: For conversation persistence  
- **GitHub Organization**: For user repositories
- **Slack App**: With proper permissions and tokens

### 1. Deploy with Helm

```bash
# Clone repository
git clone https://github.com/buremba/claude-code-slack.git
cd claude-code-slack

# Install PeerBot with Helm
helm upgrade --install peerbot charts/peerbot \
  --namespace peerbot \
  --create-namespace \
  --set secrets.slackBotToken="xoxb-your-slack-token" \
  --set secrets.githubToken="ghp_your-github-token" \
  --set config.gcsBucketName="peerbot-conversations-prod" \
  --set config.gcsProjectId="your-gcp-project" \
  --wait
```

### 2. Verify Deployment

```bash
# Check pods are running
kubectl get pods -n peerbot

# View dispatcher logs
kubectl logs deployment/peerbot-dispatcher -n peerbot

# Monitor worker jobs
kubectl get jobs -n peerbot -w
```

### 3. Test the Bot

Mention the bot in Slack:

```
@peerbotai help me create a React component for user authentication
```

**Expected Response:**
```
🤖 Claude is working on your request...

Worker Environment:
• Pod: claude-worker-auth-abc123
• CPU: 2000m Memory: 4Gi  
• Timeout: 5 minutes
• Repository: user-yourname

GitHub Workspace:
• Repository: user-yourname
• 📝 Edit on GitHub.dev
• 🔄 Create Pull Request

Progress updates will appear below...
```

📖 **For detailed setup:** [Kubernetes Deployment Guide](./docs/kubernetes-deployment.md)

---

## 🔧 Single Container Setup

For development and small teams:

### Prerequisites

- [Bun](https://bun.sh/) runtime installed
- [Anthropic API key](https://console.anthropic.com/) for Claude access
- Slack workspace with app installation permissions

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"** → **"From an app manifest"**
3. Copy contents of [`examples-slack/app-manifest.json`](./examples-slack/app-manifest.json)
4. Get your tokens: Bot Token (xoxb-), App Token (xapp-), Signing Secret

### 2. Setup Application

```bash
# Clone and install
git clone https://github.com/buremba/claude-code-slack.git
cd claude-code-slack
bun install

# Configure environment
cp .env.example .env
# Edit .env with your tokens

# Start in development mode
bun run dev:slack
```

📖 **For detailed setup:** [Slack Integration Guide](./docs/slack-integration.md)

---

## 🎯 User Experience

### Thread-Based Conversations

**Key Feature**: Each Slack thread = persistent conversation

```
User: @peerbotai create a simple REST API in Python

Bot: 🤖 Claude is working on your request...
     [Creates user repository and starts worker]

Bot: ✅ Created Flask API with user model, CRUD endpoints, 
     and Docker configuration.
     📝 View on GitHub.dev | 🔄 Create PR

User: (in same thread) Can you add authentication?

Bot: 🤖 Resuming conversation...
     [Loads previous context and adds auth]

Bot: ✅ Added JWT authentication with login/register endpoints.
     📝 View changes | 🔄 Updated PR
```

### User Repositories

Each user gets a dedicated GitHub repository:

- **Repository**: `peerbot-community/user-{username}`
- **Structure**: Projects, scripts, docs, workspace folders
- **Branches**: Session-specific branches (e.g., `claude/session-20250128`)
- **Integration**: Direct GitHub.dev links for online editing

## 📚 Configuration

### Kubernetes Configuration

| Component | Setting | Description |
|-----------|---------|-------------|
| **Slack** | `slack.triggerPhrase` | Bot trigger phrase (default: `@peerbotai`) |
| **GitHub** | `github.organization` | GitHub org for user repos |
| **GCS** | `gcs.bucketName` | Conversation storage bucket |
| **Worker** | `worker.resources` | CPU/memory limits per session |
| **Session** | `session.timeoutMinutes` | Session timeout (default: 5min) |

### Single Container Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token from Slack |
| `SLACK_APP_TOKEN` | ✅ | App-Level Token for Socket Mode |
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `SLACK_TRIGGER_PHRASE` | ❌ | Custom trigger phrase (default: `@claude`) |

See [`.env.example`](./.env.example) for all available options.

### Permissions and Access Control

Control who can use the bot and where:

```env
# Allow only specific users
SLACK_ALLOWED_USERS=U1234567890,U0987654321

# Block specific users
SLACK_BLOCKED_USERS=U1111111111

# Allow only specific channels
SLACK_ALLOWED_CHANNELS=C1234567890,C0987654321

# Block specific channels
SLACK_BLOCKED_CHANNELS=C1111111111

# Disable private channels (default: disabled)
SLACK_ALLOW_PRIVATE_CHANNELS=false

# Disable direct messages (default: enabled)
SLACK_ALLOW_DIRECT_MESSAGES=false
```

## How It Works

### Message Flow

1. **User mentions the bot** or uses the trigger phrase
2. **Status reaction** (⏳) is added to the user's message
3. **Initial response** is posted in thread with progress indicator
4. **Claude processes** the request with real-time updates
5. **Final result** is posted with cost/duration info
6. **Status emoji** changes to ✅ (success) or ❌ (error)

### Example Conversation

```
👤 User: @Claude Code can you help me optimize this Python function?

def slow_function(data):
    result = []
    for item in data:
        if item > 0:
            result.append(item * 2)
    return result

🤖 Claude Code: I'm working on your request... ⏳

[Real-time updates as Claude analyzes...]

🤖 Claude Code: I can help optimize that function! Here's an improved version:

```python
def optimized_function(data):
    return [item * 2 for item in data if item > 0]
```

This uses a list comprehension which is more pythonic and typically faster. For large datasets, you could also consider using NumPy:

```python
import numpy as np

def numpy_optimized(data):
    arr = np.array(data)
    return (arr[arr > 0] * 2).tolist()
```

✅ **Completed** | **Cost:** $0.0023 | **Duration:** 3.2s
```

## Advanced Usage

### Custom Instructions

Add custom behavior with the `CUSTOM_INSTRUCTIONS` environment variable:

```env
CUSTOM_INSTRUCTIONS="Always explain your reasoning and provide code examples. Focus on performance and best practices."
```

### Tool Configuration

Control what Claude can do:

```env
# Additional tools
ALLOWED_TOOLS=WebSearch,WebFetch

# Restricted tools  
DISALLOWED_TOOLS=Bash

# Enable GitHub file operations for code projects
INCLUDE_GITHUB_FILE_OPS=true
GITHUB_TOKEN=ghp_your-github-token-here
```

### Deployment Options

#### Development Mode
```bash
bun run dev:slack
```

#### Production Mode
```bash
bun run start:slack
```

#### HTTP Mode (instead of Socket Mode)
```env
SLACK_HTTP_MODE=true
PORT=3000
```

#### Docker Deployment
```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install
COPY . .

EXPOSE 3000
CMD ["bun", "run", "start:slack"]
```

## Troubleshooting

### Common Issues

**Bot doesn't respond to mentions:**
- Check that the bot is invited to the channel
- Verify `SLACK_BOT_TOKEN` is correct
- Ensure the app has `app_mentions:read` scope

**Socket Mode connection fails:**
- Verify `SLACK_APP_TOKEN` is set and valid
- Check that Socket Mode is enabled in your app settings
- Try HTTP mode as fallback with `SLACK_HTTP_MODE=true`

**Permission denied errors:**
- Review your app's OAuth scopes
- Check channel-specific permissions
- Verify the bot is properly installed in your workspace

### Debug Mode

Enable verbose logging:

```env
LOG_LEVEL=DEBUG
NODE_ENV=development
```

### Support

- 📚 [Slack API Documentation](https://api.slack.com/)
- 🔧 [Claude Code Documentation](https://docs.anthropic.com/claude/docs/claude-code)
- 🐛 [Report Issues](https://github.com/anthropics/claude-code-slack/issues)

## 📖 Documentation

- **[🐳 Kubernetes Deployment Guide](./docs/kubernetes-deployment.md)** - Complete GKE setup with Helm
- **[💬 Slack Integration Setup](./docs/slack-integration.md)** - Slack app configuration and usage
- **[🏗️ Architecture Deep Dive](#)** - Technical architecture and design decisions
- **[🔧 Development Guide](#)** - Contributing and local development setup

## 🔄 Migration from GitHub Actions

Upgrading from the original GitHub Actions Claude Code:

### New Features ✨
- **Thread Persistence**: Conversations continue across messages
- **User Isolation**: Individual repositories and containers
- **Scalability**: Multiple concurrent users supported
- **Real-time Updates**: Live progress streaming
- **Enterprise Security**: RBAC, Workload Identity, audit logs

### Breaking Changes ⚠️
- **Environment Variables**: New Kubernetes-based configuration
- **Deployment**: Requires Kubernetes cluster instead of single container
- **GitHub Structure**: User repositories instead of direct PR operations
- **Trigger Method**: Slack mentions instead of PR comments

📖 **Migration assistance available in our [upgrade guide](#)**

## Contributing

We welcome contributions! Please see our [contributing guidelines](./CONTRIBUTING.md) for details.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.