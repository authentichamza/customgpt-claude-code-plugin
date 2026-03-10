# Test Suite — CustomGPT.ai RAG Search for Claude Code

**Plugin version:** 1.0.0
**How to use this document:** Work through each section in order. Check ✅ when a test passes, ✗ when it fails, and note any unexpected output in the Notes column.

---

## Prerequisites

Before running any tests:

- [ ] `cd mcp && npm install` completes without errors
- [ ] Node.js ≥ 18 is installed (`node --version`)
- [ ] You have a valid CustomGPT.ai API key from https://app.customgpt.ai/profile#api-keys
- [ ] You have a second **invalid** API key ready (e.g. `sk-invalid-test-key-1234`)
- [ ] Claude Code is running in this project directory
- [ ] The plugin is loaded: `claude plugin add . --project` (or equivalent)

**Test repos to prepare:**

```bash
# Small test repo (create once, reuse throughout)
mkdir -p /tmp/test-repo/{src,docs,dist,node_modules}
echo "function login(user, pass) { return db.query(user, pass); }" > /tmp/test-repo/src/auth.js
echo "const DB_URL = process.env.DATABASE_URL;" > /tmp/test-repo/src/db.js
echo "export function fetchUser(id) { return api.get('/users/' + id); }" > /tmp/test-repo/src/api.ts
echo "# Architecture\n\nThe app uses JWT for authentication." > /tmp/test-repo/docs/architecture.md
echo "Pricing: Basic $10/mo, Pro $50/mo" > /tmp/test-repo/docs/pricing.txt
echo "compiled binary data" > /tmp/test-repo/dist/bundle.js
echo "SECRET_KEY=abc123" > /tmp/test-repo/.env
echo "node_modules/" > /tmp/test-repo/.gitignore
echo "dist/" >> /tmp/test-repo/.gitignore
touch /tmp/test-repo/node_modules/fake-package.js

# Empty repo (for nothing-to-index test)
mkdir -p /tmp/empty-repo

# Binary-only repo
mkdir -p /tmp/binary-repo
cp /usr/bin/ls /tmp/binary-repo/mybinary  # or any binary file
```

---

## Section 1 — MCP Server Startup

| # | Test | Command | Expected | Pass? | Notes |
|---|------|---------|----------|-------|-------|
| 1.1 | Server starts | `cd mcp && node server.js` | Process starts, no crash, waits for stdio | ☐ | |
| 1.2 | Dependencies present | `cd mcp && node -e "import('./server.js')"` | No `MODULE_NOT_FOUND` errors | ☐ | |
| 1.3 | `ignore` package available | `cd mcp && node -e "import('ignore').then(m => console.log('ok'))"` | Prints `ok` | ☐ | |

---

## Section 2 — Auth: `validate_api_key`

### 2A — No key stored

| # | Test | Setup | Expected Output | Pass? | Notes |
|---|------|-------|-----------------|-------|-------|
| 2.1 | No key, no env var | Delete `~/.claude/rag-search-config.json` if it exists. Unset `CUSTOMGPT_API_KEY` | `{ "valid": false, "message": "No API key stored..." }` | ☐ | |
| 2.2 | Invalid key in config | Write `{"apiKey":"sk-invalid-000"}` to `~/.claude/rag-search-config.json` | `{ "valid": false, "status": 401, ... }` | ☐ | |
| 2.3 | Invalid key in env var | `CUSTOMGPT_API_KEY=bad-key node server.js` | `{ "valid": false }` | ☐ | |

### 2B — Valid key

| # | Test | Setup | Expected Output | Pass? | Notes |
|---|------|-------|-----------------|-------|-------|
| 2.4 | Valid key in config file | Write real key to config | `{ "valid": true, "email": "your@email.com" }` | ☐ | |
| 2.5 | Valid key in env var | `CUSTOMGPT_API_KEY=<real_key>` | `{ "valid": true, "email": "..." }` | ☐ | |
| 2.6 | Env var takes precedence over config | Set env var to valid key, config has invalid key | Returns `valid: true` (uses env var) | ☐ | |

---

## Section 3 — Auth: `setup_api_key`

