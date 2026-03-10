#!/bin/bash
# PreToolUse hook for RAG Search
#
# Fires before Read, Glob, and Grep. Looks for .rag-search-meta.json by
# walking UP from the target file's directory — not just $PWD — so it works
# even when Claude's working directory differs from the indexed project root.

TOOL_INPUT=$(cat)

# Extract the file/path being accessed from tool input
TARGET_PATH=$(python3 -c "
import json, sys, os
try:
    data = json.loads('''$TOOL_INPUT''')
    inp = data.get('tool_input', data)
    p = (inp.get('file_path') or inp.get('path') or inp.get('pattern') or '').strip()
    print(p)
except: pass
" 2>/dev/null)

# Fallback: also try $PWD
[ -z "$TARGET_PATH" ] && TARGET_PATH="$PWD"

# Resolve to absolute path
if [[ "$TARGET_PATH" != /* ]]; then
  TARGET_PATH="$PWD/$TARGET_PATH"
fi

# If it's a file, start from its directory; if directory, start there
if [ -f "$TARGET_PATH" ]; then
  SEARCH_DIR=$(dirname "$TARGET_PATH")
else
  SEARCH_DIR="$TARGET_PATH"
fi

# Walk up directory tree to find .rag-search-meta.json
find_meta() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/.rag-search-meta.json" ]; then
      echo "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

REPO_ROOT=$(find_meta "$SEARCH_DIR")
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi

META_FILE="$REPO_ROOT/.rag-search-meta.json"
AGENT_ID=$(grep -o '"agent_id"[[:space:]]*:[[:space:]]*[0-9]*' "$META_FILE" | grep -o '[0-9]*$')
if [ -z "$AGENT_ID" ]; then
  exit 0
fi

# Python determines if the path is indexable using the same rules as server.js
RESULT=$(RAG_TOOL_INPUT="$TOOL_INPUT" RAG_PWD="$REPO_ROOT" python3 << 'PYEOF'
import json, sys, os

SUPPORTED_EXTS = {
    '.js','.mjs','.cjs','.ts','.tsx','.jsx',
    '.py','.go','.rb','.java','.cs','.cpp','.c','.h','.hpp',
    '.rs','.swift','.kt','.kts','.php','.scala','.lua','.pl',
    '.html','.htm','.css','.scss','.sass','.less','.vue','.svelte',
    '.sql','.sh','.bash','.zsh','.fish','.ps1',
    '.yaml','.yml','.json','.jsonc','.toml','.ini','.cfg','.conf','.xml',
    '.md','.mdx','.txt','.rst','.adoc','.tex',
    '.pdf','.docx','.xlsx','.csv','.pptx',
}
EXCLUDED_DIRS = {
    'node_modules','__pycache__','.git','.claude','.github','.gitlab',
    '.vscode','.idea','dist','build','out','.next','coverage','vendor',
    '.terraform','.nyc_output','tmp','temp',
}

try:
    data = json.loads(os.environ.get('RAG_TOOL_INPUT', '{}'))
    inp = data.get('tool_input', data)
    path = (inp.get('file_path') or inp.get('path') or inp.get('pattern') or '').strip()

    if not path:
        sys.exit(0)

    repo_root = os.environ.get('RAG_PWD', '')
    if not os.path.isabs(path) and repo_root:
        path = os.path.join(repo_root, path)

    rel = os.path.relpath(path, repo_root) if repo_root else path
    for part in rel.replace('\\', '/').split('/'):
        clean = part.split('*')[0]
        if clean in EXCLUDED_DIRS:
            sys.exit(0)
        if clean.startswith('.') and clean not in ('.', '..'):
            sys.exit(0)

    if '*' in path or '?' in path:
        print('INDEXED_BROAD')
        sys.exit(0)

    _, ext = os.path.splitext(path)
    if ext.lower() in SUPPORTED_EXTS:
        print('INDEXED_FILE')

except Exception:
    pass
PYEOF
)

case "$RESULT" in
  INDEXED_FILE)
    echo "[RAG Search] This file is in the RAG index (agent_id: $AGENT_ID, repo_root: $REPO_ROOT). You MUST call mcp__rag-search__query(agent_id: $AGENT_ID, question: ...) instead of reading the file. Only fall back to Read if query() returns no result."
    ;;
  INDEXED_BROAD)
    echo "[RAG Search] This project has a RAG index (agent_id: $AGENT_ID, repo_root: $REPO_ROOT). Use mcp__rag-search__query(agent_id: $AGENT_ID, question: ...) to search semantically. Only fall back to Glob/Grep for files added after the last index run."
    ;;
esac

exit 0
