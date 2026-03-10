#!/usr/bin/env node
/**
 * CustomGPT.ai RAG Search — MCP Server
 *
 * Exposes indexing, refresh, and querying operations as MCP tools for Claude Code.
 * Each repo/project maps to one CustomGPT.ai agent. Agent IDs are persisted in
 * a hidden .rag-search-meta.json at the repo root so the same agent is reused
 * across sessions.
 *
 * API base: https://app.customgpt.ai/api/v1
 * Docs:     https://docs.customgpt.ai/reference
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import os from "os";
import FormData from "form-data";
import fetch from "node-fetch";
import ignore from "ignore";

const CONFIG_PATH = path.join(os.homedir(), ".claude", "rag-search-config.json");
const BASE = "https://app.customgpt.ai/api/v1";
const META_FILENAME = ".rag-search-meta.json";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getApiKey() {
  return process.env.CUSTOMGPT_API_KEY || loadConfig().apiKey || null;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function cgFetch(endpoint, opts = {}) {
  const key = getApiKey();
  if (!key) throw new Error("No CustomGPT.ai API key configured. Run setup_api_key first.");
  const url = `${BASE}${endpoint}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Per-project meta  (repo_root → { agent_id, project_name, created_at, file_manifest })
// ---------------------------------------------------------------------------

function metaPath(repoRoot) {
  return path.join(repoRoot, META_FILENAME);
}

function readMeta(repoRoot) {
  try { return JSON.parse(fs.readFileSync(metaPath(repoRoot), "utf8")); }
  catch { return null; }
}

function writeMeta(repoRoot, meta) {
  fs.writeFileSync(metaPath(repoRoot), JSON.stringify(meta, null, 2));
}

// Merge uploaded file mtimes into the manifest stored in meta.
function updateManifest(repoRoot, uploadedManifest) {
  const meta = readMeta(repoRoot);
  if (!meta) return;
  meta.file_manifest = { ...(meta.file_manifest || {}), ...uploadedManifest };
  meta.last_indexed = new Date().toISOString();
  writeMeta(repoRoot, meta);
}

// Returns absolute paths of indexed files whose mtime has changed since last index.
function getStaleFiles(repoRoot) {
  const meta = readMeta(repoRoot);
  if (!meta?.file_manifest) return [];
  const stale = [];
  for (const [rel, recordedMtime] of Object.entries(meta.file_manifest)) {
    const abs = path.join(repoRoot, rel);
    try {
      const mtime = fs.statSync(abs).mtimeMs;
      if (mtime !== recordedMtime) stale.push(abs);
    } catch {
      // file deleted — skip (don't re-upload a deleted file)
    }
  }
  return stale;
}

// ---------------------------------------------------------------------------
// File-tree walking
// ---------------------------------------------------------------------------

const ALWAYS_EXCLUDE_DIRS = new Set([
  ".git", ".claude", ".github", ".gitlab", ".vscode", ".idea",
  "node_modules", "__pycache__", ".next", "dist", "build", "out",
  ".cache", "vendor", ".terraform", "coverage", ".nyc_output",
  "tmp", "temp", ".eggs",
]);

const ALWAYS_EXCLUDE_FILES = new Set([
  ".env", ".env.local", ".env.development", ".env.production",
  ".DS_Store", "Thumbs.db",
]);

const BINARY_EXTS = new Set([
  ".exe", ".bin", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flv",
  ".pyc", ".pyo", ".class", ".o", ".a", ".so", ".dll", ".dylib",
  ".lock",  // lockfiles are large and noisy
]);

const SUPPORTED_EXTS = new Set([
  // Code
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".go", ".rb", ".java", ".cs", ".cpp", ".c", ".h", ".hpp",
  ".rs", ".swift", ".kt", ".kts", ".php", ".scala", ".clj", ".ex", ".exs",
  ".r", ".m", ".lua", ".pl", ".pm",
  // Web
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
  // Data / config
  ".sql", ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".yaml", ".yml", ".json", ".jsonc", ".toml", ".ini", ".cfg", ".conf",
  ".xml", ".env.example", ".editorconfig",
  // Docs
  ".md", ".mdx", ".txt", ".rst", ".adoc", ".tex",
  // Documents
  ".pdf", ".docx", ".xlsx", ".csv", ".pptx",
]);

function buildIgnorer(repoRoot) {
  const ig = ignore();
  const gitignorePath = path.join(repoRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }
  return ig;
}

/**
 * Collect all indexable files under startPath, respecting exclusion rules.
 * Returns absolute file paths.
 */
