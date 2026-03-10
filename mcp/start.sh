#!/bin/bash
# Launcher for the RAG Search MCP server.
#
# Resolves its own directory so it works regardless of where the plugin is
# installed, then auto-installs npm deps on first run before starting the server.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$DIR/node_modules" ]; then
  echo "[RAG Search] Installing dependencies..." >&2
  cd "$DIR" && npm install --silent --prefer-offline 2>&1 >&2
fi

exec node "$DIR/server.js"
