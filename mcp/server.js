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
// Per-project meta  (repo_root → { agent_id, project_name, created_at })
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

// ---------------------------------------------------------------------------
// File-tree walking
// ---------------------------------------------------------------------------

const ALWAYS_EXCLUDE_DIRS = new Set([
  ".git", ".claude", ".github", ".gitlab", ".vscode", ".idea",
  "node_modules", "__pycache__", ".next", "dist", "build", "out",
  ".cache", "vendor", ".terraform", "coverage", ".nyc_output",
  "tmp", "temp", ".eggs", "*.egg-info",
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

  for (const filePath of files) {
    try {
      const form = new FormData();
      const relPath = path.relative(repoRoot, filePath);
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
      } else {
        failed++;
        failedFiles.push(relPath);
      }
    } catch {
      failed++;
      failedFiles.push(path.relative(repoRoot, filePath));
    }
  }

  return { uploaded, failed, failed_files: failedFiles };
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
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "rag-search", version: "1.0.0" },
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
      description: "Upload files from a path to the CustomGPT.ai agent. Walks directories recursively, respects .gitignore, and skips dotfiles, binaries, and build artifacts. Supports code, PDFs, DOCX, XLSX, CSV, transcripts, and more.",
      inputSchema: {
        type: "object",
        required: ["repo_root", "agent_id", "start_path"],
        properties: {
          repo_root: {
            type: "string",
            description: "Absolute path to the repo root (used for .gitignore and relative paths).",
          },
          agent_id: { type: "number" },
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
      description: "Delete ALL indexed documents from the agent and re-index from scratch. Use when files have changed significantly.",
      inputSchema: {
        type: "object",
        required: ["repo_root", "agent_id", "start_path"],
        properties: {
          repo_root: { type: "string" },
          agent_id: { type: "number" },
          start_path: {
            type: "string",
            description: "Absolute path to re-index from.",
          },
        },
      },
    },
    {
      name: "add_files",
      description: "Add specific files or folders to an existing agent index without re-indexing everything.",
      inputSchema: {
        type: "object",
        required: ["repo_root", "agent_id", "paths"],
        properties: {
          repo_root: { type: "string" },
          agent_id: { type: "number" },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Absolute paths to files or folders to add.",
          },
        },
      },
    },

    // ── Querying ──────────────────────────────────────────────────────────
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
        const d = r.body?.data || {};
        return ok({
          pages_used: d.pages_used,
          pages_limit: d.pages_limit,
          pages_remaining: (d.pages_limit ?? 0) - (d.pages_used ?? 0),
          projects_used: d.projects_used,
          projects_limit: d.projects_limit,
          projects_remaining: (d.projects_limit ?? 0) - (d.projects_used ?? 0),
        });
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
            pages_count: r.body?.data?.pages_count,
            index_status: r.body?.data?.index_status,
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
        const { repo_root, agent_id, start_path } = a;

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
        return ok({
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
        const r = await cgFetch(`/projects/${a.agent_id}`);
        if (!r.ok) return fail(r);
        const d = r.body?.data || {};
        return ok({
          status: d.index_status || "unknown",
          pages_count: d.pages_count,
          is_chat_active: d.is_chat_active,
          ready: d.index_status === "completed" || d.is_chat_active === 1,
        });
      }

      // ── refresh_index ────────────────────────────────────────────────────
      case "refresh_index": {
        const { repo_root, agent_id, start_path } = a;

        // Delete all existing pages in pages
        let page = 1;
        let deleted = 0;
        while (true) {
          const r = await cgFetch(`/projects/${agent_id}/pages?page=${page}&per_page=100`);
          if (!r.ok || !r.body?.data?.data?.length) break;
          const pages = r.body.data.data;
          for (const p of pages) {
            const dr = await cgFetch(`/projects/${agent_id}/pages/${p.id}`, { method: "DELETE" });
            if (dr.ok) deleted++;
          }
          if (pages.length < 100) break;
          page++;
        }

        // Re-index
        if (!fs.existsSync(start_path)) {
          return ok({ deleted, uploaded: 0, message: `Path not found after clearing: ${start_path}` });
        }

        const files = collectFiles(repo_root, start_path);
        if (files.length === 0) {
          return ok({ deleted, uploaded: 0, message: "No eligible files found to re-index." });
        }

        const results = await uploadFiles(agent_id, files, repo_root);
        return ok({
          deleted,
          total_found: files.length,
          uploaded: results.uploaded,
          failed: results.failed,
          failed_files: results.failed_files,
          message: `🔄 Cleared ${deleted} old pages. Re-uploaded ${results.uploaded} files.`,
        });
      }

      // ── add_files ────────────────────────────────────────────────────────
      case "add_files": {
        const { repo_root, agent_id, paths } = a;
        let files = [];
        for (const p of paths) {
          if (!fs.existsSync(p)) continue;
          files.push(...collectFiles(repo_root, p));
        }
        if (files.length === 0) {
          return ok({ uploaded: 0, message: "No eligible files found in the specified paths." });
        }
        const results = await uploadFiles(agent_id, files, repo_root);
        return ok({
          total_found: files.length,
          uploaded: results.uploaded,
          failed: results.failed,
          failed_files: results.failed_files,
          message: `✅ Added ${results.uploaded} files to the index.`,
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

        const msg = mr.body?.data || {};
        console.error("Raw response from CustomGPT.ai:", JSON.stringify(msg, null, 2));
        const answer = msg?.openai_response || "No answer returned.";

        const citations = (msg?.citations || []).map((c) => ({
          title: c.title || c.url || "Source",
          url: c.url,
          page: c.page,
        }));

        return ok({ answer, citations, session_id: sid });
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
