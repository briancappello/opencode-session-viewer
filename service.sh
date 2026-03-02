#!/usr/bin/env bash
# service.sh — Manage the opencode-session-viewer service
#
# Usage: ./service.sh <command>
#
# Commands:
#   start     Start the service
#   stop      Stop the service
#   restart   Restart the service
#   status    Show service status
#   logs      Show recent logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Platform Detection
# ---------------------------------------------------------------------------
PLATFORM="$(uname -s)"
case "$PLATFORM" in
    Linux*)   INIT_SYSTEM="systemd" ;;
    Darwin*)  INIT_SYSTEM="launchd" ;;
    *)
        echo "ERROR: Unsupported platform: $PLATFORM"
        exit 1
        ;;
esac

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  start     Start the service"
    echo "  stop      Stop the service"
    echo "  restart   Restart the service"
    echo "  status    Show service status"
    echo "  logs      Show recent logs"
    exit 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
    usage
fi

COMMAND="$1"

case "$COMMAND" in
    start)
        "${SCRIPT_DIR}/local-deploy/${INIT_SYSTEM}/start.sh"
        ;;
    stop)
        "${SCRIPT_DIR}/local-deploy/${INIT_SYSTEM}/stop.sh"
        ;;
    restart)
        "${SCRIPT_DIR}/local-deploy/${INIT_SYSTEM}/restart.sh"
        ;;
    status)
        "${SCRIPT_DIR}/local-deploy/${INIT_SYSTEM}/status.sh"
        ;;
    logs)
        if [[ "$INIT_SYSTEM" == "systemd" ]]; then
            journalctl --user -u opencode-session-viewer -f
        else
            echo "=== Following logs (Ctrl+C to stop) ==="
            tail -f "${HOME}/Library/Logs/opencode-session-viewer.log" \
                    "${HOME}/Library/Logs/opencode-session-viewer.error.log" 2>/dev/null \
                || echo "No log files found. Has the service been started?"
        fi
        ;;
    *)
        echo "Unknown command: $COMMAND"
        echo ""
        usage
        ;;
esac