| # | Test | Input | Expected Output | Pass? | Notes |
|---|------|-------|-----------------|-------|-------|
| 3.1 | Store valid key | `api_key: "<real_key>"` | `{ "stored": true, "valid": true, "email": "..." }` | ☐ | |
| 3.2 | Config file created | After 3.1 | `~/.claude/rag-search-config.json` exists with `apiKey` field | ☐ | |
| 3.3 | Store invalid key | `api_key: "sk-garbage"` | `{ "stored": true, "valid": false, "message": "Key stored but validation failed..." }` | ☐ | |
| 3.4 | Overwrite existing key | Call with new valid key after 3.3 | `{ "stored": true, "valid": true }`, config file updated | ☐ | |
| 3.5 | Persists across restarts | Set key, restart server, call `validate_api_key` | `{ "valid": true }` — config is read from disk | ☐ | |

---

## Section 4 — Account: `check_limits`

| # | Test | Setup | Expected Output | Pass? | Notes |
|---|------|-------|-----------------|-------|-------|
| 4.1 | Valid key | Real key stored | Returns `pages_used`, `pages_limit`, `pages_remaining`, `projects_used`, `projects_limit`, `projects_remaining` — all numbers | ☐ | |
| 4.2 | All fields present | Same | No field is `undefined` or missing | ☐ | |
| 4.3 | Invalid key | Invalid key stored | Returns `{ "error": true, "status": 401 }` | ☐ | |
| 4.4 | `pages_remaining` is correct | Same | `pages_remaining === pages_limit - pages_used` | ☐ | |

---

## Section 5 — Agent Lookup: `get_agent`

### 5A — No meta file

| # | Test | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 5.1 | No meta file | `repo_root: "/tmp/test-repo"` (no `.rag-search-meta.json`) | `{ "found": false }` | ☐ | |
| 5.2 | Non-existent repo root | `repo_root: "/tmp/does-not-exist"` | `{ "found": false }` — no crash | ☐ | |

### 5B — Stale meta file

| # | Test | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 5.3 | Meta points to deleted agent | Write `{"agent_id": 999999999}` to `/tmp/test-repo/.rag-search-meta.json` | `{ "found": false, "stale": true, "message": "Stored agent ID no longer exists..." }` | ☐ | |

### 5C — Valid meta file (requires an agent to exist — run after Section 6)

| # | Test | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 5.4 | Valid agent exists | Real `.rag-search-meta.json` from `create_agent` | `{ "found": true, "agent_id": N, "name": "...", "pages_count": N, "index_status": "..." }` | ☐ | |
| 5.5 | Returns name from server | Same | `name` matches what was set in `create_agent` | ☐ | |

---

## Section 6 — Agent Creation: `create_agent`

| # | Test | Input | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 6.1 | Create agent | `repo_root: "/tmp/test-repo"`, `project_name: "test-rag-repo"` | `{ "agent_id": N, "name": "test-rag-repo" }` where N is a positive integer | ☐ | |
| 6.2 | Meta file written | After 6.1 | `/tmp/test-repo/.rag-search-meta.json` exists with `agent_id`, `project_name`, `created_at` | ☐ | |
| 6.3 | Meta JSON is valid | After 6.1 | `cat /tmp/test-repo/.rag-search-meta.json` — valid JSON, all 3 fields present | ☐ | |
| 6.4 | Agent visible in dashboard | After 6.1 | Log in to https://app.customgpt.ai — agent "test-rag-repo" appears | ☐ | |
| 6.5 | Invalid key → error | No key stored | Returns `{ "error": true, "status": 401 }` — meta file NOT written | ☐ | |

---

## Section 7 — File Collection Logic

These tests verify the server's internal `collectFiles` function via `index_files` behavior. Observe which files end up uploaded vs. skipped.

### 7A — Inclusions

| # | Test | File type | Expected: indexed? | Pass? | Notes |
|---|------|-----------|--------------------|-------|-------|
| 7.1 | JavaScript | `src/auth.js` | ✅ Yes | ☐ | |
| 7.2 | TypeScript | `src/api.ts` | ✅ Yes | ☐ | |
| 7.3 | Markdown | `docs/architecture.md` | ✅ Yes | ☐ | |
| 7.4 | Plain text | `docs/pricing.txt` | ✅ Yes | ☐ | |
| 7.5 | PDF | Create `/tmp/test-repo/docs/manual.pdf` (copy any PDF) | ✅ Yes | ☐ | |
| 7.6 | CSV | `echo "col1,col2\nval1,val2" > /tmp/test-repo/data.csv` | ✅ Yes | ☐ | |

