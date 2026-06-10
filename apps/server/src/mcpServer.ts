import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect } from "effect";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: "2.0";
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
}

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required?: ReadonlyArray<string>;
  };
}

interface McpServeOptions {
  readonly cwd: string;
  readonly toolsets: ReadonlySet<string>;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_TERMINAL_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", ".next", ".turbo"]);

const TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["read_file", "read_file"],
  ["read_text_file", "read_file"],
  ["write_file", "write_file"],
  ["write_text_file", "write_file"],
  ["search_files", "search_files"],
  ["terminal", "terminal"],
  ["skills_list", "skills_list"],
  ["skill_view", "skill_view"],
  ["skill_manage", "skill_manage"],
  ["web_search", "web_search"],
  ["web_extract", "web_extract"],
  ["memory", "memory"],
] as const);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function normalizeToolsets(raw: string | undefined): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const token of (raw ?? "").split(",")) {
    const alias = TOOL_ALIASES.get(token.trim());
    if (alias) {
      selected.add(alias);
    }
  }
  return selected.size > 0 ? selected : new Set(["read_file", "search_files", "skills_list"]);
}

function resolveSafePath(root: string, requestedPath: string): string {
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes MCP root: ${requestedPath}`);
  }
  return resolved;
}

async function readFileTool(root: string, args: Record<string, unknown>): Promise<string> {
  const requestedPath = asString(args.path);
  if (!requestedPath) {
    throw new Error("read_file requires a string path");
  }
  const filePath = resolveSafePath(root, requestedPath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${requestedPath}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to read through MCP: ${requestedPath}`);
  }
  return await fs.readFile(filePath, "utf8");
}

async function writeFileTool(root: string, args: Record<string, unknown>): Promise<string> {
  const requestedPath = asString(args.path);
  const content = asString(args.content);
  if (!requestedPath || content === undefined) {
    throw new Error("write_file requires string path and content");
  }
  const filePath = resolveSafePath(root, requestedPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${requestedPath}`;
}

async function walkFiles(
  root: string,
  visitor: (filePath: string) => Promise<boolean>,
): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
        continue;
      }
      if (entry.isFile()) {
        const shouldContinue = await visitor(path.join(current, entry.name));
        if (!shouldContinue) {
          return;
        }
      }
    }
  }
}

async function searchFilesTool(root: string, args: Record<string, unknown>): Promise<string> {
  const query = asString(args.query)?.toLowerCase();
  if (!query) {
    throw new Error("search_files requires a string query");
  }
  const matches: Array<string> = [];
  await walkFiles(root, async (filePath) => {
    const relativePath = path.relative(root, filePath);
    if (relativePath.toLowerCase().includes(query)) {
      matches.push(relativePath);
    }
    return matches.length < MAX_SEARCH_RESULTS;
  });
  return matches.length > 0 ? matches.join("\n") : "No matching files found.";
}

async function terminalTool(root: string, args: Record<string, unknown>): Promise<string> {
  const command = asString(args.command);
  if (!command) {
    throw new Error("terminal requires a string command");
  }
  if (command.trim() !== command || command.includes("/") || command.includes(" ")) {
    throw new Error("terminal command must be an executable name; pass arguments via args");
  }
  const commandArgs = asStringArray(args.args);
  const timeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
      ? Math.max(1, Math.min(args.timeoutMs, DEFAULT_TERMINAL_TIMEOUT_MS))
      : DEFAULT_TERMINAL_TIMEOUT_MS;

  return await new Promise<string>((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-MAX_TERMINAL_OUTPUT_BYTES);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_TERMINAL_OUTPUT_BYTES);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(
        JSON.stringify(
          {
            code: null,
            signal: null,
            stdout,
            stderr: `${stderr}${error.message}`.slice(-MAX_TERMINAL_OUTPUT_BYTES),
          },
          null,
          2,
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(
        JSON.stringify(
          {
            code,
            signal,
            stdout,
            stderr,
          },
          null,
          2,
        ),
      );
    });
  });
}

const ALL_TOOLS: ReadonlyArray<McpTool> = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the configured workspace root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file inside the configured workspace root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "search_files",
    description: "Find files whose relative path contains the query.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "terminal",
    description: "Run a command in the configured workspace root and return bounded output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
  },
  {
    name: "skills_list",
    description: "List T3 Code MCP skill bridge status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skill_view",
    description: "Return the status of the T3 Code MCP skill-view bridge.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "skill_manage",
    description: "Return the status of the T3 Code MCP skill-management bridge.",
    inputSchema: { type: "object", properties: { action: { type: "string" } } },
  },
  {
    name: "web_search",
    description: "Return the status of the T3 Code MCP web-search bridge.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "web_extract",
    description: "Return the status of the T3 Code MCP web-extract bridge.",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
  },
  {
    name: "memory",
    description: "Return the status of the T3 Code MCP memory bridge.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
];

function availableTools(toolsets: ReadonlySet<string>): ReadonlyArray<McpTool> {
  return ALL_TOOLS.filter((tool) => toolsets.has(tool.name));
}

async function callTool(options: McpServeOptions, name: string, args: Record<string, unknown>) {
  if (!options.toolsets.has(name)) {
    throw new Error(`MCP tool is not enabled: ${name}`);
  }
  switch (name) {
    case "read_file":
      return await readFileTool(options.cwd, args);
    case "write_file":
      return await writeFileTool(options.cwd, args);
    case "search_files":
      return await searchFilesTool(options.cwd, args);
    case "terminal":
      return await terminalTool(options.cwd, args);
    case "skills_list":
      return "Skill bridge is available through the host agent. Direct skill management is not exposed in this MCP adapter yet.";
    case "skill_view":
    case "skill_manage":
    case "web_search":
    case "web_extract":
    case "memory":
      return `${name} is reserved for the native host-agent bridge and is not exposed by this local MCP adapter yet.`;
    default:
      throw new Error(`Unsupported MCP tool: ${name}`);
  }
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(options: McpServeOptions, request: JsonRpcRequest): Promise<void> {
  if (request.id === undefined) {
    return;
  }
  try {
    switch (request.method) {
      case "initialize":
        writeMessage({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "t3-tools", version: "0.0.0" },
          },
        });
        return;
      case "tools/list":
        writeMessage({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: availableTools(options.toolsets) },
        });
        return;
      case "tools/call": {
        const params = asRecord(request.params);
        const name = asString(params.name);
        if (!name) {
          throw new Error("tools/call requires a string name");
        }
        const text = await callTool(options, name, asRecord(params.arguments));
        writeMessage({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text }] },
        });
        return;
      }
      default:
        throw new Error(`Unsupported MCP method: ${request.method ?? "<missing>"}`);
    }
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function serveMcp(options: McpServeOptions): Promise<void> {
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    await handleRequest(options, JSON.parse(trimmed) as JsonRpcRequest);
  }
}

export const runMcpServer = (input: { readonly cwd: string; readonly toolsets?: string }) =>
  Effect.promise(() =>
    serveMcp({
      cwd: path.resolve(input.cwd),
      toolsets: normalizeToolsets(input.toolsets),
    }),
  );