function collectFiles(repoRoot, startPath) {
  const ig = buildIgnorer(repoRoot);
  const results = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, abs);

      if (entry.name.startsWith(".")) continue;
      if (ALWAYS_EXCLUDE_FILES.has(entry.name)) continue;

      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDE_DIRS.has(entry.name)) continue;
        if (entry.name.endsWith(".egg-info")) continue;
        if (ig.ignores(rel + "/")) continue;
        walk(abs);
      } else {
        if (ig.ignores(rel)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (!SUPPORTED_EXTS.has(ext)) continue;
        results.push(abs);
      }
    }
  }

  // startPath may be a file or directory
  const stat = fs.statSync(startPath);
  if (stat.isDirectory()) {
    walk(startPath);
  } else {
    const ext = path.extname(startPath).toLowerCase();
    if (!BINARY_EXTS.has(ext)) results.push(startPath);
  }

  return results;
}

// ---------------------------------------------------------------------------
// File upload helper — uploads files one by one, tracks progress
// ---------------------------------------------------------------------------

async function uploadFiles(agentId, files, repoRoot) {
  let uploaded = 0;
  let failed = 0;
  const failedFiles = [];
  const manifest = {};

  for (const filePath of files) {
    const relPath = path.relative(repoRoot, filePath);
    try {
      const form = new FormData();
      form.append("file", fs.createReadStream(filePath), {
        filename: relPath,
        contentType: guessMime(filePath),
      });
      const res = await fetch(`${BASE}/projects/${agentId}/sources`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          Accept: "application/json",
          ...form.getHeaders(),
        },
        body: form,
      });
      if (res.ok) {
        uploaded++;
        manifest[relPath] = fs.statSync(filePath).mtimeMs;
      } else {
        failed++;
        failedFiles.push(relPath);
      }
    } catch {
      failed++;
      failedFiles.push(relPath);
    }
  }

  return { uploaded, failed, failed_files: failedFiles, manifest };
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".pdf":  "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv":  "text/csv",
    ".json": "application/json",
    ".html": "text/html",
    ".htm":  "text/html",
    ".xml":  "application/xml",
    ".md":   "text/markdown",
  };
  return map[ext] || "text/plain";
}

// ---------------------------------------------------------------------------
// Agent auto-resolve: reads meta or creates a new agent from folder name
// ---------------------------------------------------------------------------

