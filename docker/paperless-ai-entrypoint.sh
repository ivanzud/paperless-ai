#!/usr/bin/env bash

set -euo pipefail

APP_UID="${PUID:-1000}"
APP_GID="${PGID:-1000}"

if [[ ! "$APP_UID" =~ ^[0-9]+$ ]] || [[ ! "$APP_GID" =~ ^[0-9]+$ ]]; then
  echo "PUID and PGID must be numeric" >&2
  exit 64
fi

if [[ "$APP_UID" == "0" ]] || [[ "$APP_GID" == "0" ]]; then
  echo "PUID and PGID must be non-zero" >&2
  exit 64
fi

if [[ "$(id -u)" -eq 0 ]]; then
  APP_HOME="/tmp/paperless-ai-home"
  mkdir -p \
    "$APP_HOME/.cache/huggingface" \
    "$APP_HOME/.pm2" \
    "$APP_HOME/nltk_data"
  chown -R "$APP_UID:$APP_GID" \
    "$APP_HOME" \
    /app/data \
    /app/logs \
    /app/public/images \
    /app/OPENAPI

  export HOME="$APP_HOME"
  export HF_HOME="$APP_HOME/.cache/huggingface"
  export NLTK_DATA="$APP_HOME/nltk_data"
  export PM2_HOME="$APP_HOME/.pm2"
  export XDG_CACHE_HOME="$APP_HOME/.cache"
  exec gosu "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
