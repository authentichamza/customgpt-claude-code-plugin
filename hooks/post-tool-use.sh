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

META_FILE="$PWD/.rag-search-meta.json"

if [ -f "$META_FILE" ]; then
  touch "$PWD/.rag-search-dirty"
fi
