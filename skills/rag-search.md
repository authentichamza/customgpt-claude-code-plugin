---
name: rag-search
description: Semantic search over an indexed repo or document set via CustomGPT.ai RAG. Index code, PDFs, transcripts, contracts, and business docs — then query in plain language with source citations.
triggers:
  - "index this repo"
  - "index this project"
  - "index this folder"
  - "index these files"
  - "index just"
  - "build a RAG"
  - "build a rag"
  - "build RAG from"
  - "search my codebase"
  - "search my project"
  - "search my docs"
  - "search my files"
  - "search across"
  - "find in my project"
  - "find in my codebase"
  - "refresh the index"
  - "re-index"
  - "reindex"
  - "update the index"
  - "add to the index"
  - "add these files to"
  - "what does the code say about"
  - "where is"
  - "look up in my project"
  - "which files"
  - "which contracts"
  - "query my project"
  - "ask my project"
---

# RAG Search Skill

You are an expert at using the CustomGPT.ai RAG Search system to index repositories, document sets, and business files — then answer questions grounded in the user's actual content with source citations.

This plugin solves a core Claude Code limitation: you read files sequentially and run out of context on large projects. RAG Search gives you a persistent, semantically searchable index of every file — so you find what's relevant instead of reading everything.

## MCP Tools

You have access to these tools from the `rag-search` server:

| Tool | Purpose |
|------|---------|
| `validate_api_key` | Check if the stored API key is valid |
| `setup_api_key` | Store and validate a CustomGPT.ai API key |
| `check_limits` | Get account page/document limits and current usage |
| `list_agents` | List all CustomGPT.ai agents in the account |
| `get_agent` | Look up the agent for a repo path (reads .rag-search-meta.json) |
| `create_agent` | Create a new CustomGPT.ai agent and persist its ID |
| `delete_agent` | Permanently delete an agent and all its data |
| `index_files` | Upload files to the agent (respects .gitignore, skips binaries) |
| `index_status` | Poll indexing progress — check when index is ready to query |
| `refresh_index` | Delete only the pages for files under start_path, then re-upload them — keeps the rest of the index intact |
| `add_files` | Add specific files/folders to an existing index |
| `list_pages` | List indexed documents in the knowledge base |
| `delete_page` | Delete a specific indexed document by page ID |
| `get_settings` | Get agent settings (persona, colors, citations, UI strings, etc.) |
| `update_settings` | Update agent settings — only provide fields to change |
| `get_page_metadata` | Get metadata (title, description, URL, image) for a page |
| `update_page_metadata` | Update metadata for a specific indexed document |
| `get_citation` | Resolve a citation ID from a query response into full metadata |
| `get_messages` | List messages in a conversation session |
| `get_message` | Get a single message with citations and feedback |
| `message_feedback` | Submit liked/disliked/neutral feedback on a message |
| `get_message_claims` | Get extracted factual claims from a message for verification |
| `get_trust_score` | Get stakeholder trust analysis for a message |
| `query` | Ask a question, get an AI answer with source citations |

---

## Behavior Rules

### On First Use / No API Key

1. Call `validate_api_key`. If it returns `valid: false`:
2. Show the user:
   ```
   🔑 No CustomGPT.ai API key found.

   Sign up:       https://customgpt.ai/pricing
   Get your key:  https://app.customgpt.ai/profile#api-keys
   API docs:      https://docs.customgpt.ai/reference/api-keys-and-authentication
   ```
3. Call `setup_api_key` with the key the user provides.
4. Call `validate_api_key` again. If still invalid:
   ```
   ❌ API key invalid or expired.
   • Double-check you copied the full key from https://app.customgpt.ai/profile#api-keys
   • Make sure your CustomGPT.ai subscription is active.
   ```
   Do not proceed until the key validates.

---

### On "Index this repo" / "Index this project" / "Build a RAG from this folder"

1. **Validate API key** (step above if needed).
2. Call `get_agent` with the current repo root.
   - If `found: true`: Tell the user an index already exists for this project. Ask:
     ```
     An index already exists for this project (agent ID: 12345, X pages).
     Would you like to:
       1. Re-use it and query directly
       2. Refresh it (delete all and re-index from scratch)
     ```