### 7B — Exclusions

| # | Test | File / Dir | Expected: excluded? | Pass? | Notes |
|---|------|------------|---------------------|-------|-------|
| 7.7 | `.gitignore` rule: `dist/` | `/tmp/test-repo/dist/bundle.js` | ✅ Excluded | ☐ | |
| 7.8 | `.gitignore` rule: `node_modules/` | `/tmp/test-repo/node_modules/fake-package.js` | ✅ Excluded | ☐ | |
| 7.9 | Dotfile: `.env` | `/tmp/test-repo/.env` | ✅ Excluded | ☐ | |
| 7.10 | Dot-folder: `.git` | Create `/tmp/test-repo/.git/config` | ✅ Excluded | ☐ | |
| 7.11 | Binary ext: `.png` | `touch /tmp/test-repo/logo.png` | ✅ Excluded | ☐ | |
| 7.12 | Binary ext: `.exe` | `touch /tmp/test-repo/app.exe` | ✅ Excluded | ☐ | |
| 7.13 | Unsupported ext: `.woff` | `touch /tmp/test-repo/font.woff` | ✅ Excluded | ☐ | |
| 7.14 | Build dir: `dist/` (hardcoded) | Files in `dist/` (even without `.gitignore`) | ✅ Excluded | ☐ | |
| 7.15 | `node_modules/` (hardcoded) | Files in `node_modules/` | ✅ Excluded | ☐ | |

### 7C — Empty / edge cases

| # | Test | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 7.16 | All files excluded | Index `/tmp/empty-repo` | `{ "uploaded": 0, "message": "No eligible files found..." }` | ☐ | |
| 7.17 | Binary-only dir | Index `/tmp/binary-repo` | `{ "uploaded": 0, "message": "No eligible files found..." }` | ☐ | |
| 7.18 | Single file as start_path | `start_path: "/tmp/test-repo/src/auth.js"` | Only `auth.js` uploaded, `total_found: 1` | ☐ | |
| 7.19 | Non-existent path | `start_path: "/tmp/does-not-exist/file.js"` | `{ "uploaded": 0, "message": "Path not found: ..." }` | ☐ | |

---

## Section 8 — Indexing: `index_files`

| # | Test | Input | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 8.1 | Full repo index | `repo_root + start_path = "/tmp/test-repo"`, real `agent_id` | `total_found > 0`, `uploaded > 0`, `failed: 0` | ☐ | |
| 8.2 | Partial index — subfolder | `start_path: "/tmp/test-repo/src"` | Only files under `src/` uploaded | ☐ | |
| 8.3 | Partial index — single file | `start_path: "/tmp/test-repo/docs/architecture.md"` | `total_found: 1`, `uploaded: 1` | ☐ | |
| 8.4 | `failed_files` reported | Make one file unreadable: `chmod 000 /tmp/test-repo/src/db.js` | `failed: 1`, `failed_files: ["src/db.js"]` — restore with `chmod 644` | ☐ | |
| 8.5 | Success message | `failed: 0` | `message` contains "✅ X files uploaded successfully." | ☐ | |
| 8.6 | Partial failure message | Some files failed | `message` contains "⚠️ X uploaded, Y failed." | ☐ | |
| 8.7 | Invalid agent_id | `agent_id: 999999999` | `{ "error": true }` or all files in `failed_files` | ☐ | |

---

## Section 9 — Index Status: `index_status`

| # | Test | Input | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 9.1 | After uploading | Real `agent_id` | Returns `status`, `pages_count`, `is_chat_active`, `ready` (boolean) | ☐ | |
| 9.2 | `ready` field type | Same | `ready` is boolean (`true` or `false`), not string | ☐ | |
| 9.3 | Eventually becomes ready | Poll every 5s after `index_files` | `ready: true` within a reasonable time (< 2 min for small repo) | ☐ | |
| 9.4 | Invalid agent_id | `agent_id: 999999999` | `{ "error": true, "status": 404 }` | ☐ | |

---

## Section 10 — Add Files: `add_files`

