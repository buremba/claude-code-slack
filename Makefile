# Development Makefile for Claude Code Slack Bot

.PHONY: help build compile dev test clean logs restart operator-build operator-deploy

# Default target
help:
	@echo "Available commands:"
	@echo "  make dev              - Start Skaffold in dev mode with auto-rebuild"
	@echo "  make build            - Build TypeScript and Docker image"
	@echo "  make compile          - Compile TypeScript only"
	@echo "  make test             - Run test bot"
	@echo "  make logs             - Show dispatcher logs"
	@echo "  make restart          - Restart the deployment"
	@echo "  make clean            - Stop Skaffold and clean up resources"
	@echo "  make operator-build   - Build operator Docker image"
	@echo "  make operator-deploy  - Deploy operator to Kubernetes"

# Compile TypeScript
compile:
	@echo "📦 Compiling TypeScript..."
	@cd packages/dispatcher && bun run build.ts
	@cd packages/core-runner && bun run build
	@cd packages/operator && bun run build
	@echo "✅ TypeScript compilation complete"

# Build Docker image after compiling
build: compile
	@echo "🐳 Building Docker image..."
	@docker build -f Dockerfile.dispatcher -t peerbot-dispatcher:dev .
	@echo "✅ Docker image built"

# Update Kubernetes deployment with new image
deploy: build
	@echo "🚀 Deploying to Kubernetes..."
	@kubectl set image deployment/peerbot-dispatcher dispatcher=peerbot-dispatcher:dev -n peerbot
	@kubectl rollout status deployment/peerbot-dispatcher -n peerbot --timeout=60s
	@echo "✅ Deployment updated"

# Quick rebuild and redeploy (for testing changes)
update: compile
	@echo "🔄 Quick update..."
	@docker build -f Dockerfile.dispatcher -t peerbot-dispatcher:dev-$(shell date +%s) .
	@kubectl set image deployment/peerbot-dispatcher dispatcher=peerbot-dispatcher:dev-$(shell date +%s) -n peerbot
	@kubectl rollout status deployment/peerbot-dispatcher -n peerbot --timeout=60s
	@echo "✅ Update complete"

# Start development with Skaffold
dev:
	@echo "🚀 Starting Skaffold development mode..."
	@echo "   This will:"
	@echo "   - Watch for file changes"
	@echo "   - Automatically rebuild and redeploy"
	@echo "   - Stream logs to console"
	@echo ""
	@skaffold dev --port-forward $(if $(filter --debug,$(MAKECMDGOALS)),--verbosity=debug)

# Catch-all target to prevent errors when passing arguments
%:
	@:

# Run test bot
test:
	@echo "🧪 Running test bot..."
	@source .env && node test-bot.js --qa

# Show logs
logs:
	@kubectl logs deployment/peerbot-dispatcher -n peerbot --tail=50 -f

# Restart deployment
restart:
	@echo "🔄 Restarting deployment..."
	@kubectl rollout restart deployment/peerbot-dispatcher -n peerbot
	@kubectl rollout status deployment/peerbot-dispatcher -n peerbot

# Clean up
destroy:
	@echo "🧹 Destroying..."
	@skaffold delete --namespace=peerbot || true
	@echo "✅ Deployment destroyed"

# Secret management
secrets:
	@echo "🔐 Updating secrets from .env..."
	@source .env && kubectl create secret generic peerbot-secrets \
		--from-literal="slack-bot-token=$${SLACK_BOT_TOKEN}" \
		--from-literal="slack-app-token=$${SLACK_APP_TOKEN}" \
		--from-literal="slack-signing-secret=$${SLACK_SIGNING_SECRET}" \
		--from-literal="github-token=$${GITHUB_TOKEN}" \
		--namespace=peerbot \
		--dry-run=client -o yaml | kubectl apply -f -
	@echo "✅ Secrets updated"

# Operator-specific targets
operator-build:
	@echo "🔧 Building Claude Operator..."
	@cd packages/operator && bun run build
	@docker build -f Dockerfile.operator -t claude-operator:dev .
	@echo "✅ Claude Operator built"

operator-deploy: operator-build
	@echo "🚀 Deploying Claude Operator..."
	@helm upgrade --install peerbot ./charts/peerbot \
		--namespace peerbot \
		--set operator.enabled=true \
		--set dispatcher.useOperator=true \
		--set operator.image.tag=dev \
		--create-namespace
	@echo "✅ Claude Operator deployed"