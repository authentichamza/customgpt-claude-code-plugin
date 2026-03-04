# CustomGPT.ai RAG Search for Claude Code

**Your AI assistant finally knows your entire project.**

Now Claude Code can search your entire project instantly — even 10,000 files — right from the terminal.

---

## Why This Exists

Claude Code has no built-in index. Every session starts cold — reading files one by one, filling up its context window until it runs out of room. A 500-file repo? It's guessing. A year of sales transcripts? It gives up.

This plugin gives Claude Code a persistent, semantically searchable index of your entire project, powered by CustomGPT.ai's RAG engine. You ask about authentication patterns across your codebase — it finds them across hundreds of files. You ask about pricing objections from last quarter's sales calls — it pulls the exact conversations.

---

## Installation

```bash
# Install from GitHub
claude plugin add github:customgpt-ai/claude-code-plugin

# Or install locally during development
claude plugin add ./customgpt-claude-code-plugin
```

On first use, Claude will prompt you for your CustomGPT.ai API key.

---

## Setup

### 1. Get a CustomGPT.ai account
- Sign up: https://customgpt.ai/pricing
- Get your API key: https://app.customgpt.ai/profile#api-keys

### 2. Claude prompts you on first use
```
🔑 No CustomGPT.ai API key found.
Sign up at:      https://customgpt.ai/pricing
Get your key at: https://app.customgpt.ai/profile#api-keys
```
Paste your key — it's validated and stored in `~/.claude/rag-search-config.json`.

---

## Usage

All commands are plain language — no special syntax.

### Index your project
```
index this repo
index this project
build a RAG from this folder
```

### Index a subset
```
index just the src/ folder
index docs/architecture.pdf and src/auth/
```

### Refresh after changes
```
refresh the index
re-index from scratch
```

### Add new files to an existing index
```
add the new migrations/ folder to the index
add src/payments.ts to the index
```

### Search
```
how does authentication work in this project?
find all places where we handle payment errors
what does the PRD say about the onboarding flow?
where is the database connection configured?
which contracts have a 30-day termination clause?
what did prospects say about pricing in Q4?
which API endpoints exist in the code but aren't documented?
```

Claude will answer from your actual files and cite sources:
```
📄 Sources:
- src/auth/session.ts (lines 34–67)
- docs/architecture.pdf (page 5)
```

---

## Use Cases

**Onboarding new devs to a large codebase**
Index the repo once. New hires ask questions in plain language — no more pestering senior devs, no more reading hundreds of files.

**Mining a year of sales conversations**
Index call transcripts and ask "what did prospects say about our pricing?" — get specific quotes from specific calls instantly.

**Searching a contract archive**
"Which contracts have a 30-day termination clause?" — surfaces every matching contract immediately.

**Connecting code and business docs in one search**
Index both your codebase and your PRDs, design specs, and customer research. Ask questions that span technical and business context.

**Auditing documentation gaps**
"Which API endpoints exist in the code but aren't documented?" — finds mismatches in seconds.

**Multiple client projects**
Each project maps to its own CustomGPT.ai agent. Switching directories switches your active index — no re-explaining context.

**Searching research data**
Index reports, papers, survey results, and interview transcripts. Ask across the full corpus instantly.

---

## What Gets Indexed

**Code:** `.js`, `.ts`, `.py`, `.go`, `.rb`, `.java`, `.cs`, `.cpp`, `.rs`, `.swift`, `.kt`, `.php`, `.html`, `.css`, `.sql`, `.sh`, `.yaml`, `.json`, `.toml`, `.xml`, `.md`, `.txt`, and more

**Documents:** `.pdf`, `.docx`, `.xlsx`, `.csv`, `.pptx`

**Always excluded:**
- Dotfiles and dot-folders: `.env`, `.git/`, `.claude/`, `.github/`, `node_modules/`, etc.
- Files matched by `.gitignore`
- Binaries: images, fonts, compiled artifacts, archives

---

## File Structure

```
customgpt-claude-code-plugin/
├── plugin.json              # Plugin manifest
├── .mcp.json                # MCP server registration
├── skills/
│   └── rag-search.md        # Skill: triggers and behavior rules
├── mcp/
│   ├── server.js            # MCP server (Node.js)
│   └── package.json
├── hooks/
│   └── post-tool-use.sh     # Reminds user to refresh after file edits
└── README.md
```

A hidden `.rag-search-meta.json` is written to the project root on first index — it stores the agent ID so the same agent is reused across sessions.

---

## FAQs

**Does this work for non-code projects?**
Yes. Index PDFs, sales transcripts, legal contracts, spreadsheets, meeting notes — anything you point it at.

**Does it slow down Claude Code?**
No. RAG retrieval is significantly faster than Claude Code's default file-by-file reading.

**Where does my data go?**
Files are uploaded to CustomGPT.ai's servers for indexing. Standard CustomGPT.ai data handling and security policies apply.

**Is my API key secure?**
The key is stored locally in `~/.claude/rag-search-config.json`. It never leaves your machine except when authenticating with CustomGPT.ai's API.

**Can I index multiple projects?**
Yes. Each indexed project maps to its own CustomGPT.ai agent. Switching directories automatically switches the active index.

**How do I update the index when files change?**
Say "refresh the index." This is manual by design — you control when it updates.

**What plan do I need?**
Any active CustomGPT.ai subscription with API access. The plugin uses your existing quota for project creation, file uploads, and queries.

---

## Development

```bash
cd mcp && npm install
node server.js   # test the MCP server locally
```

To test as a local plugin:
```bash
claude plugin add ./customgpt-claude-code-plugin --project
```

---

## Uninstalling

```bash
claude plugin remove rag-search
```

Your CustomGPT.ai agent and all indexed data remain intact at https://app.customgpt.ai.

---

## License

MIT
