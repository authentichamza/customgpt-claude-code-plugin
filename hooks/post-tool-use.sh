#!/bin/bash
# Post-tool-use hook for RAG Search
#
# Fires only for Write/Edit/NotebookEdit (filtered by matcher in hooks.json).
# Marks the RAG index as potentially stale by touching .rag-search-dirty at
# the project root, but only if this project has an active RAG index.
#
# The pre-prompt.sh (UserPromptSubmit) hook reads this flag and injects a
# refresh reminder into Claude's context at the start of the next prompt.
# The MCP server clears the flag after a successful index_files or refresh_index.

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

if [ -n "$REPO_ROOT" ]; then
  touch "$REPO_ROOT/.rag-search-dirty"
fi