3. Call `check_limits`. Estimate the file count (you can do a quick `find` or `ls -R`). Warn if it looks like it may exceed the plan:
   ```
   ⚠️ Your plan supports up to N pages. This project contains ~M files.
   Consider indexing a sub-folder only, or upgrading at https://customgpt.ai/pricing
   ```
4. If no existing agent (or user wants a fresh index): Call `create_agent` with a sensible project name (repo folder name is a good default).
5. Call `index_files` with `repo_root` and `start_path` both set to the repo root.
6. Show progress:
   ```
   📂 Uploading files... (X/Y uploaded)
   ```
7. After `index_files` completes, call `index_status` and poll until `ready: true`:
   ```
   ⏳ Indexing in progress... (X pages indexed)
   ✅ Index ready. Y files indexed.
   ```
8. Confirm to the user:
   ```
   ✅ Your project is indexed and ready to query.
   Try: "how does authentication work?" or "where is the database connection configured?"
   ```

---

### On "Index just the src/ folder" / "Index this specific path" (Partial Indexing)

Same flow as full indexing, but:
- Resolve the path relative to the repo root.
- Pass the resolved absolute path as `start_path` to `index_files`.
- Only index that subtree.

---

### On "Index these files" / "Index docs/architecture.pdf and src/auth/"

Same flow, but call `index_files` once per path, or use `add_files` if an agent already exists.

---

### On "Refresh the index" / "Re-index from scratch" / "Update the index"

1. Call `refresh_index` with `repo_root`, `agent_id`, and `start_path`.
   - This deletes **only the pages matching files under start_path**, then re-uploads them. Pages from other parts of the index are untouched.
2. Show progress as above.

---

### On "Add the new migrations/ folder" / "Add src/payments.ts to the index"

1. Resolve the paths.
2. Call `add_files` with the agent_id and the list of paths.
3. Confirm: "✅ X files added to the index."
   No full re-index needed.

---

### On a Plain-Language Question (Search / Query)

When the user asks something that should be answered from their project:

1. Call `get_agent` to find the agent for the current repo root.
   - If `found: false`: Prompt the user to index first:
     ```
     No index found for this project. Say "index this repo" to create one.
     ```
2. Call `query` with the `agent_id` and the user's question.
3. Present the answer, then show sources:
   ```
   📄 Sources:
   - src/auth/session.ts (lines 34–67)
   - docs/architecture.pdf (page 5)
   - https://example.com/some-page
   ```
4. For follow-up questions, pass the same `session_id` back to `query` to maintain conversation context.
5. If `citations` is empty or the answer says it couldn't find relevant content:
   ```
   I couldn't find relevant content in the indexed project.
   Make sure the relevant files are indexed. Say "refresh the index" if files have changed.
   ```

---

### Nothing to Index

If `index_files` returns `uploaded: 0`:
```
📭 Nothing to index. No eligible files found after applying .gitignore and exclusion rules.
Check that the path exists and contains supported file types.
```

---

### On API Errors

When a tool returns `error: true`:
```
❌ Error [status]: [message]
```
Suggest:
- Check the API key: `validate_api_key`
- Check plan limits: `check_limits`
- Verify the project/agent ID is correct

---

## File Inclusion Rules

**Always indexed** (when eligible):
- Code: `.js`, `.ts`, `.tsx`, `.jsx`, `.py`, `.go`, `.rb`, `.java`, `.cs`, `.cpp`, `.rs`, `.swift`, `.kt`, `.php`, `.html`, `.css`, `.sql`, `.sh`, `.yaml`, `.json`, `.toml`, `.xml`, `.md`, `.txt`, and more
- Documents: `.pdf`, `.docx`, `.xlsx`, `.csv`, `.pptx`

**Always excluded:**
- Dotfiles and dot-folders: `.env`, `.git/`, `.claude/`, `.github/`, `.vscode/`, `node_modules/`, etc.
- Files matched by `.gitignore`
- Binaries: images, fonts, compiled artifacts, archives (`.exe`, `.zip`, `.png`, `.woff`, etc.)
- Build/cache dirs: `dist/`, `build/`, `__pycache__/`, `.next/`, `coverage/`

---

## Multiple Projects

Each Claude Code project maps to its own CustomGPT.ai agent. The mapping is stored in `.rag-search-meta.json` at the repo root. Switching directories switches the active index automatically — no re-explaining context.
