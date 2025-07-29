#!/bin/bash

# Claude Code Slack Bot - Development Setup Script
# This script sets up the local development environment with Docker Compose

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo ""
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
    echo ""
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if Docker daemon is running
docker_running() {
    docker info >/dev/null 2>&1
}

print_header "Claude Code Slack Bot - Development Setup"

print_status "Checking system requirements..."

# Check for required dependencies
MISSING_DEPS=()

if ! command_exists docker; then
    MISSING_DEPS+=("docker")
fi

if ! command_exists "docker"; then
    MISSING_DEPS+=("docker-compose")
elif ! docker compose version >/dev/null 2>&1; then
    if ! command_exists docker-compose; then
        MISSING_DEPS+=("docker-compose")
    fi
fi

if ! command_exists git; then
    MISSING_DEPS+=("git")
fi

if [ ${#MISSING_DEPS[@]} -ne 0 ]; then
    print_error "Missing required dependencies: ${MISSING_DEPS[*]}"
    echo ""
    echo "Please install the missing dependencies:"
    echo ""
    echo "On Ubuntu/Debian:"
    echo "  sudo apt update"
    echo "  sudo apt install -y docker.io docker-compose git"
    echo "  sudo usermod -aG docker \$USER"
    echo ""
    echo "On macOS:"
    echo "  # Install Docker Desktop from https://docker.com/products/docker-desktop"
    echo "  brew install git"
    echo ""
    echo "After installation, restart your terminal and run this script again."
    exit 1
fi

print_success "All required dependencies are installed"

# Check if Docker daemon is running
print_status "Checking Docker daemon..."
if ! docker_running; then
    print_error "Docker daemon is not running"
    echo ""
    echo "Please start Docker:"
    echo "  - On Linux: sudo systemctl start docker"
    echo "  - On macOS/Windows: Start Docker Desktop"
    echo ""
    exit 1
fi

print_success "Docker daemon is running"

# Check Docker permissions
print_status "Checking Docker permissions..."
if ! docker ps >/dev/null 2>&1; then
    print_warning "Cannot run Docker commands without sudo"
    echo ""
    echo "To fix this, add your user to the docker group:"
    echo "  sudo usermod -aG docker \$USER"
    echo "  # Then restart your terminal session"
    echo ""
    echo "For now, you may need to run Docker commands with sudo."
fi

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -f "docker-compose.yml" ]; then
    print_error "This script must be run from the project root directory"
    echo "Please navigate to the claude-code-slack directory and run:"
    echo "  cd claude-code-slack"
    echo "  bash scripts/dev-setup.sh"
    exit 1
fi

print_success "Running from correct directory"

# Create necessary directories
print_status "Creating workspace directories..."
mkdir -p tmp/workspaces
chmod 755 tmp/workspaces

print_success "Workspace directories created"

# Setup .env file
print_status "Setting up environment configuration..."
if [ ! -f ".env" ]; then
    print_status "Copying .env.example to .env..."
    cp .env.example .env
    print_success "Created .env file from template"
    echo ""
    print_warning "IMPORTANT: You must edit .env file with your actual tokens!"
    echo ""
    echo "Required tokens to configure:"
    echo "  - SLACK_BOT_TOKEN: Get from https://api.slack.com/apps"
    echo "  - SLACK_APP_TOKEN: Get from your Slack app (for socket mode)"
    echo "  - SLACK_SIGNING_SECRET: Get from your Slack app settings"
    echo "  - GITHUB_TOKEN: Get from https://github.com/settings/tokens"
    echo "  - GITHUB_ORGANIZATION: Your GitHub organization name"
    echo ""
else
    print_success ".env file already exists"
fi

# Check if worker image exists
print_status "Checking for worker Docker image..."
if docker images --format "table {{.Repository}}:{{.Tag}}" | grep -q "claude-worker:latest"; then
    print_success "Worker image 'claude-worker:latest' found"
else
    print_warning "Worker image 'claude-worker:latest' not found"
    echo ""
    echo "You'll need to build or pull the worker image:"
    echo "  docker build -f docker/worker.Dockerfile -t claude-worker:latest ."
    echo "  # OR"
    echo "  docker pull your-registry/claude-worker:latest"
    echo "  docker tag your-registry/claude-worker:latest claude-worker:latest"
    echo ""
fi

# Build dispatcher image
print_status "Building dispatcher image..."
if docker compose build dispatcher; then
    print_success "Dispatcher image built successfully"
else
    print_error "Failed to build dispatcher image"
    echo ""
    echo "Please check the Dockerfile and try again:"
    echo "  docker compose build dispatcher --no-cache"
    exit 1
fi

# Validate Docker Compose configuration
print_status "Validating Docker Compose configuration..."
if docker compose config >/dev/null 2>&1; then
    print_success "Docker Compose configuration is valid"
else
    print_error "Docker Compose configuration is invalid"
    echo ""
    echo "Please check your docker-compose.yml file and .env configuration"
    exit 1
fi

# Test Docker socket access
print_status "Testing Docker socket access..."
if docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine:latest sh -c "ls /var/run/docker.sock" >/dev/null 2>&1; then
    print_success "Docker socket is accessible"
else
    print_warning "Docker socket access test failed"
    echo ""
    echo "The bot needs access to /var/run/docker.sock to manage worker containers."
    echo "This might work anyway, but you may encounter permission issues."
fi

print_header "Setup Validation"

# Function to validate environment variable
validate_env_var() {
    local var_name=$1
    local var_value=$(grep "^${var_name}=" .env 2>/dev/null | cut -d'=' -f2- | sed 's/^["'"'"']//;s/["'"'"']$//')
    
    if [ -z "$var_value" ] || [[ "$var_value" =~ your-.*-here ]] || [[ "$var_value" =~ xoxb-your ]] || [[ "$var_value" =~ xapp-your ]]; then
        return 1
    fi
    return 0
}

# Check critical environment variables
UNCONFIGURED_VARS=()

for var in "SLACK_BOT_TOKEN" "SLACK_APP_TOKEN" "SLACK_SIGNING_SECRET" "GITHUB_TOKEN" "GITHUB_ORGANIZATION"; do
    if ! validate_env_var "$var"; then
        UNCONFIGURED_VARS+=("$var")
    fi
done

if [ ${#UNCONFIGURED_VARS[@]} -ne 0 ]; then
    print_warning "The following environment variables need to be configured:"
    for var in "${UNCONFIGURED_VARS[@]}"; do
        echo "  - $var"
    done
    echo ""
    echo "Please edit the .env file and configure these variables before starting the application."
    echo ""
fi

print_header "Setup Complete!"

echo "Your local development environment is ready!"
echo ""
echo "Next steps:"
echo ""
echo "1. Configure your .env file with actual tokens (if not done already):"
echo "   nano .env"
echo ""
echo "2. Start the development environment:"
echo "   npm run dev:local"
echo "   # or: docker compose up --build"
echo ""
echo "3. Test the bot in Slack by mentioning @claude"
echo ""
echo "Useful commands:"
echo "  npm run dev:local        - Start development environment"
echo "  npm run dev:local:logs   - View dispatcher logs"
echo "  npm run dev:local:down   - Stop development environment"
echo "  npm run dev:local:clean  - Clean up everything"
echo ""
echo "For more information, see docs/local-development.md"
echo ""

# Ask if user wants to start the development environment
if [ ${#UNCONFIGURED_VARS[@]} -eq 0 ]; then
    echo -n "Would you like to start the development environment now? (y/n): "
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        print_status "Starting development environment..."
        echo ""
        docker compose up --build
    fi
else
    print_warning "Please configure the environment variables first, then run:"
    echo "  npm run dev:local"
fi