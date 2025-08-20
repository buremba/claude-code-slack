# CLAUDE.md

- You MUST only do what has been asked; nothing more, nothing less. You can check logs with k8s to understand the recent behavior the user is asking for.
- Anytime you make changes in the code that should be tested, you MUST run ./test-bot.js "Relevant prompt" and make sure it works properly.
- If you create ephemeral files, you MUST delete them when you're done with them.
- Always use Skaffold to build and run the Slack bot.
- NEVER create files unless they're absolutely necessary for achieving your goal. Instead try to run the code on the fly for testing reasons.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User. If you need to remember something, add it to CLAUDE.md as a a single sentence.
- Use `make dev` to start Skaffold in development mode with auto-rebuild, or see Makefile for other useful commands.
- After making core changes (like removing environment variables), restart pods with: `kubectl rollout restart deployment/peerbot-dispatcher -n peerbot` to ensure latest code is running.

## Deployment Instructions

When making changes to the Slack bot with `make dev` running:

1. **Dispatcher changes** (packages/dispatcher/): Skaffold will auto-rebuild and deploy
2. **Worker changes** (packages/worker/): Skaffold will auto-rebuild and deploy
3. **Core-runner changes** (packages/core-runner/): First build core-runner, then Skaffold will detect worker changes:
   ```bash
   cd packages/core-runner && bun run build
   # Skaffold will detect the change and rebuild worker automatically
   ```

The bot updates automatically when running `make dev` - no manual steps needed!

## Development Configuration

- Rate limiting is disabled in local development (dispatcher.disableRateLimit: true in values-local.yaml)
- To manually rebuild worker image if needed: `docker build -f Dockerfile.worker -t claude-worker:latest .`

## Conversation Persistence

The Slack bot automatically persists conversations using Claude CLI's session management:

1. **Automatic Session Management**: Each Slack thread gets its own Claude session ID for conversation continuity
2. **Syncing Projects**: Use `./scripts/sync-claude-projects.sh` to copy Claude projects from host `~/.claude/projects/[dir]` to repository `.claude/projects/[relativedir]`
3. **Container Setup**: The worker container automatically extracts `.claude/projects` data to `~/.claude/projects` with absolute paths
4. **Auto-Resume**: The worker automatically resumes conversations using Claude CLI's built-in `--resume` functionality when continuing a thread
5. **Git Commits**: When creating PRs, conversations are preserved in the `.claude/projects` directory for future reference
   