| # | Test | Input | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 10.1 | Add single file | `paths: ["/tmp/test-repo/docs/pricing.txt"]`, real `agent_id` | `total_found: 1`, `uploaded: 1`, message contains "✅ Added 1 files..." | ☐ | |
| 10.2 | Add subfolder | `paths: ["/tmp/test-repo/src"]` | `total_found` = number of eligible files in `src/`, `uploaded` matches | ☐ | |
| 10.3 | Add multiple paths | `paths: ["/tmp/test-repo/src/auth.js", "/tmp/test-repo/docs"]` | Both paths processed, counts added together | ☐ | |
| 10.4 | Non-existent path in list | `paths: ["/tmp/test-repo/src/auth.js", "/tmp/nonexistent"]` | Non-existent path skipped, valid path uploaded | ☐ | |
| 10.5 | All paths non-existent | `paths: ["/tmp/nonexistent1", "/tmp/nonexistent2"]` | `{ "uploaded": 0, "message": "No eligible files found..." }` | ☐ | |

---

## Section 11 — Refresh Index: `refresh_index`

| # | Test | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 11.1 | Clears and re-indexes | Agent with existing pages, `repo_root` + `start_path` pointing to test repo | `deleted > 0`, `uploaded > 0`, message contains "🔄 Cleared X old pages. Re-uploaded Y files." | ☐ | |
| 11.2 | `deleted` count matches prior pages | Check `index_status.pages_count` before refresh, compare to `deleted` | `deleted ≈ pages_count` from before | ☐ | |
| 11.3 | New pages appear after refresh | Call `index_status` after refresh | `pages_count > 0` | ☐ | |
| 11.4 | Agent with 0 pages | Agent with no docs uploaded | `deleted: 0`, still re-indexes correctly | ☐ | |
| 11.5 | Non-existent start_path | `start_path: "/tmp/nonexistent"` | `{ "deleted": N, "uploaded": 0, "message": "Path not found after clearing..." }` | ☐ | |

---

## Section 12 — Query: `query`

### 12A — Basic query

| # | Test | Input | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 12.1 | Simple question | `question: "how does authentication work?"`, real `agent_id` | Returns `answer` (non-empty string), `session_id`, `citations` array | ☐ | |
| 12.2 | Answer is grounded | Question about content in `src/auth.js` | Answer references authentication/login/db content from the file | ☐ | |
| 12.3 | Citations present | Same | `citations` array has at least 1 entry with `title` field | ☐ | |
| 12.4 | `session_id` returned | Same | `session_id` is a non-empty string | ☐ | |

### 12B — Follow-up conversation

| # | Test | Input | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 12.5 | Follow-up with same session | Use `session_id` from 12.1, ask follow-up question | Answer is contextually aware of first question | ☐ | |
| 12.6 | New session without session_id | Same question, no `session_id` | New `session_id` returned | ☐ | |

### 12C — Edge cases

| # | Test | Input | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 12.7 | Question about something not indexed | `question: "tell me about quantum physics"` | Answer is either off-topic or returns no relevant citations | ☐ | |
| 12.8 | Very long question | 500+ char question | No error — returns answer | ☐ | |
| 12.9 | Invalid agent_id | `agent_id: 999999999` | `{ "error": true }` | ☐ | |
| 12.10 | Empty question | `question: ""` | Either returns generic response or API error — no server crash | ☐ | |

---

## Section 13 — Skill Triggers (Natural Language in Claude Code)

Type each phrase exactly as shown into Claude Code and verify the skill activates and follows the correct behavior flow.

### 13A — Indexing triggers

| # | Phrase | Expected behavior | Pass? | Notes |
|---|--------|-------------------|-------|-------|
| 13.1 | `index this repo` | Runs full index flow: validate key → get_agent → check_limits → create/reuse agent → index_files → poll status → confirm | ☐ | |
| 13.2 | `index this project` | Same flow | ☐ | |
| 13.3 | `build a RAG from this folder` | Same flow | ☐ | |
| 13.4 | `index just the src/ folder` | Partial index flow — only `src/` subtree uploaded | ☐ | |
| 13.5 | `index docs/architecture.md` | Single file indexed | ☐ | |
| 13.6 | `index these files` | Asks which files or uses context | ☐ | |

### 13B — Query triggers

| # | Phrase | Expected behavior | Pass? | Notes |
|---|--------|-------------------|-------|-------|
| 13.7 | `how does authentication work in this project?` | Calls `get_agent` then `query`, returns answer + sources | ☐ | |
| 13.8 | `where is the database connection configured?` | Same | ☐ | |
| 13.9 | `search my codebase for payment handling` | Calls `query` with search term | ☐ | |
| 13.10 | `find in my project: JWT` | Calls `query` | ☐ | |
| 13.11 | `what does the code say about error handling?` | Calls `query` | ☐ | |
| 13.12 | `which files handle user authentication?` | Calls `query` | ☐ | |

