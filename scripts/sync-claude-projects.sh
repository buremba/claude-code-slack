#!/bin/bash

# Script to sync Claude conversation for current session to repository .claude/projects
# Usage: ./scripts/sync-claude-projects.sh [session_id]

set -e

CLAUDE_HOST_DIR="$HOME/.claude/projects"
REPO_CLAUDE_DIR=".claude/projects"

# Get the current working directory and convert to absolute path format used by Claude CLI
CURRENT_DIR=$(pwd)
# Convert /Users/user/path to -Users-user-path format
PROJECT_NAME=$(echo "$CURRENT_DIR" | sed 's|/|-|g')

# Extract repository name from current directory for relative path
REPO_NAME=$(basename "$CURRENT_DIR")

# Ensure the repo .claude/projects directory exists
mkdir -p "$REPO_CLAUDE_DIR/$REPO_NAME"

if [ -d "$CLAUDE_HOST_DIR/$PROJECT_NAME" ]; then
    echo "Syncing conversation history for project: $PROJECT_NAME -> $REPO_NAME"
    
    # Copy the most recent conversation files (last 3) 
    # This ensures we get the current session plus recent context
    find "$CLAUDE_HOST_DIR/$PROJECT_NAME" -name "*.jsonl" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -3 | while read -r file; do
        if [ -f "$file" ]; then
            cp "$file" "$REPO_CLAUDE_DIR/$REPO_NAME/" 2>/dev/null || true
            echo "✅ Synced: $(basename "$file")"
        fi
    done
    
    echo "✅ Synced conversation history to repository as $REPO_NAME"
else
    echo "❌ Project directory $CLAUDE_HOST_DIR/$PROJECT_NAME not found"
    echo "Available projects:"
    ls -la "$CLAUDE_HOST_DIR/" 2>/dev/null | grep "^d" | grep -v "^\.$" | grep -v "^\.\.$" || echo "No projects found"
    exit 1
fi

# List what was copied
echo "Repository conversation files:"
find "$REPO_CLAUDE_DIR/$REPO_NAME" -name "*.jsonl" -type f 2>/dev/null | head -10 || echo "No conversation files found"