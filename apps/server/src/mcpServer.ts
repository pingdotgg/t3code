import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect } from "effect";
import type { RuntimeMode } from "@t3tools/contracts";
import { resolveWindowsSpawn } from "@t3tools/shared/shell";
import { killProcessTree } from "@t3tools/shared/processTree";

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

export interface McpServeOptions {
  readonly cwd: string;
  readonly toolsets: ReadonlySet<string>;
  readonly threadId: string | undefined;
  readonly cliCommand: string;
  readonly cliArgsPrefix?: ReadonlyArray<string>;
  readonly cliBaseDir?: string;
  readonly runtimeMode?: RuntimeMode;
}

export interface McpHttpServer {
  readonly url: string;
  readonly authorization: string;
  readonly close: () => Promise<void>;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_HTTP_REQUEST_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_TERMINAL_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;
const WORKSPACE_HANDOFF_CONTINUATION_PROMPT =
  "Continue the task from the previous user request in the newly bound workspace. Do not merely acknowledge the workspace change; proceed with the requested work.";
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
  ["preview_screenshot", "preview_screenshot"],
  ["preview_click", "preview_click"],
  ["preview_type", "preview_type"],
  ["preview_annotate", "preview_annotate"],
  ["create_isolated_workspace", "create_isolated_workspace"],
  ["worktree_handoff", "create_isolated_workspace"],
  ["switch_workspace", "switch_workspace"],
  ["use_existing_worktree", "switch_workspace"],
  ["create_nested_thread", "create_nested_thread"],
] as const);

function writeJsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HTTP_REQUEST_BYTES) {
      throw new Error("MCP request body is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function handleMcpHttpRequest(
  options: McpServeOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }

  let body: JsonRpcRequest;
  try {
    body = asRecord(await readJsonRequest(request)) as JsonRpcRequest;
  } catch (error) {
    writeJsonResponse(response, 400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: error instanceof Error ? error.message : "Invalid JSON",
      },
    });
    return;
  }

  if (body.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }

  switch (body.method) {
    case "initialize": {
      const params = asRecord(body.params);
      writeJsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: asString(params.protocolVersion) ?? "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "t3-tools", version: "1.0.0" },
        },
      });
      return;
    }
    case "ping": {
      writeJsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: {},
      });
      return;
    }
    case "tools/list": {
      writeJsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: availableTools(options.toolsets) },
      });
      return;
    }
    case "tools/call": {
      const params = asRecord(body.params);
      const name = asString(params.name);
      if (!name) {
        writeJsonResponse(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            isError: true,
            content: [{ type: "text", text: "tools/call requires a tool name" }],
          },
        });
        return;
      }
      try {
        const text = await callTool(options, name, asRecord(params.arguments));
        writeJsonResponse(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text }] },
        });
      } catch (error) {
        writeJsonResponse(response, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          },
        });
      }
      return;
    }
    default: {
      writeJsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `Method not found: ${body.method ?? ""}` },
      });
    }
  }
}