### 13C — Refresh / update triggers

| # | Phrase | Expected behavior | Pass? | Notes |
|---|--------|-------------------|-------|-------|
| 13.13 | `refresh the index` | Asks for confirmation → calls `refresh_index` | ☐ | |
| 13.14 | `re-index from scratch` | Same | ☐ | |
| 13.15 | `reindex` | Same | ☐ | |
| 13.16 | `update the index` | Same | ☐ | |

### 13D — Add files triggers

| # | Phrase | Expected behavior | Pass? | Notes |
|---|--------|-------------------|-------|-------|
| 13.17 | `add the new migrations/ folder to the index` | Resolves path, calls `add_files` — no full re-index | ☐ | |
| 13.18 | `add src/payments.ts to the index` | Single file added | ☐ | |

---

## Section 14 — First-Use API Key Flow (End-to-End)

Run this with NO key stored and NO env var set.

| # | Step | What to say / do | Expected | Pass? | Notes |
|---|------|-----------------|----------|-------|-------|
| 14.1 | Trigger indexing with no key | `index this repo` | Claude shows sign-up URL, key URL, and docs URL | ☐ | |
| 14.2 | Sign-up URL shown | Same | `https://customgpt.ai/pricing` appears | ☐ | |
| 14.3 | Key URL shown | Same | `https://app.customgpt.ai/profile#api-keys` appears | ☐ | |
| 14.4 | Docs URL shown | Same | `https://docs.customgpt.ai/reference/api-keys-and-authentication` appears | ☐ | |
| 14.5 | Provide invalid key | Give garbage key when prompted | Error shown: "API key invalid or expired." — flow does NOT continue to indexing | ☐ | |
| 14.6 | Provide valid key | Give real key | Stored, validated, flow continues to indexing | ☐ | |
| 14.7 | Key persists after restart | Restart Claude Code, try indexing again | No key prompt — uses stored key | ☐ | |

---

## Section 15 — Existing Agent Detection

| # | Step | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 15.1 | Second "index this repo" | `.rag-search-meta.json` already exists from a previous run | Claude detects existing agent, shows agent ID + page count, asks: re-use or refresh? | ☐ | |
| 15.2 | User chooses re-use | Reply "1" or "re-use" | No new agent created — proceeds to query flow | ☐ | |
| 15.3 | User chooses refresh | Reply "2" or "refresh" | Calls `refresh_index` with confirmation | ☐ | |
| 15.4 | Stale meta file | Meta points to deleted agent | Shows stale warning, offers to create a new agent | ☐ | |

---

## Section 16 — Plan Limit Warning

| # | Test | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 16.1 | Limit check runs before indexing | Any `index this repo` trigger | Claude calls `check_limits` before calling `create_agent` or `index_files` | ☐ | |
| 16.2 | Warning shown when near limit | Manually simulate: note your `pages_limit` value; create a repo with more files than remaining pages | Warning shown: "⚠️ Your plan supports up to N pages. This project contains ~M files." | ☐ | |
| 16.3 | Upgrade URL in warning | Same | `https://customgpt.ai/pricing` appears in warning | ☐ | |

---

## Section 17 — Query: No Index Found

| # | Test | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 17.1 | Query before indexing | Delete `.rag-search-meta.json`, then ask a question | Claude detects no index, tells user to run "index this repo" first | ☐ | |
| 17.2 | Message is clear | Same | Message mentions "index this repo" or "index this project" | ☐ | |

---

## Section 18 — Source Citations Display

| # | Test | Expected | Pass? | Notes |
|---|------|----------|-------|-------|
| 18.1 | Sources shown after answer | After any `query` that returns citations | Claude displays `📄 Sources:` section with file names | ☐ | |
| 18.2 | File names shown | Same | At least one citation shows a recognizable filename from the indexed repo | ☐ | |
| 18.3 | No citations case handled | Query returns empty `citations: []` | Claude says "I couldn't find relevant content..." with instructions to re-index | ☐ | |

---

## Section 19 — Refresh: Confirmation Gate

