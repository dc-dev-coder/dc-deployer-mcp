/**
 * DC Deployer — MCP Server
 * Vercel Serverless Function (Node.js)
 *
 * MCP Tools exposed to Claude:
 *   - write_files      → push files to any GitHub repo via mapping rules
 *   - list_accounts    → list configured GitHub accounts
 *   - check_deployment → check latest Vercel deployment status for a project
 */

const ACCOUNTS = (() => {
  const raw = process.env.GITHUB_ACCOUNTS || "";
  // Format: "label:token,label2:token2"
  const accounts = {};
  raw.split(",").forEach((entry) => {
    const idx = entry.indexOf(":");
    if (idx === -1) return;
    const label = entry.slice(0, idx).trim();
    const token = entry.slice(idx + 1).trim();
    if (label && token) accounts[label] = token;
  });
  return accounts;
})();

const API_KEY = process.env.MCP_API_KEY || "";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || "";

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseRules(rulesText) {
  const rules = {};
  (rulesText || "").split("\n").forEach((line) => {
    if (!line.includes("=>")) return;
    const [src, dest] = line.split("=>").map((s) => s.trim());
    if (src && dest) rules[src.toLowerCase()] = dest.replace(/^\//, "");
  });
  return rules;
}

async function getFileSHA(token, owner, repo, path, branch) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": "dc-deployer-mcp" } }
  );
  if (!res.ok) return undefined;
  const data = await res.json();
  return data.sha;
}

async function pushFile(token, owner, repo, branch, path, base64Content) {
  const sha = await getFileSHA(token, owner, repo, path, branch);
  const body = {
    message: `sync: ${path} [dc-deployer]`,
    content: base64Content,
    branch,
    ...(sha ? { sha } : {}),
  };

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "dc-deployer-mcp",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub error on ${path}: ${err.message || res.status}`);
  }
  return await res.json();
}

// ─── Tool Handlers ───────────────────────────────────────────────────────────

async function handleWriteFiles({ account, repo, branch = "main", rules = "", files }) {
  if (!account) throw new Error("account is required");
  if (!repo) throw new Error("repo is required (format: owner/repo)");
  if (!files || !Array.isArray(files) || files.length === 0)
    throw new Error("files array is required and must not be empty");

  const token = ACCOUNTS[account];
  if (!token) throw new Error(`Account "${account}" not found. Available: ${Object.keys(ACCOUNTS).join(", ")}`);

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) throw new Error('repo must be in format "owner/repo"');

  const mappingRules = parseRules(rules);
  const results = [];

  for (const file of files) {
    const { name, content } = file;
    if (!name || !content) {
      results.push({ file: name || "unknown", status: "skipped", reason: "missing name or content" });
      continue;
    }

    // Apply mapping rule (case-insensitive filename match)
    const mapped = mappingRules[name.toLowerCase()];
    const targetPath = mapped || name.replace(/^\//, "");

    try {
      await pushFile(token, owner, repoName, branch, targetPath, content);
      results.push({ file: name, targetPath, status: "success" });
    } catch (err) {
      results.push({ file: name, targetPath, status: "error", reason: err.message });
    }
  }

  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "error").length;

  return {
    summary: `${succeeded} file(s) pushed, ${failed} failed`,
    repo,
    branch,
    results,
  };
}

function handleListAccounts() {
  const names = Object.keys(ACCOUNTS);
  if (names.length === 0) return { accounts: [], message: "No accounts configured. Set GITHUB_ACCOUNTS env var." };
  return { accounts: names };
}

async function handleCheckDeployment({ project, team }) {
  if (!VERCEL_TOKEN) throw new Error("VERCEL_TOKEN env var not set");
  if (!project) throw new Error("project name is required");

  const teamParam = team ? `&teamId=${team}` : "";
  const res = await fetch(
    `https://api.vercel.com/v6/deployments?app=${encodeURIComponent(project)}&limit=1${teamParam}`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
  );

  if (!res.ok) throw new Error(`Vercel API error: ${res.status}`);
  const data = await res.json();
  const deployment = data.deployments?.[0];

  if (!deployment) return { status: "none", message: "No deployments found for this project" };

  return {
    id: deployment.uid,
    project: deployment.name,
    state: deployment.state,           // READY, ERROR, BUILDING, QUEUED, CANCELED
    url: deployment.url ? `https://${deployment.url}` : null,
    createdAt: new Date(deployment.createdAt).toISOString(),
    ready: deployment.state === "READY",
    error: deployment.state === "ERROR",
  };
}

// ─── MCP Protocol ────────────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: "write_files",
    description:
      "Push one or more files to a GitHub repository. Applies mapping rules to place each file at the correct path. Files must be base64-encoded.",
    inputSchema: {
      type: "object",
      required: ["account", "repo", "files"],
      properties: {
        account: { type: "string", description: "GitHub account label (from saved accounts)" },
        repo: { type: "string", description: 'Repository in format "owner/repo"' },
        branch: { type: "string", description: "Target branch (default: main)", default: "main" },
        rules: {
          type: "string",
          description:
            "Mapping rules, one per line. Format: filename.ext => path/to/target.ext\nExample: r2.ts => apps/web/src/lib/r2.ts",
        },
        files: {
          type: "array",
          description: "Array of files to push",
          items: {
            type: "object",
            required: ["name", "content"],
            properties: {
              name: { type: "string", description: "Original filename (used to match mapping rules)" },
              content: { type: "string", description: "File content encoded as base64" },
            },
          },
        },
      },
    },
  },
  {
    name: "list_accounts",
    description: "List all configured GitHub accounts available for pushing files.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_deployment",
    description:
      "Check the latest Vercel deployment status for a project. Returns state (READY, BUILDING, ERROR, etc.) and deployment URL.",
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: { type: "string", description: "Vercel project name" },
        team: { type: "string", description: "Vercel team ID (optional)" },
      },
    },
  },
];

// ─── Request Router ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS — Claude.ai needs this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth check
  if (API_KEY) {
    const provided =
      req.headers["x-api-key"] ||
      (req.headers["authorization"] || "").replace("Bearer ", "");
    if (provided !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // MCP uses POST for all JSON-RPC calls
  if (req.method !== "POST") {
    // GET → health check
    return res.status(200).json({ status: "DC Deployer MCP is running ✅", tools: MCP_TOOLS.map((t) => t.name) });
  }

  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== "2.0") {
    return res.status(400).json({ error: "Expected JSON-RPC 2.0" });
  }

  try {
    // ── initialize ──
    if (method === "initialize") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "dc-deployer", version: "1.0.0" },
        },
      });
    }

    // ── tools/list ──
    if (method === "tools/list") {
      return res.status(200).json({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
    }

    // ── tools/call ──
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      let result;

      if (name === "write_files") result = await handleWriteFiles(args);
      else if (name === "list_accounts") result = handleListAccounts();
      else if (name === "check_deployment") result = await handleCheckDeployment(args);
      else throw new Error(`Unknown tool: ${name}`);

      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
    }

    // ── notifications/initialized (no response needed) ──
    if (method === "notifications/initialized") {
      return res.status(200).end();
    }

    return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  } catch (err) {
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err.message },
    });
  }
}
