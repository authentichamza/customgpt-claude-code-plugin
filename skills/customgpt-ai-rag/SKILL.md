---
name: customgpt-ai-rag
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

You have access to these tools from the `customgpt-ai-rag` server:

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
| `refresh_index` | Delete pages for specific files (`paths`) or a directory (`start_path`), re-upload them, and verify `index_status=ok` |
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
| `check_freshness` | Compare current file mtimes against the indexed manifest — returns files changed since last index |
| `query` | Ask a question, get an AI answer with source citations |

---

## Behavior Rules

### Critical Rules (Never Violate)

- **One agent per folder.** Each local repo/folder has exactly one CustomGPT.ai agent, identified by `.rag-search-meta.json` at that folder's root.
- **`list_agents` is only for explicit user requests** like "show me my agents". Never call it as a step in indexing or querying workflows.
- **Never call `get_agent`, `list_agents`, or `create_agent` before indexing.** The indexing tools (`index_files`, `add_files`, `refresh_index`) auto-resolve or create the agent from `repo_root`. Just provide `repo_root` and the paths — the server handles everything else.
- **How to determine `repo_root`**: Use the Git repo root of the files being indexed, or the parent directory of the files. Never skip this — resolve it before calling any indexing tool.
- **After indexing, always use `query` for content questions.** When `index_files` or `add_files` returns an `agent_id` in this session, use that `agent_id` with `query` for any follow-up question about those files. Do NOT use Read/Glob/Grep — the files are now in the index.
- **When a `[RAG Search]` context line is present** (injected by the pre-prompt hook), you MUST call `query` before using any file tool. The hook tells you the `agent_id` and `repo_root` directly — use them.
- **"What does X file say?" = call `query`**, not `Read`. Any question about file content when a RAG index exists must go through `query` first.
- **Always call `check_freshness` before `query`.** Never call `query` without first calling `check_freshness(repo_root)`. If `stale_files` is non-empty, call `refresh_index` with `paths: stale_files` before querying. No exceptions — skipping this returns stale results.

### Proactive RAG Usage (Auto-mode)

You do not need to wait for the user to ask you to use RAG search. Follow these rules automatically:

#### Routing logic — which tool to use

Not all files in a project are necessarily indexed. Use this decision tree:

| Situation | Action |
|---|---|
| Question about codebase/docs | Call `check_freshness` → if stale call `refresh_index(paths: stale_files)` → then `query`. |
| About to `Read` a specific file | Check if the `[RAG Search] PreToolUse` hook fired. If yes, try `query` first with a targeted question about that file's content. Fall back to `Read` only if `query` returns nothing relevant. |
| About to `Glob`/`Grep` broadly | Use `query` first — it searches indexed files semantically and is faster. Fall back to Glob/Grep for files not yet in the index (new files, excluded paths). |
| File is in `node_modules`, `dist`, `build`, `.git`, or other excluded dirs | Use file tools directly — these are never indexed. |
| File has a binary/unsupported extension (image, font, compiled artifact) | Use file tools directly — these are never indexed. |
| File was created or modified after the last index run | Use file tools directly or trigger `refresh_index` first, then `query`. |

#### Concrete rules

1. **Before exploring the codebase** — call `get_agent` with `$PWD`. If `found: true`, call `check_freshness` with `repo_root`. If stale files exist, call `refresh_index` first. Then route through `query` for any content question. Only use Glob/Grep/Read/Explore for content that query() cannot reach.

2. **When the `[RAG Search]` context line is injected by hooks** — follow it immediately:
   - `⚠️ stale index` → call `refresh_index` before querying
   - `PreToolUse` intercept on a specific file → try `query` first, fall back to the file tool if query returns nothing

3. **When `query` returns no useful result** — do not retry with the same question. Fall back to file tools for that specific content. The file may not be indexed yet.

4. **Mixed directories** — some files indexed, some not. Use `query` for the indexed portion and file tools for the rest. Both can be used in the same response.

5. **Never ask the user "should I use RAG?"** — route automatically based on these rules.

---

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
2. Call `check_limits`. Warn if file count may exceed the plan:
   ```
   ⚠️ Your plan supports up to N pages. This project contains ~M files.
   Consider indexing a sub-folder only, or upgrading at https://customgpt.ai/pricing
   ```
3. Call `index_files` with `repo_root` and `start_path` both set to the repo root. **Do not call `get_agent`, `list_agents`, or `create_agent` first** — `index_files` automatically finds the existing agent for this folder or creates a new one named after the folder.
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

### On "Index these files" / "Index docs/architecture.pdf and src/auth/" / "Index file1.md and file2.md"

1. **Validate API key** (if needed).
2. Resolve the `repo_root` (Git root of the files or their parent directory).
3. Resolve all mentioned file/folder paths to absolute paths.
4. Call `add_files` **once** with `repo_root` and ALL paths in the `paths` array. **Never call `index_files` once per file** — `add_files` takes an array and handles multiple paths in a single call.
5. After `add_files` returns an `agent_id`, use that `agent_id` with `query` for any follow-up questions about those files.
6. Confirm: "✅ X files indexed. You can now ask questions about them."

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
2. Call `check_freshness` with the `repo_root`.
   - If `stale_files` is non-empty: call `refresh_index` with `repo_root`, `agent_id`, and `paths = stale_files` (NOT `start_path`) — this refreshes only the changed files. Check `indexed_ok` in the response to confirm they were indexed successfully before querying.
3. Call `query` with the `agent_id` and the user's question.
4. Present the answer, then show sources:
   ```
   📄 Sources:
   - src/auth/session.ts (lines 34–67)
   - docs/architecture.pdf (page 5)
   - https://example.com/some-page
   ```
5. For follow-up questions, pass the same `session_id` back to `query` to maintain conversation context.
6. If `citations` is empty or the answer says it couldn't find relevant content:
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