| # | Test | What to say | Expected | Pass? | Notes |
|---|------|-------------|----------|-------|-------|
| 19.1 | Confirmation prompt shown | `refresh the index` | Claude asks "⚠️ This will delete all indexed content and re-index from scratch. Continue?" | ☐ | |
| 19.2 | User says no | Reply "no" | `refresh_index` is NOT called — process aborted | ☐ | |
| 19.3 | User says yes | Reply "yes" | `refresh_index` called, progress shown | ☐ | |

---

## Section 20 — Post-Tool-Use Hook

| # | Test | Setup | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 20.1 | Hook file is executable | `ls -la hooks/post-tool-use.sh` | Has execute permission | ☐ | |
| 20.2 | Reminder shown after Write | Claude uses the Write tool to edit any file | Hook outputs: "💡 RAG Search: Files were modified. Your index may be out of date." | ☐ | |
| 20.3 | Reminder shown after Edit | Claude uses the Edit tool | Same reminder | ☐ | |
| 20.4 | No false positives | Claude uses Read or Glob (not a write tool) | Hook does NOT output the reminder | ☐ | |

---

## Section 21 — Multiple Projects

| # | Test | Steps | Expected | Pass? | Notes |
|---|------|-------|----------|-------|-------|
| 21.1 | Two separate repos get separate agents | Index `/tmp/test-repo` then index a second repo at `/tmp/test-repo-2` | Each has its own `.rag-search-meta.json` with different `agent_id` values | ☐ | |
| 21.2 | Switching repos switches index | Query from `/tmp/test-repo` (about auth), then query from `/tmp/test-repo-2` | Each query uses the correct agent for its repo | ☐ | |
| 21.3 | Meta files are independent | Same | Modifying one repo's meta file doesn't affect the other | ☐ | |

---

## Section 22 — End-to-End Scenario Tests

These are full user journeys matching the use cases from the Product Brief.

### E2E-1: Onboarding a new dev

| Step | Action | Expected | Pass? |
|------|--------|----------|-------|
| 1 | Fresh install, no key | `index this repo` | Prompted for API key | ☐ |
| 2 | Provide valid key | Enter real key | Key validated, stored | ☐ |
| 3 | Index runs | Automatic after key setup | Files uploaded, status polled, confirmed ready | ☐ |
| 4 | Ask onboarding question | `how does authentication work in this project?` | Answer grounded in `src/auth.js` content, with citation | ☐ |
| 5 | Follow-up question | `where is the login function?` | Context maintained from previous answer | ☐ |

### E2E-2: Adding a new module then refreshing

| Step | Action | Expected | Pass? |
|------|--------|----------|-------|
| 1 | Start with indexed repo | Existing agent | Query works | ☐ |
| 2 | Add new file | `echo "function pay() {}" > /tmp/test-repo/src/payments.js` | File exists on disk | ☐ |
| 3 | Hook reminder shown | Claude edits a file (or use Write) | "💡 RAG Search: Files were modified..." | ☐ |
| 4 | Add just new file | `add src/payments.js to the index` | `uploaded: 1`, no full re-index | ☐ |
| 5 | Query new content | `where is the payment function?` | Answer references `payments.js` | ☐ |

### E2E-3: Searching document archive

| Step | Action | Expected | Pass? |
|------|--------|----------|-------|
| 1 | Create doc folder | `mkdir /tmp/docs-archive && cp *.pdf /tmp/docs-archive/` (use any PDFs) | Folder exists with PDFs | ☐ |
| 2 | Index docs folder | `index just the /tmp/docs-archive folder` | PDF files uploaded | ☐ |
| 3 | Search across docs | `which documents mention pricing?` | Answer with citations from PDF files | ☐ |
| 4 | Refresh after adding doc | Add new PDF, `refresh the index` → confirm | Old pages cleared, all docs re-indexed | ☐ |

### E2E-4: Multiple client projects

| Step | Action | Expected | Pass? |
|------|--------|----------|-------|
| 1 | Index project A | From `/tmp/test-repo` | Agent A created, meta stored | ☐ |
| 2 | Index project B | From `/tmp/test-repo-2` | Agent B created, different meta | ☐ |
| 3 | Query project A | `where is db.js?` from `/tmp/test-repo` context | Answer references `src/db.js` from project A | ☐ |
| 4 | Query project B | Same question from project B context | Uses project B's agent — different answer | ☐ |

