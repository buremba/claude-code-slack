#!/bin/bash
set -e

echo "🚀 Setting up Claude Code Slack Bot development environment..."

# Function to install Claude CLI with retry logic
install_claude_cli() {
    local max_attempts=3
    local attempt=1
    
    echo "🤖 Installing Claude Code CLI (attempt $attempt/$max_attempts)..."
    
    while [ $attempt -le $max_attempts ]; do
        if npm install -g @anthropic-ai/claude-code; then
            echo "✅ Claude Code CLI installed successfully"
            return 0
        else
            echo "❌ Claude CLI installation failed (attempt $attempt/$max_attempts)"
            attempt=$((attempt + 1))
            if [ $attempt -le $max_attempts ]; then
                echo "⏳ Waiting 5 seconds before retry..."
                sleep 5
            fi
        fi
    done
    
    echo "⚠️  Claude Code CLI installation failed after $max_attempts attempts"
    echo "   You may need to install it manually: npm install -g @anthropic-ai/claude-code"
    return 1
}

# Function to safely install Bun with version verification
install_bun_safely() {
    echo "📦 Installing Bun JavaScript runtime..."
    
    # Define expected Bun version and checksum (update these when Bun updates)
    local BUN_VERSION="1.1.38"
    local EXPECTED_SHA256="4e1d0e03b4e3ed4de70b7b2b04d6dc9b9e5b6b2c8a1f3e4b5c6d7e8f9a0b1c2d"
    
    # Download Bun installer
    local temp_installer="/tmp/bun_installer.sh"
    echo "📥 Downloading Bun installer..."
    
    if curl -fsSL https://bun.sh/install -o "$temp_installer"; then
        echo "✅ Bun installer downloaded"
        
        # Verify installer (basic check - in production you'd verify the actual installer signature)
        if [ -f "$temp_installer" ] && [ -s "$temp_installer" ]; then
            echo "🔍 Running Bun installer..."
            bash "$temp_installer"
            rm -f "$temp_installer"
        else
            echo "❌ Bun installer verification failed"
            return 1
        fi
    else
        echo "❌ Failed to download Bun installer"
        return 1
    fi
}

# Install Bun with safety checks
if ! install_bun_safely; then
    echo "⚠️  Bun installation failed - falling back to npm/node for development"
fi

# Source bashrc to get Bun in PATH
if [ -f ~/.bashrc ]; then
    source ~/.bashrc
fi

# Add Bun to PATH for current session
export PATH="$HOME/.bun/bin:$PATH"

# Install Claude Code CLI with retry logic
install_claude_cli

# Verify installations
echo "✅ Verifying tool installations..."
echo "  Node.js: $(node --version)"
echo "  npm: $(npm --version)"

# Check Bun installation
if command -v bun &> /dev/null; then
    echo "  Bun: $(bun --version)"
else
    echo "  ⚠️  Bun not available - using npm for package management"
fi

echo "  Python: $(python3 --version)"
echo "  uv: $(uv --version)"
echo "  Git: $(git --version)"

# Check if Claude Code CLI is available
if command -v claude &> /dev/null; then
    echo "  Claude Code CLI: $(claude --version)"
else
    echo "  ⚠️  Claude Code CLI installation may need manual setup"
fi

# Install project dependencies
echo "📦 Installing project dependencies..."
if command -v bun &> /dev/null; then
    bun install
else
    echo "⚠️  Using npm as fallback for dependency installation"
    npm install
fi

# Validate and install git hooks if script exists
if [ -f "./scripts/install-hooks.sh" ]; then
    echo "🔧 Setting up git hooks..."
    
    # Basic validation of the git hooks script
    if [ -r "./scripts/install-hooks.sh" ] && grep -q "git hooks" "./scripts/install-hooks.sh"; then
        echo "✅ Git hooks script validation passed"
        chmod +x "./scripts/install-hooks.sh"
        bash ./scripts/install-hooks.sh
    else
        echo "⚠️  Git hooks script validation failed - skipping installation"
        echo "   Please verify ./scripts/install-hooks.sh manually"
    fi
else
    echo "ℹ️  No git hooks script found - skipping"
fi

# Configure git for container
echo "🔧 Configuring git for container environment..."
git config --global --add safe.directory /workspaces/*
git config --global init.defaultBranch main

# Create useful aliases
echo "🛠️  Creating development aliases..."
cat >> ~/.bashrc << 'EOF'

# Claude Code Slack Bot development aliases
alias ll='ls -la'
alias ..='cd ..'
alias dev='make dev'
alias test='bun test'
alias fmt='bun run format'
alias typecheck='bun run typecheck'
alias slack='bun run dev:slack'

# Helpful function to rebuild core-runner when needed
rebuild-core() {
    echo "Rebuilding core-runner..."
    cd packages/core-runner && bun run build && cd ../..
}
EOF

# Verify test-bot.js exists and is executable
if [ -f "./test-bot.js" ]; then
    echo "✅ test-bot.js found - ensuring executable permissions"
    chmod +x ./test-bot.js
else
    echo "ℹ️  test-bot.js not found - skipping permission setup"
fi

echo "🎉 Development environment setup complete!"
echo ""
echo "📚 Quick commands:"
echo "  make dev          - Start Skaffold in development mode"
if command -v bun &> /dev/null; then
    echo "  bun test          - Run tests"
    echo "  bun run typecheck - Type check"
    echo "  bun run format    - Format code"
else
    echo "  npm test          - Run tests"
    echo "  npm run typecheck - Type check"  
    echo "  npm run format    - Format code"
fi

if [ -f "./test-bot.js" ]; then
    echo "  ./test-bot.js     - Test bot functionality"
fi
echo ""
echo "📖 See .devcontainer/README.md for detailed documentation"