async function resolveAgent(repoRoot) {
  const meta = readMeta(repoRoot);
  if (meta?.agent_id) {
    // Verify it still exists
    const r = await cgFetch(`/projects/${meta.agent_id}`);
    if (r.ok) return { agent_id: meta.agent_id, created: false };
  }
  // Create a new agent named after the folder
  const projectName = path.basename(repoRoot);
  const body = new URLSearchParams({ project_name: projectName, is_chat_active: "1" });
  const r = await cgFetch("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Failed to create agent: ${r.body?.message || r.status}`);
  const agent_id = r.body?.data?.id;
  writeMeta(repoRoot, { agent_id, project_name: projectName, created_at: new Date().toISOString() });
  return { agent_id, created: true, project_name: projectName };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "customgpt-ai-rag", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Auth ────────────────────────────────────────────────────────────────
    {
      name: "validate_api_key",
      description: "Check if the stored CustomGPT.ai API key is valid. Returns the user email on success.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "setup_api_key",
      description: "Store a CustomGPT.ai API key. Validates immediately after storing.",
      inputSchema: {
        type: "object",
        required: ["api_key"],
        properties: {
          api_key: {
            type: "string",
            description: "API key from https://app.customgpt.ai/profile#api-keys",
          },
        },
      },
    },

    // ── Account limits ────────────────────────────────────────────────────
    {
      name: "check_limits",
      description: "Get account page/document limits and current usage. Call this before indexing a large project to warn the user if they may exceed their plan.",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Agent management ─────────────────────────────────────────────────
    {
      name: "list_agents",
      description: "List all CustomGPT.ai agents in your account. Useful when switching between projects.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number", description: "Page number (default 1)." },
        },
      },
    },
    {
      name: "delete_agent",
      description: "Permanently delete a CustomGPT.ai agent and all its data (knowledge base, conversations, settings). Irreversible.",
      inputSchema: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "number" },
        },
      },
    },

    // ── Agent lookup / creation ───────────────────────────────────────────
    {
      name: "get_agent",
      description: "Look up the CustomGPT.ai agent associated with a local repo/folder. Reads the .rag-search-meta.json file stored at the repo root.",
      inputSchema: {
        type: "object",
        required: ["repo_root"],
        properties: {
          repo_root: {
            type: "string",
            description: "Absolute path to the repo/project root.",
          },
        },
      },
    },
    {
      name: "create_agent",
      description: "Create a new CustomGPT.ai agent for this project and persist its ID in .rag-search-meta.json at the repo root.",
      inputSchema: {
        type: "object",
        required: ["repo_root", "project_name"],
        properties: {
          repo_root: { type: "string" },
          project_name: {
            type: "string",
            description: "Human-readable name for the agent (e.g. the repo/folder name).",
          },
        },
      },
    },

    // ── Indexing ──────────────────────────────────────────────────────────
    {
      name: "index_files",
      description: "Upload files from a path to the CustomGPT.ai agent. Automatically finds or creates the agent for repo_root — you do NOT need to look up or provide agent_id. Walks directories recursively, respects .gitignore, and skips dotfiles, binaries, and build artifacts.",
      inputSchema: {
        type: "object",
        required: ["repo_root", "start_path"],
        properties: {
          repo_root: {
            type: "string",
            description: "Absolute path to the repo root. The agent is looked up or created automatically from this path.",
          },
          agent_id: { type: "number", description: "Optional. Omit to auto-resolve from repo_root." },
          start_path: {
            type: "string",
            description: "Absolute path to start indexing from — can be the repo root, a subfolder, or a single file.",
          },
        },
      },
    },
    {
      name: "index_status",
      description: "Get the current indexing status for a CustomGPT.ai agent. Poll this after index_files to know when the index is ready to query.",
      inputSchema: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "number" },
        },
      },
    },
    {
      name: "refresh_index",
      description: "Re-index files: deletes their existing pages then re-uploads them. Pass 'paths' (list of specific files from check_freshness) to refresh only changed files. Pass 'start_path' to refresh an entire directory. Verifies index_status=ok after upload.",
      inputSchema: {
        type: "object",
        required: ["repo_root"],
        properties: {
          repo_root: { type: "string", description: "Absolute path to the repo root." },
          agent_id: { type: "number", description: "Optional. Omit to auto-resolve from repo_root." },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Specific files to refresh (relative or absolute). Use this when refreshing stale files from check_freshness.",
          },
          start_path: {
            type: "string",
            description: "Refresh all files under this directory. Used for full re-index. Ignored if 'paths' is provided.",
          },
        },
      },
    },
    {
      name: "add_files",
      description: "Add specific files or folders to the agent index without re-indexing everything. Automatically finds or creates the agent for repo_root — you do NOT need to look up or provide agent_id.",
      inputSchema: {
        type: "object",
        required: ["repo_root", "paths"],
        properties: {
          repo_root: { type: "string", description: "Absolute path to the repo root. The agent is looked up or created automatically." },
          agent_id: { type: "number", description: "Optional. Omit to auto-resolve from repo_root." },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Absolute paths to files or folders to add.",
          },
        },
      },
    },

    // ── Settings ──────────────────────────────────────────────────────────
    {
      name: "get_settings",
      description: "Get the current settings of a CustomGPT.ai agent (persona, colors, citations, UI strings, starter questions, etc.).",
      inputSchema: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "number" },
        },
      },
    },
    {
      name: "update_settings",
      description: "Update agent settings. Only provide fields you want to change. Supports persona_instructions, chatbot_color, chatbot_toolbar_color, default_prompt, example_questions, enable_citations, enable_feedbacks, citations_view_type, response_source, chatbot_msg_lang, and more.",
      inputSchema: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "number" },
          persona_instructions:          { type: "string", description: "AI persona/behavior instructions (max 12000 chars)." },
          default_prompt:                { type: "string", description: "Placeholder text in the chat input (max 255 chars)." },
          example_questions:             { type: "array", items: { type: "string" }, description: "Starter questions shown to users." },
          chatbot_color:                 { type: "string", description: "Main chatbot color (hex, e.g. '#FF5733')." },
          chatbot_toolbar_color:         { type: "string", description: "Toolbar color (hex)." },
          response_source:               { type: "string", enum: ["default", "own_content", "openai_content"] },
          chatbot_msg_lang:              { type: "string", description: "Language code for chatbot messages." },
          enable_citations:              { type: "number", enum: [0, 1, 2, 3], description: "0=off, 1=after response, 2=inline refs, 3=both." },
          enable_feedbacks:              { type: "boolean" },
          citations_view_type:           { type: "string", enum: ["user", "show", "hide"] },
          image_citation_display:        { type: "string", enum: ["default", "first_only"] },
          citations_answer_source_label_msg: { type: "string" },
          citations_sources_label_msg:   { type: "string" },
        },
      },
    },

    // ── Pages ─────────────────────────────────────────────────────────────
    {
      name: "list_pages",
      description: "List indexed documents/pages for an agent. Useful for inspecting what is in the knowledge base.",
      inputSchema: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "number" },
          page: { type: "number", description: "Page number (default 1)." },
          per_page: { type: "number", description: "Results per page (default 20, max 100)." },
        },
      },
    },
    {
      name: "delete_page",
      description: "Delete a specific indexed document/page from an agent by its page ID.",
      inputSchema: {
        type: "object",
        required: ["agent_id", "page_id"],
        properties: {
          agent_id: { type: "number" },
          page_id: { type: "number" },
        },
      },
    },

    // ── Page metadata ─────────────────────────────────────────────────────
    {
      name: "get_page_metadata",
      description: "Get metadata (title, description, URL, image) for a specific indexed document.",
      inputSchema: {
        type: "object",
        required: ["agent_id", "page_id"],
        properties: {
          agent_id: { type: "number" },
          page_id:  { type: "number" },
        },
      },
    },
    {
      name: "update_page_metadata",
      description: "Update metadata for a specific indexed document. Useful for correcting titles, descriptions, or URLs that were incorrectly extracted.",
      inputSchema: {
        type: "object",
        required: ["agent_id", "page_id"],
        properties: {
          agent_id:    { type: "number" },
          page_id:     { type: "number" },
          title:       { type: "string", description: "Page title (max 255 chars)." },
          url:         { type: "string", description: "Page URL (max 2000 chars)." },
          description: { type: "string", description: "Page description (max 500 chars)." },
          image:       { type: "string", description: "Image URL (max 2000 chars)." },
        },
      },
    },

    // ── Citations ─────────────────────────────────────────────────────────
    {
      name: "get_citation",
      description: "Get metadata for a citation returned in a query response (title, description, URL, image).",
      inputSchema: {
        type: "object",
        required: ["agent_id", "citation_id"],
        properties: {
          agent_id:    { type: "number" },
          citation_id: { type: "number" },
        },
      },
    },

    // ── Messages ──────────────────────────────────────────────────────────
    {
      name: "get_messages",
      description: "List messages in a conversation session.",
      inputSchema: {
        type: "object",
        required: ["agent_id", "session_id"],
        properties: {
          agent_id:   { type: "number" },
          session_id: { type: "string" },
          page:       { type: "number", description: "Page number (default 1)." },
          order:      { type: "string", enum: ["asc", "desc"], description: "Message order (default: asc)." },
        },
      },
    },
    {
      name: "get_message",
      description: "Get details of a specific message in a conversation, including citations and feedback.",
      inputSchema: {
        type: "object",
        required: ["agent_id", "session_id", "prompt_id"],
        properties: {
          agent_id:   { type: "number" },
          session_id: { type: "string" },
          prompt_id:  { type: "number" },
        },
      },
    },
    {
      name: "message_feedback",
      description: "Submit thumbs-up, thumbs-down, or neutral feedback on a message.",
      inputSchema: {
        type: "object",
        required: ["agent_id", "session_id", "prompt_id", "reaction"],
        properties: {
          agent_id:   { type: "number" },
          session_id: { type: "string" },
          prompt_id:  { type: "number" },
          reaction:   { type: "string", enum: ["liked", "disliked", "neutral"] },
        },
      },
    },
    {
      name: "get_message_claims",
      description: "Get the extracted factual claims from a message response for independent verification.",
      inputSchema: {
        type: "object",
        required: ["agent_id", "session_id", "prompt_id"],
        properties: {
          agent_id:   { type: "number" },
          session_id: { type: "string" },
          prompt_id:  { type: "number" },
        },
      },
    },
    {
      name: "get_trust_score",
      description: "Get the trust score and stakeholder analysis for a message (end user, security, risk compliance, legal, public relations).",
      inputSchema: {
        type: "object",
        required: ["agent_id", "session_id", "prompt_id"],
        properties: {
          agent_id:   { type: "number" },
          session_id: { type: "string" },
          prompt_id:  { type: "number" },
        },
      },
    },

    // ── Querying ──────────────────────────────────────────────────────────
    {
      name: "check_freshness",
      description: "Compare current file mtimes against the manifest recorded at last index. Returns a list of files that have changed (or been added) since then. Call this before query to detect external edits. If stale_files is non-empty, call refresh_index before querying.",
      inputSchema: {
        type: "object",
        required: ["repo_root"],
        properties: {
          repo_root: { type: "string", description: "Absolute path to the repo root." },
        },
      },
    },
    {
      name: "query",
      description: "Send a plain-language question to the indexed project and return an AI answer with source citations (file names, pages, URLs).",
      inputSchema: {
        type: "object",
        required: ["agent_id", "question"],
        properties: {
          agent_id: { type: "number" },
          question: { type: "string" },
          session_id: {
            type: "string",
            description: "Optional: reuse an existing conversation session for follow-up questions.",
          },
        },
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a } = req.params;

  try {
    switch (name) {

      // ── validate_api_key ────────────────────────────────────────────────
      case "validate_api_key": {
        const key = getApiKey();
        if (!key) return ok({ valid: false, message: "No API key stored. Call setup_api_key first." });
        const r = await cgFetch("/user");
        if (r.ok) return ok({ valid: true, email: r.body?.data?.email });
        return ok({ valid: false, status: r.status, message: r.body?.message || "Invalid key." });
      }

      // ── setup_api_key ────────────────────────────────────────────────────
      case "setup_api_key": {
        const cfg = loadConfig();
        cfg.apiKey = a.api_key;
        saveConfig(cfg);
        const r = await cgFetch("/user");
        if (r.ok) return ok({ stored: true, valid: true, email: r.body?.data?.email });
        return ok({
          stored: true,
          valid: false,
          message: "Key stored but validation failed. Double-check you copied the full key.",
        });
      }

      // ── check_limits ─────────────────────────────────────────────────────
      case "check_limits": {
        const r = await cgFetch("/limits/usage");
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── list_agents ──────────────────────────────────────────────────────
      case "list_agents": {
        const page = a.page || 1;
        const r = await cgFetch(`/projects?page=${page}`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── delete_agent ─────────────────────────────────────────────────────
      case "delete_agent": {
        const r = await cgFetch(`/projects/${a.agent_id}`, { method: "DELETE" });
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── get_agent ────────────────────────────────────────────────────────
      case "get_agent": {
        const meta = readMeta(a.repo_root);
        if (!meta) return ok({ found: false });
        // Verify the agent still exists on the server
        const r = await cgFetch(`/projects/${meta.agent_id}`);
        if (r.ok) {
          return ok({
            found: true,
            agent_id: meta.agent_id,
            name: r.body?.data?.project_name || meta.project_name,
            is_chat_active: r.body?.data?.is_chat_active,
            type: r.body?.data?.type,
          });
        }
        return ok({ found: false, stale: true, message: "Stored agent ID no longer exists on the server." });
      }

      // ── create_agent ─────────────────────────────────────────────────────
      case "create_agent": {
        const body = new URLSearchParams({
          project_name: a.project_name,
          is_chat_active: "1",
        });
        const r = await cgFetch("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!r.ok) return fail(r);
        const agent_id = r.body?.data?.id;
        writeMeta(a.repo_root, {
          agent_id,
          project_name: a.project_name,
          created_at: new Date().toISOString(),
        });
        return ok({ agent_id, name: a.project_name });
      }

      // ── index_files ──────────────────────────────────────────────────────
      case "index_files": {
        const { repo_root, start_path } = a;
        const resolved = await resolveAgent(repo_root);
        const agent_id = a.agent_id ?? resolved.agent_id;

        if (!fs.existsSync(start_path)) {
          return ok({ uploaded: 0, message: `Path not found: ${start_path}` });
        }

        const files = collectFiles(repo_root, start_path);

        if (files.length === 0) {
          return ok({
            uploaded: 0,
            message: "No eligible files found. All files were excluded by .gitignore or exclusion rules.",
          });
        }

        const results = await uploadFiles(agent_id, files, repo_root);
        updateManifest(repo_root, results.manifest);
        // Clear stale flag so pre-prompt hook stops warning
        try { fs.unlinkSync(path.join(repo_root, ".rag-search-dirty")); } catch {}
        return ok({
          agent_id,
          agent_created: resolved.created,
          project_name: resolved.project_name,
          total_found: files.length,
          uploaded: results.uploaded,
          failed: results.failed,
          failed_files: results.failed_files,
          message: results.failed === 0
            ? `✅ ${results.uploaded} files uploaded successfully.`
            : `⚠️ ${results.uploaded} uploaded, ${results.failed} failed.`,
        });
      }

      // ── index_status ─────────────────────────────────────────────────────
      case "index_status": {
        // Fetch counts for each index_status via the pages API
        const statuses = ["ok", "queued", "failed", "limited", "n/a"];
        const counts = {};
        const agentRes = await cgFetch(`/projects/${a.agent_id}`);
        if (!agentRes.ok) return fail(agentRes);
        const agentData = agentRes.body?.data || {};
        for (const s of statuses) {
          const r = await cgFetch(`/projects/${a.agent_id}/pages?page=1&limit=1&index_status=${s}`);
          counts[s] = r.ok ? (r.body?.data?.pages?.total ?? 0) : 0;
        }
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        const ready = counts.queued === 0 && total > 0;
        return ok({
          is_chat_active: agentData?.is_chat_active,
          status: ready ? "ready" : counts.queued > 0 ? "indexing" : total === 0 ? "empty" : "unknown",
          ready,
          total,
          ok: counts["ok"],
          queued: counts["queued"],
          failed: counts["failed"],
          limited: counts["limited"],
        });
      }

      // ── refresh_index ────────────────────────────────────────────────────
      case "refresh_index": {
        const { repo_root, start_path, paths: specificPaths } = a;
        const resolved = await resolveAgent(repo_root);
        const agent_id = a.agent_id ?? resolved.agent_id;

        // Resolve files: specific list (from check_freshness) or full directory scan
        let files;
        if (specificPaths?.length) {
          files = specificPaths
            .map(p => path.isAbsolute(p) ? p : path.join(repo_root, p))
            .filter(p => fs.existsSync(p));
        } else {
          if (!fs.existsSync(start_path)) {
            return ok({ deleted: 0, uploaded: 0, message: `Path not found: ${start_path}` });
          }
          files = collectFiles(repo_root, start_path);
        }

        if (files.length === 0) {
          return ok({ deleted: 0, uploaded: 0, message: "No eligible files found to re-index." });
        }

        // Build sets for matching against API page fields
        const relPaths = new Set(files.map(f => path.relative(repo_root, f)));
        const basenames = new Set(files.map(f => path.basename(f)));

        const pageMatches = (p) => {
          const candidates = [p.filename, p.page_url].filter(Boolean);
          for (const c of candidates) {
            if (relPaths.has(c) || basenames.has(c)) return true;
            for (const rel of relPaths) {
              if (c.endsWith("/" + rel) || c.endsWith(rel)) return true;
            }
          }
          return false;
        };

        // Delete old pages for these files only
        let pg = 1;
        let deleted = 0;
        while (true) {
          const r = await cgFetch(`/projects/${agent_id}/pages?page=${pg}&per_page=100`);
          if (!r.ok || !r.body?.data?.pages?.data?.length) break;
          const pages = r.body.data.pages.data;
          for (const p of pages) {
            if (pageMatches(p)) {
              const dr = await cgFetch(`/projects/${agent_id}/pages/${p.id}`, { method: "DELETE" });
              if (dr.ok) deleted++;
            }
          }
          if (pages.length < 100) break;
          pg++;
        }

        // Re-upload and update manifest
        const results = await uploadFiles(agent_id, files, repo_root);
        updateManifest(repo_root, results.manifest);

        // Verify index_status of re-uploaded files
        const statusCheck = await cgFetch(`/projects/${agent_id}/pages?page=1&per_page=100&index_status=ok`);
        const okPages = statusCheck.ok ? (statusCheck.body?.data?.pages?.data || []) : [];
        const indexed_ok = files.filter(f => {
          const rel = path.relative(repo_root, f);
          const base = path.basename(f);
          return okPages.some(p => {
            const c = [p.filename, p.page_url].filter(Boolean);
            return c.some(v => v === rel || v === base || v.endsWith("/" + rel));
          });
        }).map(f => path.relative(repo_root, f));

        if (results.failed === 0) {
          try { fs.unlinkSync(path.join(repo_root, ".rag-search-dirty")); } catch {}
        }
        return ok({
          deleted,
          total_found: files.length,
          uploaded: results.uploaded,
          failed: results.failed,
          failed_files: results.failed_files,
          indexed_ok,
          message: `🔄 Deleted ${deleted} old pages. Re-uploaded ${results.uploaded} files. ${indexed_ok.length} confirmed ok.`,
        });
      }

      // ── add_files ────────────────────────────────────────────────────────
      case "add_files": {
        const { repo_root, paths } = a;
        const resolved = await resolveAgent(repo_root);
        const agent_id = a.agent_id ?? resolved.agent_id;
        let files = [];
        for (const p of paths) {
          if (!fs.existsSync(p)) continue;
          files.push(...collectFiles(repo_root, p));
        }
        if (files.length === 0) {
          return ok({ uploaded: 0, message: "No eligible files found in the specified paths." });
        }
        const results = await uploadFiles(agent_id, files, repo_root);
        updateManifest(repo_root, results.manifest);
        return ok({
          total_found: files.length,
          uploaded: results.uploaded,
          failed: results.failed,
          failed_files: results.failed_files,
          message: `✅ Added ${results.uploaded} files to the index.`,
        });
      }

      // ── list_pages ───────────────────────────────────────────────────────
      case "list_pages": {
        const page = a.page || 1;
        const per_page = a.per_page || 20;
        const r = await cgFetch(`/projects/${a.agent_id}/pages?page=${page}&per_page=${per_page}`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── delete_page ──────────────────────────────────────────────────────
      case "delete_page": {
        const r = await cgFetch(`/projects/${a.agent_id}/pages/${a.page_id}`, { method: "DELETE" });
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── get_settings ─────────────────────────────────────────────────────
      case "get_settings": {
        const r = await cgFetch(`/projects/${a.agent_id}/settings`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── update_settings ───────────────────────────────────────────────────
      case "update_settings": {
        const { agent_id, ...fields } = a;
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined || v === null) continue;
          if (Array.isArray(v)) {
            v.forEach(item => form.append(`${k}[]`, item));
          } else {
            form.append(k, String(v));
          }
        }
        const r = await cgFetch(`/projects/${agent_id}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── get_page_metadata ─────────────────────────────────────────────────
      case "get_page_metadata": {
        const r = await cgFetch(`/projects/${a.agent_id}/pages/${a.page_id}/metadata`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── update_page_metadata ──────────────────────────────────────────────
      case "update_page_metadata": {
        const { agent_id, page_id, ...meta } = a;
        const r = await cgFetch(`/projects/${agent_id}/pages/${page_id}/metadata`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(meta),
        });
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── get_citation ──────────────────────────────────────────────────────
      case "get_citation": {
        const r = await cgFetch(`/projects/${a.agent_id}/citations/${a.citation_id}`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── get_messages ──────────────────────────────────────────────────────
      case "get_messages": {
        const page  = a.page  || 1;
        const order = a.order || "asc";
        const r = await cgFetch(`/projects/${a.agent_id}/conversations/${a.session_id}/messages?page=${page}&order=${order}`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── get_message ───────────────────────────────────────────────────────
      case "get_message": {
        const r = await cgFetch(`/projects/${a.agent_id}/conversations/${a.session_id}/messages/${a.prompt_id}`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── message_feedback ──────────────────────────────────────────────────
      case "message_feedback": {
        const r = await cgFetch(`/projects/${a.agent_id}/conversations/${a.session_id}/messages/${a.prompt_id}/feedback`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reaction: a.reaction }),
        });
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── get_message_claims ────────────────────────────────────────────────
      case "get_message_claims": {
        const r = await cgFetch(`/projects/${a.agent_id}/conversations/${a.session_id}/messages/${a.prompt_id}/claims`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── get_trust_score ───────────────────────────────────────────────────
      case "get_trust_score": {
        const r = await cgFetch(`/projects/${a.agent_id}/conversations/${a.session_id}/messages/${a.prompt_id}/trust-score`);
        if (!r.ok) return fail(r);
        return ok(r.body?.data || {});
      }

      // ── check_freshness ──────────────────────────────────────────────────
      case "check_freshness": {
        const meta = readMeta(a.repo_root);
        if (!meta?.file_manifest) {
          return ok({ stale_files: [], message: "No file manifest found. Index the project first." });
        }
        const staleFiles = getStaleFiles(a.repo_root);
        return ok({
          stale_files: staleFiles.map(f => path.relative(a.repo_root, f)),
          total_indexed: Object.keys(meta.file_manifest).length,
          last_indexed: meta.last_indexed || null,
        });
      }

      // ── query ─────────────────────────────────────────────────────────────
      case "query": {
        const { agent_id, question, session_id } = a;

        // Create or reuse a conversation session
        let sid = session_id;
        if (!sid) {
          const cr = await cgFetch(`/projects/${agent_id}/conversations`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ name: "Claude Code Query" }),
          });
          if (!cr.ok) return fail(cr);
          sid = cr.body?.data?.session_id;
        }

        // Send the message
        const mr = await cgFetch(`/projects/${agent_id}/conversations/${sid}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ prompt: question, stream: "false" }),
        });
        if (!mr.ok) return fail(mr);

        return ok({ ...(mr.body?.data || {}), session_id: sid });
      }

      default:
        return fail({ status: 400, body: { message: `Unknown tool: ${name}` } });
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(r) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: true,
        status: r.status,
        message: r.body?.message || "Request failed",
      }, null, 2),
    }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
