#!/usr/bin/env bash

# Cleanup Stale Worker Deployments
# 
# This script identifies and removes inactive claude-worker deployments
# that have been idle for more than the specified grace period.
#
# Safety measures:
# - Only deletes deployments with readyReplicas: 0
# - Preserves PVC data for conversation resume capability  
# - Uses grace period to avoid deleting recently stopped workers
# - Dry-run mode by default for safety

set -euo pipefail

# Configuration
NAMESPACE="peerbot"
GRACE_PERIOD_MINUTES=15
DRY_RUN=true
VERBOSE=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Help function
show_help() {
    cat << EOF
Usage: $0 [OPTIONS]

Cleanup stale claude-worker deployments in Kubernetes.

OPTIONS:
    -n, --namespace NAMESPACE   Kubernetes namespace (default: peerbot)
    -g, --grace-period MINUTES Grace period in minutes (default: 15)
    -f, --force                 Actually delete deployments (default: dry-run)
    -v, --verbose               Verbose output
    -h, --help                  Show this help message

EXAMPLES:
    $0                          # Dry-run with default settings
    $0 -f                       # Actually delete stale deployments  
    $0 -g 30 -f                 # Use 30-minute grace period and delete
    $0 -n my-namespace -v       # Different namespace with verbose output

SAFETY:
    - Runs in dry-run mode by default
    - Only targets deployments with readyReplicas: 0
    - Preserves persistent volume data
    - Uses grace period to avoid deleting active sessions
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -g|--grace-period)
            GRACE_PERIOD_MINUTES="$2"
            shift 2
            ;;
        -f|--force)
            DRY_RUN=false
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option $1"
            show_help
            exit 1
            ;;
    esac
done

# Utility functions
log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_verbose() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "${BLUE}[VERBOSE]${NC} $1"
    fi
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

# Check if kubectl is available and connected
check_kubectl() {
    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl command not found. Please install kubectl."
        exit 1
    fi
    
    if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
        log_error "Cannot access namespace '$NAMESPACE'. Check your kubectl configuration."
        exit 1
    fi
    
    log_verbose "kubectl connectivity verified for namespace '$NAMESPACE'"
}

# Get timestamp N minutes ago in ISO format
get_cutoff_time() {
    local minutes_ago=$1
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        date -v-${minutes_ago}M -u +"%Y-%m-%dT%H:%M:%SZ"
    else
        # Linux
        date -u -d "${minutes_ago} minutes ago" +"%Y-%m-%dT%H:%M:%SZ"
    fi
}

# Convert ISO timestamp to epoch for comparison
iso_to_epoch() {
    local iso_time=$1
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        date -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso_time" "+%s"
    else
        # Linux
        date -d "$iso_time" "+%s"
    fi
}

# Find stale deployments
find_stale_deployments() {
    local cutoff_time
    cutoff_time=$(get_cutoff_time "$GRACE_PERIOD_MINUTES")
    local cutoff_epoch
    cutoff_epoch=$(iso_to_epoch "$cutoff_time")
    
    log "Searching for claude-worker deployments older than $cutoff_time (${GRACE_PERIOD_MINUTES} minutes ago)..."
    log_verbose "Cutoff epoch: $cutoff_epoch"
    
    # Get all claude-worker deployments with 0 ready replicas
    local deployments
    deployments=$(kubectl get deployments -n "$NAMESPACE" \
        -l app=claude-worker \
        -o jsonpath='{range .items[*]}{@.metadata.name}{"|"}{@.status.readyReplicas}{"|"}{@.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null || true)
    
    if [[ -z "$deployments" ]]; then
        log "No claude-worker deployments found in namespace '$NAMESPACE'"
        return 0
    fi
    
    local stale_deployments=()
    local active_count=0
    local recent_count=0
    
    while IFS='|' read -r name ready_replicas creation_time; do
        [[ -z "$name" ]] && continue
        
        log_verbose "Checking deployment: $name (ready: ${ready_replicas:-0}, created: $creation_time)"
        
        # Skip if deployment has ready replicas
        if [[ "${ready_replicas:-0}" != "0" ]]; then
            log_verbose "  Skipping $name: has ${ready_replicas} ready replicas"
            ((active_count++))
            continue
        fi
        
        # Check if deployment is old enough
        local creation_epoch
        creation_epoch=$(iso_to_epoch "$creation_time")
        
        if [[ "$creation_epoch" -gt "$cutoff_epoch" ]]; then
            log_verbose "  Skipping $name: created too recently ($creation_time)"
            ((recent_count++))
            continue
        fi
        
        # Check for recent ConfigMap activity (indicates recent messages)
        local recent_configmaps
        recent_configmaps=$(kubectl get configmaps -n "$NAMESPACE" \
            -l "claude.ai/worker=$name" \
            --sort-by=.metadata.creationTimestamp \
            -o jsonpath='{range .items[*]}{@.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null | tail -1 || true)
        
        if [[ -n "$recent_configmaps" ]]; then
            local configmap_epoch
            configmap_epoch=$(iso_to_epoch "$recent_configmaps")
            
            if [[ "$configmap_epoch" -gt "$cutoff_epoch" ]]; then
                log_verbose "  Skipping $name: recent ConfigMap activity ($recent_configmaps)"
                ((recent_count++))
                continue
            fi
            
            log_verbose "  ConfigMap activity for $name: $recent_configmaps (stale)"
        else
            log_verbose "  No ConfigMap activity found for $name"
        fi
        
        # This deployment is stale
        stale_deployments+=("$name")
        log_verbose "  Marking $name as stale"
        
    done <<< "$deployments"
    
    log "Found ${#stale_deployments[@]} stale deployments (active: $active_count, recent: $recent_count)"
    
    # Process stale deployments
    if [[ ${#stale_deployments[@]} -eq 0 ]]; then
        log_success "No stale deployments to clean up!"
        return 0
    fi
    
    for deployment in "${stale_deployments[@]}"; do
        if [[ "$DRY_RUN" == "true" ]]; then
            log_warn "[DRY-RUN] Would delete deployment: $deployment"
        else
            log "Deleting deployment: $deployment"
            if kubectl delete deployment "$deployment" -n "$NAMESPACE" --timeout=60s; then
                log_success "Deleted deployment: $deployment"
            else
                log_error "Failed to delete deployment: $deployment"
            fi
        fi
    done
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_warn "DRY-RUN MODE: Use -f/--force to actually delete deployments"
    fi
}

# Main execution
main() {
    log "Claude Worker Deployment Cleanup"
    log "================================"
    log "Namespace: $NAMESPACE"
    log "Grace period: $GRACE_PERIOD_MINUTES minutes"
    log "Mode: $([ "$DRY_RUN" == "true" ] && echo "DRY-RUN" || echo "LIVE")"
    echo
    
    check_kubectl
    find_stale_deployments
}

# Run main function
main