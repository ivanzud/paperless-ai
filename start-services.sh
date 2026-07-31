#!/usr/bin/env bash
# start-services.sh - Script to start both Node.js and Python services

set -u

APP_DIR="${PAPERLESS_AI_APP_DIR:-/app}"
PYTHON_BIN="${PYTHON_BIN:-python}"
PM2_RUNTIME_BIN="${PM2_RUNTIME_BIN:-pm2-runtime}"
RAG_STARTUP_DELAY_SECONDS="${RAG_STARTUP_DELAY_SECONDS:-2}"
RAG_SERVICE_URL="${RAG_SERVICE_URL:-http://localhost:8000}"
PYTHON_PID=""
NODE_PID=""

case "${RAG_SERVICE_ENABLED:-true}" in
  true|TRUE|yes|YES|1|on|ON)
    RAG_SERVICE_ENABLED="true"
    ;;
  *)
    RAG_SERVICE_ENABLED="false"
    ;;
esac

export RAG_SERVICE_URL
export RAG_SERVICE_ENABLED
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"

cleanup() {
  local exit_code=$?

  trap - EXIT INT TERM
  if [[ -n "$NODE_PID" ]] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill -TERM "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  if [[ -n "$PYTHON_PID" ]] && kill -0 "$PYTHON_PID" 2>/dev/null; then
    kill -TERM "$PYTHON_PID" 2>/dev/null || true
    wait "$PYTHON_PID" 2>/dev/null || true
  fi

  exit "$exit_code"
}
trap cleanup EXIT INT TERM

cd "$APP_DIR"

if [[ "$RAG_SERVICE_ENABLED" == "true" ]]; then
  # Activate Python only when the optional RAG service is enabled.
  source "$APP_DIR/venv/bin/activate"
  echo "Starting Python RAG service..."
  "$PYTHON_BIN" main.py --host 127.0.0.1 --port 8000 --initialize &
  PYTHON_PID=$!

  sleep "$RAG_STARTUP_DELAY_SECONDS"
  if ! kill -0 "$PYTHON_PID" 2>/dev/null; then
    echo "Python RAG service exited during startup" >&2
    if wait "$PYTHON_PID"; then
      exit 1
    else
      exit $?
    fi
  fi
  echo "Python RAG service started with PID: $PYTHON_PID"
else
  echo "Python RAG service disabled"
fi

echo "Starting Node.js Paperless-AI service..."
"$PM2_RUNTIME_BIN" ecosystem.config.js &
NODE_PID=$!
wait "$NODE_PID"
