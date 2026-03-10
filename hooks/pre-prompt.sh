#!/bin/bash
# UserPromptSubmit hook for RAG Search
#
# Injected as context before every Claude prompt when a RAG index exists.
# Walks UP from $PWD to find .rag-search-meta.json so it works even when
# Claude's working directory is a parent of the indexed project.

# Walk up from $PWD to find the nearest .rag-search-meta.json
REPO_ROOT=""
dir="$PWD"
while [ "$dir" != "/" ]; do
  if [ -f "$dir/.rag-search-meta.json" ]; then
    REPO_ROOT="$dir"
    break
  fi
  dir=$(dirname "$dir")
done

if [ -z "$REPO_ROOT" ]; then
  exit 0
fi

META_FILE="$REPO_ROOT/.rag-search-meta.json"
AGENT_ID=$(grep -o '"agent_id"[[:space:]]*:[[:space:]]*[0-9]*' "$META_FILE" | grep -o '[0-9]*$')

if [ -z "$AGENT_ID" ]; then
  exit 0
fi

DIRTY_FILE="$REPO_ROOT/.rag-search-dirty"

if [ -f "$DIRTY_FILE" ]; then
  echo "[RAG Search] ⚠️  Files were modified since the index was last built. Call mcp__rag-search__refresh_index (agent_id: $AGENT_ID, repo_root: $REPO_ROOT, start_path: $REPO_ROOT) before querying — results may be stale otherwise."
fi

echo "[RAG Search] RAG index active (agent_id: $AGENT_ID, repo_root: $REPO_ROOT). REQUIRED: call mcp__rag-search__query(agent_id: $AGENT_ID, question: ...) for ANY question about file contents, code, or docs — do NOT use Read/Glob/Grep for content questions. Only use file tools for files added after indexing, binaries, or excluded dirs (node_modules, dist, .git)."