export async function startMcpHttpServer(options: McpServeOptions): Promise<McpHttpServer> {
  const authorization = `Bearer ${randomUUID()}`;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== authorization) {
      response.writeHead(401, { "www-authenticate": "Bearer" });
      response.end();
      return;
    }
    void handleMcpHttpRequest(options, request, response).catch((error) => {
      if (!response.headersSent) {
        writeJsonResponse(response, 500, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
        });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not resolve the T3 MCP HTTP server address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

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
  return await spawnCommand(root, command, asStringArray(args.args), args.timeoutMs);
}

async function spawnCommand(
  root: string,
  command: string,
  commandArgs: ReadonlyArray<string>,
  requestedTimeoutMs?: unknown,
): Promise<string> {
  const timeoutMs =
    typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs)
      ? Math.max(1, Math.min(requestedTimeoutMs, DEFAULT_TERMINAL_TIMEOUT_MS))
      : DEFAULT_TERMINAL_TIMEOUT_MS;

  return await new Promise<string>((resolve) => {
    const { command: spawnTarget, shell } = resolveWindowsSpawn(command);
    const child = spawn(spawnTarget, [...commandArgs], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      shell,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      killProcessTree(child, "SIGTERM");
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

interface TerminalResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(
  root: string,
  command: string,
  args: ReadonlyArray<string>,
): Promise<TerminalResult> {
  const output = await spawnCommand(root, command, args);
  const result = JSON.parse(output) as TerminalResult;
  if (result.code !== 0) {
    const detail =
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") ||
      `exited with code ${result.code}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function requireAbsolutePath(value: string | undefined, toolName: string): string {
  if (!value) {
    throw new Error(`${toolName} requires an absolute path`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${toolName} path must be absolute: ${value}`);
  }
  return value;
}

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isDefinitiveBindingRejection = (error: unknown): boolean =>
  toErrorMessage(error).includes("ORCHESTRATION_COMMAND_REJECTED:");

async function recordThreadWorkspaceBinding(
  options: McpServeOptions,
  branch: string,
  worktreePath: string,
): Promise<void> {
  if (!options.threadId) {
    throw new Error("Workspace binding is only available from a T3 provider session");
  }
  const commandId = `workspace-handoff:${randomUUID()}`;
  const commandArgs = [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "handoff",
    options.threadId,
    "--branch",
    branch,
    "--worktree",
    worktreePath,
    "--continue-prompt",
    WORKSPACE_HANDOFF_CONTINUATION_PROMPT,
    "--command-id",
    commandId,
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ];
  try {
    await runCommand(options.cwd, options.cliCommand, commandArgs);
  } catch (firstError) {
    if (isDefinitiveBindingRejection(firstError)) {
      throw firstError;
    }
    try {
      await runCommand(options.cwd, options.cliCommand, commandArgs);
    } catch (retryError) {
      throw new Error(
        `Workspace binding failed after retry.\nFirst attempt: ${toErrorMessage(firstError)}\nRetry: ${toErrorMessage(retryError)}`,
        { cause: retryError },
      );
    }
  }
}

async function rollbackCreatedWorktree(
  options: McpServeOptions,
  branch: string,
  worktreePath: string,
): Promise<void> {
  await runCommand(options.cwd, "git", ["worktree", "remove", "--force", worktreePath]);
  await runCommand(options.cwd, "git", ["branch", "--delete", "--force", branch]);
}

async function resolveGitCommonDir(cwd: string): Promise<string> {
  const result = await runCommand(cwd, "git", ["rev-parse", "--git-common-dir"]);
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new Error(`Could not resolve the Git common directory for ${cwd}`);
  }
  return await fs.realpath(path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir));
}

async function createIsolatedWorkspaceTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
): Promise<string> {
  if (!options.threadId) {
    throw new Error("create_isolated_workspace is only available from a T3 provider session");
  }

  const branch = asString(args.branch);
  if (!branch?.trim()) {
    throw new Error("create_isolated_workspace requires a non-empty branch");
  }
  const branchName = branch.trim();
  const targetPath = requireAbsolutePath(asString(args.path), "create_isolated_workspace");
  const baseRef = asString(args.baseRef);

  const currentBranch =
    baseRef ?? (await runCommand(options.cwd, "git", ["branch", "--show-current"])).stdout.trim();
  if (!currentBranch) {
    throw new Error("Could not determine the current branch; pass baseRef explicitly.");
  }

  await runCommand(options.cwd, "git", [
    "worktree",
    "add",
    targetPath,
    "-b",
    branchName,
    currentBranch,
  ]);

  try {
    await recordThreadWorkspaceBinding(options, branchName, targetPath);
  } catch (bindingError) {
    if (!isDefinitiveBindingRejection(bindingError)) {
      throw new Error(
        `${toErrorMessage(bindingError)}\nThe worktree was preserved because the server may have committed the handoff despite the lost response. Use switch_workspace with '${targetPath}' to retry the binding, or inspect chat '${options.threadId}' before removing it.`,
        { cause: bindingError },
      );
    }
    try {
      await rollbackCreatedWorktree(options, branchName, targetPath);
    } catch (cleanupError) {
      throw new Error(
        `${toErrorMessage(bindingError)}\nWorkspace cleanup also failed: ${toErrorMessage(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw bindingError;
  }

  return JSON.stringify({
    worktreePath: targetPath,
    branch: branchName,
    baseRef: currentBranch,
    continuationQueued: true,
    note: "Handoff recorded. Stop this turn now without editing the new worktree, and without explaining the handoff or the turn boundary to the user: T3 already shows the move in the transcript and resumes the task automatically in the bound workspace.",
  });
}

async function switchWorkspaceTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
): Promise<string> {
  const targetPath = requireAbsolutePath(asString(args.path), "switch_workspace");
  const [sourceCommonDir, targetCommonDir, branchResult] = await Promise.all([
    resolveGitCommonDir(options.cwd),
    resolveGitCommonDir(targetPath),
    runCommand(targetPath, "git", ["branch", "--show-current"]),
  ]);
  if (sourceCommonDir !== targetCommonDir) {
    throw new Error("switch_workspace can only bind a worktree from the same Git repository");
  }
  const branch = branchResult.stdout.trim();
  if (!branch) {
    throw new Error("switch_workspace requires the target worktree to have a checked-out branch");
  }

  await recordThreadWorkspaceBinding(options, branch, targetPath);
  return JSON.stringify({
    worktreePath: targetPath,
    branch,
    continuationQueued: true,
    note: "Handoff recorded. Stop this turn now without editing the new worktree, and without explaining the handoff or the turn boundary to the user: T3 already shows the move in the transcript and resumes the task automatically in the bound workspace.",
  });
}

async function createNestedThreadTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
): Promise<string> {
  if (!options.threadId) {
    throw new Error("create_nested_thread is only available from a T3 provider session");
  }
  const project = asString(args.project)?.trim();
  const title = asString(args.title)?.trim();
  const prompt = asString(args.prompt)?.trim();
  const model = asString(args.model)?.trim();
  const reasoning = asString(args.reasoning)?.trim();
  if (!project) throw new Error("create_nested_thread requires a non-empty project");
  if (!title) throw new Error("create_nested_thread requires a non-empty title");
  if (!prompt) throw new Error("create_nested_thread requires a non-empty prompt");
  if (!model) throw new Error("create_nested_thread requires a non-empty model");
  if (!reasoning) throw new Error("create_nested_thread requires a non-empty reasoning level");

  if (!options.runtimeMode) {
    throw new Error("create_nested_thread requires an authenticated parent runtime mode");
  }
  const result = await runCommand(options.cwd, options.cliCommand, [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "new",
    "--project",
    project,
    "--parent",
    options.threadId,
    "--provider",
    "copilot",
    "--model",
    model,
    "--reasoning",
    reasoning,
    "--runtime-mode",
    options.runtimeMode,
    "--title",
    title,
    prompt,
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ]);
  return result.stdout.trim();
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
  {
    name: "preview_screenshot",
    description: "Capture the current desktop browser preview tab as a screenshot.",
    inputSchema: { type: "object", properties: { tabId: { type: "string" } } },
  },
  {
    name: "preview_click",
    description: "Click the element matching a CSS selector in a desktop browser preview tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" }, selector: { type: "string" } },
    },
  },
  {
    name: "preview_type",
    description: "Replace the text in an element matching a CSS selector in a preview tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
      },
    },
  },
  {
    name: "preview_annotate",
    description: "Highlight and label the element matching a CSS selector in a preview tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" }, selector: { type: "string" } },
    },
  },
  {
    name: "create_isolated_workspace",
    description:
      "Required instead of running git worktree add directly when this thread needs a new isolated checkout. Creates a Git worktree, durably binds this T3 thread to it, and queues an automatic continuation. After calling, do not edit the new worktree during the current turn; finish so T3 can restart in the bound workspace and continue automatically.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string" },
        path: { type: "string", description: "Absolute path for the new worktree." },
        baseRef: { type: "string", description: "Optional branch or ref to start from." },
      },
      required: ["branch", "path"],
    },
  },
  {
    name: "switch_workspace",
    description:
      "Required instead of running git worktree move/remove or editing another checkout directly when this thread must use an existing worktree. Validates that the path belongs to the same Git repository, durably binds the thread, and queues an automatic continuation. After calling, finish so T3 can restart there and continue automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of an existing Git worktree." },
      },
      required: ["path"],
    },
  },
  {
    name: "create_nested_thread",
    description:
      "Create and start a helper thread nested under the current T3 thread. Uses the authenticated current thread identity and flavor-scoped CLI automatically; do not use terminal-based `t3 chat new` for delegation.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id, title, or workspace root." },
        title: { type: "string" },
        prompt: { type: "string" },
        model: { type: "string", enum: ["gpt-5.6-sol", "gpt-5.6-terra"] },
        reasoning: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
      },
      required: ["project", "title", "prompt", "model", "reasoning"],
    },
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
    case "preview_screenshot":
    case "preview_click":
    case "preview_type":
    case "preview_annotate":
      return `${name} requires the desktop preview bridge. This lightweight MCP adapter runs in the backend process and cannot access Electron webviews directly yet.`;
    case "create_isolated_workspace":
      return await createIsolatedWorkspaceTool(options, args);
    case "switch_workspace":
      return await switchWorkspaceTool(options, args);
    case "create_nested_thread":
      return await createNestedThreadTool(options, args);
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
      threadId: process.env.T3_MCP_THREAD_ID,
      cliCommand: process.env.T3_MCP_CLI_COMMAND?.trim() || "t3",
      cliArgsPrefix: (() => {
        const raw = process.env.T3_MCP_CLI_ARGS_PREFIX?.trim();
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
          throw new Error("T3_MCP_CLI_ARGS_PREFIX must be a JSON array of strings");
        }
        return parsed;
      })(),
    }),
  );

/** Exposed for tests. */
export const __testing = {
  availableTools,
  createIsolatedWorkspaceTool,
  createNestedThreadTool,
  switchWorkspaceTool,
};
