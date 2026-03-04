#!/bin/bash
# Post-tool-use hook for RAG Search
#
# After Claude edits or writes files, remind the user that the index may be stale
# so they know to refresh it when ready.

TOOL_NAME="${CLAUDE_TOOL_NAME:-}"

# Only trigger on file-writing tools
if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "NotebookEdit" ]]; then
  echo ""
  echo "💡 RAG Search: Files were modified. Your index may be out of date."
  echo "   Say \"refresh the index\" or \"add the changed files to the index\" when ready."
  echo ""
fi
