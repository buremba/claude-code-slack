# Local Development with Docker Compose

This guide explains how to set up and run the Claude Code Slack Bot locally using Docker Compose for development and testing.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Docker** (version 20.10 or later)
- **Docker Compose** (version 2.0 or later)  
- **Git** for cloning the repository
- A **Slack app** with the necessary permissions and tokens
- A **GitHub personal access token** with repository permissions
- Optional: **Google Cloud Storage** setup for conversation logging

## Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/buremba/claude-code-slack.git
   cd claude-code-slack
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env and fill in your tokens and configuration
   ```

3. **Build and start the services:**
   ```bash
   npm run dev:local
   # or manually: docker compose up --build
   ```

4. **Verify the setup:**
   - Check the logs: `docker compose logs -f dispatcher`
   - Test in Slack by mentioning `@claude` in a channel

## Configuration

### Required Environment Variables

The following environment variables must be configured in your `.env` file:

#### Infrastructure Settings
```env
INFRASTRUCTURE_MODE=docker
DOCKER_SOCKET_PATH=/var/run/docker.sock
WORKSPACE_HOST_DIR=/tmp/claude-workspaces
```

#### Slack Configuration
```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token  # Required for socket mode
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_HTTP_MODE=false  # Socket mode recommended for development
SLACK_TRIGGER_PHRASE=@claude
```

#### GitHub Configuration
```env
GITHUB_TOKEN=ghp_your-github-token
GITHUB_ORGANIZATION=your-organization-name
```

#### Worker Configuration
```env
WORKER_IMAGE=claude-worker:latest
WORKER_CPU=1000m
WORKER_MEMORY=2Gi
WORKER_TIMEOUT_SECONDS=300
```

### Optional Configuration

#### Google Cloud Storage (for conversation logging)
```env
GCS_BUCKET_NAME=your-bucket-name
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GOOGLE_CLOUD_PROJECT=your-project-id
```

## Development Workflow

### Hot Reload

The development setup includes hot reload for faster iteration:

- **Source code changes**: Mounted as read-only volumes in `docker-compose.override.yml`
- **Automatic restarts**: The container automatically restarts when code changes
- **Workspace persistence**: Worker containers share a workspace directory for debugging

### Volume Mounting

The Docker Compose setup mounts several directories:

```yaml
volumes:
  # Docker socket for container management
  - /var/run/docker.sock:/var/run/docker.sock
  # Source code for hot reload
  - ./packages:/app/packages:ro
  # Workspace directory for debugging
  - ./tmp/workspaces:/tmp/claude-workspaces
```

### Debugging Worker Containers

When the dispatcher creates worker containers, you can debug them:

1. **List running workers:**
   ```bash
   docker ps --filter label=app=claude-worker
   ```

2. **View worker logs:**
   ```bash
   docker logs <container-id>
   ```

3. **Execute commands in worker:**
   ```bash
   docker exec -it <container-id> /bin/bash
   ```

4. **Inspect workspace:**
   ```bash
   ls -la ./tmp/workspaces/
   ```

### Testing Slack Integration

1. **Socket Mode (Recommended):**
   - Set `SLACK_HTTP_MODE=false`
   - No need for ngrok or public URLs
   - Real-time connection to Slack

2. **HTTP Mode:**
   - Set `SLACK_HTTP_MODE=true`
   - Requires ngrok or public URL
   - Configure request URL in Slack app settings

3. **Test the bot:**
   - Add the bot to a Slack channel
   - Send a message: `@claude help`
   - Check dispatcher logs for activity

## Monitoring and Logs

### View Dispatcher Logs
```bash
# Follow all logs
docker compose logs -f

# Follow only dispatcher logs
docker compose logs -f dispatcher

# View recent logs
docker compose logs --tail=100 dispatcher
```

### Health Checks

The dispatcher includes health check endpoints:

- **Health**: `http://localhost:3000/health`
- **Status**: Check dispatcher logs for status information

### Resource Monitoring

