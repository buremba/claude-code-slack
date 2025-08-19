# Claude Code Slack Bot - Development Container

This directory contains the devcontainer configuration for the Claude Code Slack Bot project, providing a consistent and fully-configured development environment.

## Overview

The devcontainer provides a complete development environment with all necessary tools pre-installed:

- **Bun** - JavaScript runtime and package manager
- **uv** - Fast Python package manager
- **Claude Code CLI** - AI-powered development assistant
- **Git** - Version control
- **Docker** - Container support (Docker-in-Docker)
- **Python 3.11** - Python runtime
- **Node.js LTS** - JavaScript runtime for Claude Code CLI

## Prerequisites

- **Visual Studio Code** with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
- **Docker Desktop** - Required for running containers

## Getting Started

### Option 1: Command Palette (Recommended)

1. Open the project in VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS)
3. Type and select "Dev Containers: Reopen in Container"
4. Wait for the container to build and configure (first run takes 5-10 minutes)

### Option 2: Remote Explorer

1. Open VS Code
2. Click the Remote Explorer icon in the sidebar
3. Select "Dev Containers" from the dropdown
4. Click "Open Folder in Container" and select this project

## Included Tools and Extensions

### Pre-installed Tools
- **Bun** (`~/.bun/bin/bun`) - JavaScript runtime and package manager
- **uv** - Python package manager with virtual environment support
- **Claude Code CLI** - AI assistant for development tasks
- **Git** - Version control with container-safe configuration
- **Docker** - Container support for building and testing

### VS Code Extensions
- **TypeScript/JavaScript**: Enhanced TypeScript support, ESLint, Prettier
- **Python**: Python extension, Pylance, Ruff formatting/linting
- **Development**: GitHub Copilot, Docker support, Kubernetes tools
- **Utilities**: JSON, YAML support

## Development Workflow

### Getting Started
```bash
# Install dependencies (done automatically)
bun install

# Start development with Skaffold
make dev

# Run tests
bun test

# Type checking
bun run typecheck

# Code formatting
bun run format
```

### Slack Bot Development
```bash
# Run Slack bot locally
bun run dev:slack

# Run dispatcher
bun run dev:dispatcher

# Run worker
bun run dev:worker

# Test bot functionality
./test-bot.js
```

### Core-Runner Changes
When making changes to `packages/core-runner/`, rebuild it first:
```bash
cd packages/core-runner && bun run build
# Skaffold will detect the change and rebuild worker automatically
```

### Available Aliases
The container includes helpful aliases:
- `dev` - Start Skaffold (`make dev`)
- `test` - Run tests (`bun test`)
- `fmt` - Format code (`bun run format`)
- `typecheck` - Type check (`bun run typecheck`)
- `slack` - Run Slack bot (`bun run dev:slack`)

## Environment Configuration

### Ports
- **3000** - Slack Bot Development Server
- **8080** - Webhook Server

### Environment Variables
- `NODE_ENV=development` - Development mode
- `PYTHONPATH` - Set to project src directory
- `BUN_INSTALL` - Bun installation path

### Volume Mounts
- Package manager caches are preserved between rebuilds
- Host cache directory is mounted for better performance

## Troubleshooting

### Container Build Issues
```bash
# Rebuild container completely
Ctrl+Shift+P → "Dev Containers: Rebuild Container"
```

### Tool Installation Issues
```bash
# Re-run post-create command
.devcontainer/postCreateCommand.sh
```

### Permission Issues
```bash
# Git safe directory is configured automatically
git config --global --add safe.directory /workspaces/*
```

### Claude Code CLI Issues
```bash
# Verify installation
claude --version

# Manual installation if needed
npm install -g @anthropic-ai/claude-code
```

## Customization

### Adding Extensions
Edit `.devcontainer/devcontainer.json` and add to `customizations.vscode.extensions`.

### Installing Additional Tools
Add installation commands to `.devcontainer/postCreateCommand.sh`.

### Environment Variables
Modify the `remoteEnv` section in `devcontainer.json`.

## Integration with Existing Workflow

This devcontainer is designed to work seamlessly with the existing development process:

- **Skaffold**: Use `make dev` for auto-rebuild during development
- **Testing**: All existing test commands work (`bun test`, `./test-bot.js`)
- **Deployment**: Kubernetes and Docker commands work within the container
- **Git Hooks**: Automatically set up using `scripts/install-hooks.sh`

## Performance Tips

- The first container build takes 5-10 minutes
- Subsequent builds are much faster due to layer caching
- Package manager caches are preserved between rebuilds
- Use VS Code's "Rebuild Container" only when configuration changes

For more information about the project structure and development practices, see the main [CONTRIBUTING.md](../CONTRIBUTING.md) file.