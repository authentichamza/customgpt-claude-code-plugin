#!/bin/bash
# Post-tool-use hook for RAG Search
#
# After Claude writes or edits files, mark the RAG index as potentially stale
# by touching .rag-search-dirty at the project root.
#
# The pre-prompt.sh (UserPromptSubmit) hook reads this flag and injects a
# refresh reminder into Claude's context at the start of the next prompt.
# The MCP server clears the flag after a successful index_files or refresh_index.

TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
META_FILE="$PWD/.rag-search-meta.json"

# Only trigger on file-writing tools, and only if this project is indexed
if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "NotebookEdit" ]]; then
  if [ -f "$META_FILE" ]; then
    touch "$PWD/.rag-search-dirty"
  fi
fi