---

## Section 23 — Error Handling

| # | Scenario | How to trigger | Expected | Pass? | Notes |
|---|----------|---------------|----------|-------|-------|
| 23.1 | 401 Unauthorized | Delete real key, use invalid key, call any tool | `{ "error": true, "status": 401 }` — no crash | ☐ | |
| 23.2 | 404 Not Found | Use deleted agent_id | `{ "error": true, "status": 404 }` | ☐ | |
| 23.3 | Network error | Disconnect internet, call any API tool | Throws caught error — returns `Error: ...` message, no unhandled crash | ☐ | |
| 23.4 | Malformed API response | N/A (simulate if possible) | `body.raw` returned — no JSON.parse crash | ☐ | |
| 23.5 | Claude shows error clearly | Any tool error | Claude shows `❌ Error [status]: [message]` | ☐ | |
| 23.6 | Claude suggests next steps | Same | Claude suggests checking key or limits | ☐ | |

---

## Section 24 — Plugin Manifest & Structure

| # | Check | Command / Verification | Expected | Pass? | Notes |
|---|-------|------------------------|----------|-------|-------|
| 24.1 | `plugin.json` valid JSON | `node -e "JSON.parse(require('fs').readFileSync('plugin.json','utf8'))"` | No error | ☐ | |
| 24.2 | `.mcp.json` valid JSON | Same for `.mcp.json` | No error | ☐ | |
| 24.3 | `mcp/package.json` valid JSON | Same | No error | ☐ | |
| 24.4 | Plugin name is `customgpt-ai-rag` | Check `plugin.json` | `"name": "customgpt-ai-rag"` | ☐ | |
| 24.5 | MCP server name is `customgpt-ai-rag` | Check `.mcp.json` | `"customgpt-ai-rag"` key in `mcpServers` | ☐ | |
| 24.6 | Skill path correct | Check `plugin.json` skills array | `"path": "skills/customgpt-ai-rag/SKILL.md"` | ☐ | |
| 24.7 | Hook path correct | Check `plugin.json` hooks array | `"path": "hooks/post-tool-use.sh"` | ☐ | |
| 24.8 | `ignore` in dependencies | Check `mcp/package.json` | `"ignore": "^5.3.1"` or similar | ☐ | |
| 24.9 | `skill` triggers cover key phrases | Check `skills/customgpt-ai-rag/SKILL.md` front-matter | "index this repo", "refresh the index", "search my codebase", "build a RAG" all present | ☐ | |

---

## Results Summary

Fill in after completing all tests.

| Section | Total | Passed | Failed | Blocked |
|---------|-------|--------|--------|---------|
| 1 — MCP Startup | 3 | | | |
| 2 — validate_api_key | 6 | | | |
| 3 — setup_api_key | 5 | | | |
| 4 — check_limits | 4 | | | |
| 5 — get_agent | 5 | | | |
| 6 — create_agent | 5 | | | |
| 7 — File collection | 19 | | | |
| 8 — index_files | 7 | | | |
| 9 — index_status | 4 | | | |
| 10 — add_files | 5 | | | |
| 11 — refresh_index | 5 | | | |
| 12 — query | 10 | | | |
| 13 — Skill triggers | 18 | | | |
| 14 — First-use key flow | 7 | | | |
| 15 — Existing agent detection | 4 | | | |
| 16 — Plan limit warning | 3 | | | |
| 17 — No index found | 2 | | | |
| 18 — Citations display | 3 | | | |
| 19 — Refresh confirmation | 3 | | | |
| 20 — Post-tool-use hook | 4 | | | |
| 21 — Multiple projects | 3 | | | |
| 22 — E2E scenarios | 16 | | | |
| 23 — Error handling | 6 | | | |
| 24 — Manifest & structure | 9 | | | |
| **TOTAL** | **166** | | | |

---

## Known Limitations / Out of Scope

- **Streaming responses** (`stream: true`) — not tested; plugin uses `stream: false` by default
- **Plan limit simulation** — exact over-limit behavior depends on your CustomGPT.ai plan
- **PDF content extraction accuracy** — depends on CustomGPT.ai's indexing engine, not the plugin
- **Index latency** — `index_status` polling time varies by file count and server load
- **`.gitignore` nested files** — only the root `.gitignore` is loaded; nested `.gitignore` files are not currently processed