Monitor Docker resource usage:

```bash
# View container resource usage
docker stats

# View system resources
docker system df

# Clean up unused resources
docker system prune
```

## Configuration Options

### Switching Between Socket and HTTP Mode

**Socket Mode (Default):**
```env
SLACK_HTTP_MODE=false
SLACK_APP_TOKEN=xapp-your-token  # Required
```

**HTTP Mode:**
```env
SLACK_HTTP_MODE=true
PORT=3000  # Port for incoming webhooks
```

### Custom Docker Networks

```env
DOCKER_NETWORK=claude-network  # Default network name
```

### Workspace Volume Mounting

For development with persistent workspaces:
```env
WORKSPACE_HOST_DIR=./tmp/workspaces  # Relative to project root
```

## Troubleshooting

### Common Issues

#### Docker Socket Permission Issues
```bash
# Add your user to docker group (Linux)
sudo usermod -aG docker $USER
# Restart your session

# Or run with sudo (not recommended)
sudo docker compose up
```

#### Worker Container Startup Failures
- Check worker image exists: `docker images | grep claude-worker`
- Verify Docker socket access: `docker ps` should work without sudo
- Check workspace directory permissions: `ls -la /tmp/claude-workspaces`

#### Slack Connection Issues
- Verify tokens are correct and not expired
- Check bot permissions in Slack app settings
- Ensure bot is added to the channel where you're testing
- Review dispatcher logs for authentication errors

#### Memory/Resource Issues
- Reduce worker memory limit: `WORKER_MEMORY=1Gi`
- Limit concurrent workers in rate limiting code
- Monitor Docker memory usage: `docker stats`

### Worker Container Debugging

If worker containers are failing:

1. **Check worker image:**
   ```bash
   docker inspect claude-worker:latest
   ```

2. **Run worker manually to test:**
   ```bash
   docker run -it --rm \
     -e SESSION_KEY=test \
     -e USER_ID=test \
     -v /tmp/claude-workspaces:/workspace \
     claude-worker:latest /bin/bash
   ```

3. **Check environment variables:**
   ```bash
   docker exec <container-id> env | grep -E "SLACK|GITHUB|CLAUDE"
   ```

### Clean Up

Clean up all resources:
```bash
# Stop and remove containers
npm run dev:local:clean
# or manually:
docker compose down -v --remove-orphans

# Remove unused Docker resources
docker system prune -f

# Remove workspace directory
rm -rf ./tmp/workspaces
```

## Comparison with Kubernetes Deployment

| Feature | Local Docker | Kubernetes Production |
|---------|--------------|----------------------|
| **Setup Complexity** | Low | High |
| **Resource Requirements** | Low | High |
| **Scalability** | Limited | High |
| **Debugging** | Easy | Complex |
| **Hot Reload** | Yes | No |
| **Production Ready** | No | Yes |
| **Cost** | Free | Variable |
| **Isolation** | Container-level | Pod-level |
| **Service Discovery** | Docker networks | Kubernetes DNS |
| **Load Balancing** | Manual | Automatic |
| **Health Checks** | Basic | Advanced |
| **Secrets Management** | Environment files | Kubernetes secrets |
| **Monitoring** | Docker logs | Full observability |

### When to Use Each Mode

**Use Local Docker When:**
- Developing new features
- Testing changes locally
- Debugging issues
- Learning the system
- No Kubernetes cluster available

**Use Kubernetes When:**
- Production deployment
- High availability required
- Scaling to multiple users
- Advanced monitoring needed
- Cost optimization important

## Next Steps

1. **Set up your Slack app** following the [Slack App Setup Guide](./deployment.md#slack-app-setup)
2. **Create GitHub repositories** for your organization
3. **Configure Google Cloud Storage** if you want conversation logging
4. **Review security considerations** in the main [deployment documentation](./deployment.md)
5. **Consider upgrading to Kubernetes** for production use

For production deployment, see [Kubernetes Deployment Guide](./kubernetes-deployment.md).