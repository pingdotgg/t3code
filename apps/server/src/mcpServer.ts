import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect, Schema } from "effect";
import type { ModelSelection, ProviderInstanceId, RuntimeMode } from "@t3tools/contracts";
import { resolveWindowsSpawn } from "@t3tools/shared/shell";
import { killProcessTree } from "@t3tools/shared/processTree";
import { ChildDecision, ChildWaitCondition, MessageId, ThreadId } from "@t3tools/contracts";

import { issueCrossThreadDispatchCapability } from "./orchestration/CrossThreadDispatchCapability.ts";
import { composeDelegationPrompt, DELEGATION_PROMPT_BLOCKS } from "./delegationPrompt.ts";
import {
  decodeNestedThreadBatchCreationOutcome,
  decodeNestedThreadCreationOutcome,
  type NestedThreadBatchCreationOutcome,
  type NestedThreadCreationErrorCode,
  type NestedThreadCreationOutcome,
} from "./nestedThreadCreation.ts";

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
  readonly providerInstanceId?: ProviderInstanceId;
  readonly defaultModel?: string;
  /**
   * Settings-backed delegated-thread default. Explicit per-delegation
   * `defaults.model` / `child.model` values always win over this; the parent
   * session model is never inherited. Factory default is Copilot `gpt-6-luna`.
   */
  readonly delegatedDefaultModelSelection?: ModelSelection;
}

export interface McpHttpServer {
  readonly url: string;
  readonly authorization: string;
  readonly close: () => Promise<void>;
}

const MAX_FILE_BYTES = 1024 * 1024;
const decodeChildWait = Schema.decodeUnknownSync(Schema.NullOr(ChildWaitCondition));
const decodeChildDecision = Schema.decodeUnknownSync(ChildDecision);
const MAX_HTTP_REQUEST_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_TERMINAL_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;
const DEFAULT_NESTED_THREAD_BATCH_CONCURRENCY = 4;
const MAX_NESTED_THREAD_BATCH_CONCURRENCY = 4;
const MAX_NESTED_THREAD_BATCH_SIZE = 16;
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
  ["delegate_work", "delegate_work"],
  ["create_nested_thread", "create_nested_thread"],
  ["create_nested_threads", "create_nested_threads"],
  ["send_to_thread", "send_to_thread"],
  ["report_to_parent", "report_to_parent"],
  ["assign_to_thread", "assign_to_thread"],
  ["set_child_wait", "set_child_wait"],
  ["associate_pull_request", "associate_pull_request"],
  ["link_pull_request", "link_pull_request"],
  ["unlink_pull_request", "unlink_pull_request"],
  ["list_thread_pull_requests", "list_thread_pull_requests"],
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

class CommandExecutionError extends Error {
  readonly result: TerminalResult;

  constructor(command: string, args: ReadonlyArray<string>, result: TerminalResult) {
    const detail =
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") ||
      `exited with code ${result.code}`;
    super(`${command} ${args.join(" ")} failed: ${detail}`);
    this.name = "CommandExecutionError";
    this.result = result;
  }
}

async function runCommand(
  root: string,
  command: string,
  args: ReadonlyArray<string>,
): Promise<TerminalResult> {
  const output = await spawnCommand(root, command, args);
  const result = parseTerminalResult(output, `${command} ${args.join(" ")}`.trim());
  if (result.code !== 0) {
    throw new CommandExecutionError(command, args, result);
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

const isDefinitiveCommandRejection = (error: unknown): boolean =>
  error instanceof CommandExecutionError &&
  [error.result.stdout, error.result.stderr].some((output) =>
    output.includes("ORCHESTRATION_COMMAND_REJECTED:"),
  );

/**
 * Parse a spawnCommand envelope. spawnCommand always resolves JSON, but a
 * shared guard keeps malformed payloads as plain Errors (never
 * CommandExecutionError) so commit-ambiguity classification treats them as
 * ambiguous rather than definitive rejections.
 */
function parseTerminalResult(output: string, context: string): TerminalResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${context} returned a non-JSON result envelope`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("code" in parsed) ||
    !("signal" in parsed) ||
    !("stdout" in parsed) ||
    !("stderr" in parsed) ||
    (parsed.code !== null && typeof parsed.code !== "number") ||
    (parsed.signal !== null && typeof parsed.signal !== "string") ||
    typeof parsed.stdout !== "string" ||
    typeof parsed.stderr !== "string"
  ) {
    throw new Error(`${context} returned a malformed result envelope`);
  }
  return {
    code: parsed.code,
    signal: parsed.signal,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
  };
}

interface IsolatedWorkspaceSpec {
  readonly branch: string;
  readonly path: string;
  readonly baseRef: string | undefined;
}

interface WorkspacePreflight {
  readonly workspace: IsolatedWorkspaceSpec;
  readonly baseRef: string;
}

class WorkspaceConflictError extends Error {
  readonly errorCode: NestedThreadCreationErrorCode;

  constructor(errorCode: NestedThreadCreationErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceConflictError";
    this.errorCode = errorCode;
  }
}

class NestedThreadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NestedThreadValidationError";
  }
}

function validateNestedThreadContext(
  options: McpServeOptions,
  toolName: string,
): asserts options is McpServeOptions & {
  readonly threadId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode: RuntimeMode;
} {
  if (!options.threadId) {
    throw new NestedThreadValidationError(
      `${toolName} is only available from a T3 provider session`,
    );
  }
  if (!options.runtimeMode) {
    throw new NestedThreadValidationError(
      `${toolName} requires an authenticated parent runtime mode`,
    );
  }
  if (!options.providerInstanceId) {
    throw new NestedThreadValidationError(
      `${toolName} requires an authenticated parent provider instance`,
    );
  }
}

function parseIsolatedWorkspaceSpec(
  value: Record<string, unknown>,
  toolName: string,
): IsolatedWorkspaceSpec {
  const branch = asString(value.branch)?.trim();
  if (!branch) {
    throw new Error(`${toolName} requires a non-empty workspace branch`);
  }
  return {
    branch,
    path: path.resolve(requireAbsolutePath(asString(value.path), toolName)),
    baseRef: asString(value.baseRef)?.trim() || undefined,
  };
}

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function resolvePathThroughExistingAncestor(targetPath: string): Promise<string> {
  const suffix: Array<string> = [];
  let cursor = path.resolve(targetPath);
  while (true) {
    try {
      const resolvedAncestor = await fs.realpath(cursor);
      return path.join(resolvedAncestor, ...suffix.toReversed());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function createGitWorktree(cwd: string, workspace: IsolatedWorkspaceSpec): Promise<string> {
  const baseRef =
    workspace.baseRef ?? (await runCommand(cwd, "git", ["branch", "--show-current"])).stdout.trim();
  if (!baseRef) {
    throw new Error("Could not determine the current branch; pass baseRef explicitly.");
  }
  await runCommand(cwd, "git", [
    "worktree",
    "add",
    workspace.path,
    "-b",
    workspace.branch,
    baseRef,
  ]);
  return baseRef;
}

async function findExistingAncestor(targetPath: string): Promise<string> {
  let cursor = path.resolve(targetPath);
  while (true) {
    try {
      await fs.lstat(cursor);
      return cursor;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

async function findContainingGitRoot(
  targetPath: string,
): Promise<{ readonly path: string; readonly bare: boolean } | null> {
  let cursor = await findExistingAncestor(targetPath);
  while (true) {
    try {
      await fs.lstat(path.join(cursor, ".git"));
      return { path: cursor, bare: false };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const bareMarkers = await Promise.all(
        ["HEAD", "config", "objects", "refs"].map(async (marker) => {
          try {
            await fs.lstat(path.join(cursor, marker));
            return true;
          } catch (markerError) {
            if (isMissingPathError(markerError)) return false;
            throw markerError;
          }
        }),
      );
      if (bareMarkers.every(Boolean)) return { path: cursor, bare: true };
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

async function findContainingGitCommonDir(targetPath: string): Promise<string | null> {
  const gitRoot = await findContainingGitRoot(targetPath);
  if (gitRoot === null) return null;
  const result = parseTerminalResult(
    await spawnCommand(
      gitRoot.path,
      "git",
      gitRoot.bare
        ? ["--git-dir=.", "rev-parse", "--git-common-dir"]
        : ["rev-parse", "--git-common-dir"],
    ),
    "git rev-parse --git-common-dir",
  );
  if (result.code !== 0) {
    throw new WorkspaceConflictError(
      "WORKSPACE_PREFLIGHT_FAILED",
      `Git repository ownership inspection failed for '${gitRoot.path}'. Resolve the repository error before retrying: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
    );
  }
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new WorkspaceConflictError(
      "WORKSPACE_PREFLIGHT_FAILED",
      `Git repository ownership inspection returned no common directory for '${gitRoot.path}'. Repair the repository before retrying.`,
    );
  }
  return await fs.realpath(
    path.isAbsolute(commonDir) ? commonDir : path.resolve(gitRoot.path, commonDir),
  );
}

const registeredWorktreePaths = (porcelain: string): ReadonlyArray<string> =>
  porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));

async function inspectWorkspaceSideEffects(
  cwd: string,
  workspace: IsolatedWorkspaceSpec,
): Promise<{
  readonly branchCreated: boolean;
  readonly pathCreated: boolean;
  readonly worktreeRegistered: boolean;
}> {
  const [pathStat, branchCheck, worktreeList] = await Promise.all([
    fs.lstat(workspace.path).catch((error) => {
      if (isMissingPathError(error)) return null;
      throw error;
    }),
    spawnCommand(cwd, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${workspace.branch}`]),
    runCommand(cwd, "git", ["worktree", "list", "--porcelain"]),
  ]);
  return {
    branchCreated: parseTerminalResult(branchCheck, "git show-ref").code === 0,
    pathCreated: pathStat !== null,
    worktreeRegistered: registeredWorktreePaths(worktreeList.stdout).includes(workspace.path),
  };
}

async function cleanupNestedWorkspace(
  options: McpServeOptions,
  workspace: IsolatedWorkspaceSpec,
): Promise<void> {
  const sideEffects = await inspectWorkspaceSideEffects(options.cwd, workspace);
  const failures: Array<string> = [];
  if (sideEffects.worktreeRegistered) {
    try {
      await runCommand(options.cwd, "git", ["worktree", "remove", "--force", workspace.path]);
    } catch (error) {
      failures.push(`worktree removal failed: ${toErrorMessage(error)}`);
    }
  } else if (sideEffects.pathCreated) {
    failures.push(
      `path '${workspace.path}' exists without a matching Git worktree registration and was preserved`,
    );
  }

  const afterWorktreeRemoval = await inspectWorkspaceSideEffects(options.cwd, workspace);
  if (
    afterWorktreeRemoval.branchCreated &&
    !afterWorktreeRemoval.pathCreated &&
    !afterWorktreeRemoval.worktreeRegistered
  ) {
    try {
      await runCommand(options.cwd, "git", ["branch", "--delete", "--force", workspace.branch]);
    } catch (error) {
      failures.push(`branch removal failed: ${toErrorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

async function preflightGitWorktree(
  cwd: string,
  input: IsolatedWorkspaceSpec,
): Promise<WorkspacePreflight> {
  const workspace = {
    ...input,
    path: await resolvePathThroughExistingAncestor(input.path),
  };
  const sourceCommonDir = await resolveGitCommonDir(cwd).catch((error) => {
    throw new WorkspaceConflictError(
      "WORKSPACE_PREFLIGHT_FAILED",
      `The calling workspace is not a usable Git repository: ${toErrorMessage(error)}. Open the parent thread in the repository that should own the child worktree.`,
    );
  });
  const baseRef =
    workspace.baseRef ?? (await runCommand(cwd, "git", ["branch", "--show-current"])).stdout.trim();
  if (!baseRef) {
    throw new WorkspaceConflictError(
      "WORKSPACE_BASE_REF_MISSING",
      "Could not determine a base ref from the detached checkout. Pass workspace.baseRef explicitly.",
    );
  }

  const [pathStat, branchFormat, branchCheck, baseRefCheck, worktreeList, containingCommonDir] =
    await Promise.all([
      fs.lstat(workspace.path).catch((error) => {
        if (isMissingPathError(error)) return null;
        throw error;
      }),
      spawnCommand(cwd, "git", ["check-ref-format", "--branch", workspace.branch]),
      spawnCommand(cwd, "git", [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${workspace.branch}`,
      ]),
      spawnCommand(cwd, "git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]),
      runCommand(cwd, "git", ["worktree", "list", "--porcelain"]),
      findContainingGitCommonDir(path.dirname(workspace.path)),
    ]);
  const branchFormatResult = parseTerminalResult(branchFormat, "git check-ref-format");
  if (branchFormatResult.code !== 0) {
    throw new WorkspaceConflictError(
      "WORKSPACE_BRANCH_INVALID",
      `Workspace branch is not a valid Git branch name: ${workspace.branch}. Choose a valid branch name and retry.`,
    );
  }
  if (pathStat !== null) {
    throw new WorkspaceConflictError(
      "WORKSPACE_PATH_OCCUPIED",
      `Workspace path is already occupied: ${workspace.path}. Choose an unused absolute path or remove the stale worktree first.`,
    );
  }
  const branchResult = parseTerminalResult(branchCheck, "git show-ref");
  if (branchResult.code === 0) {
    throw new WorkspaceConflictError(
      "WORKSPACE_BRANCH_EXISTS",
      `Workspace branch already exists: ${workspace.branch}. Choose a new branch or remove the stale branch first.`,
    );
  }
  if (branchResult.code !== 1) {
    throw new WorkspaceConflictError(
      "WORKSPACE_PREFLIGHT_FAILED",
      `Git could not check whether branch '${workspace.branch}' is available. Resolve the repository error and retry: ${branchResult.stderr.trim() || `exit ${String(branchResult.code)}`}`,
    );
  }
  const baseResult = parseTerminalResult(baseRefCheck, "git rev-parse");
  if (baseResult.code !== 0) {
    throw new WorkspaceConflictError(
      "WORKSPACE_BASE_REF_MISSING",
      `Workspace base ref does not resolve to a commit: ${baseRef}. Fetch or choose a valid baseRef and retry.`,
    );
  }
  if (registeredWorktreePaths(worktreeList.stdout).includes(workspace.path)) {
    throw new WorkspaceConflictError(
      "WORKSPACE_PATH_REGISTERED",
      `Workspace path is already registered as a Git worktree: ${workspace.path}. Run 'git worktree prune' for a stale registration or remove the registered worktree before retrying.`,
    );
  }
  if (containingCommonDir !== null && containingCommonDir !== sourceCommonDir) {
    throw new WorkspaceConflictError(
      "WORKSPACE_REPOSITORY_MISMATCH",
      `Workspace path resolves inside a different Git repository: ${workspace.path}. Choose a path owned by this repository or a neutral parent directory.`,
    );
  }

  return { workspace, baseRef };
}

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
    if (isDefinitiveCommandRejection(firstError)) {
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

  const workspace = parseIsolatedWorkspaceSpec(args, "create_isolated_workspace");
  const currentBranch = await createGitWorktree(options.cwd, workspace);

  try {
    await recordThreadWorkspaceBinding(options, workspace.branch, workspace.path);
  } catch (bindingError) {
    if (!isDefinitiveCommandRejection(bindingError)) {
      throw new Error(
        `${toErrorMessage(bindingError)}\nThe worktree was preserved because the server may have committed the handoff despite the lost response. Use switch_workspace with '${workspace.path}' to retry the binding, or inspect chat '${options.threadId}' before removing it.`,
        { cause: bindingError },
      );
    }
    try {
      await rollbackCreatedWorktree(options, workspace.branch, workspace.path);
    } catch (cleanupError) {
      throw new Error(
        `${toErrorMessage(bindingError)}\nWorkspace cleanup also failed: ${toErrorMessage(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw bindingError;
  }

  return JSON.stringify({
    worktreePath: workspace.path,
    branch: workspace.branch,
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

interface NestedThreadToolDependencies {
  readonly beforeWorkspaceRevalidation: () => Promise<void>;
  readonly createWorkspace: (cwd: string, preflight: WorkspacePreflight) => Promise<void>;
  readonly cleanupWorkspace: (
    options: McpServeOptions,
    workspace: IsolatedWorkspaceSpec,
  ) => Promise<void>;
}

const defaultNestedThreadToolDependencies: NestedThreadToolDependencies = {
  beforeWorkspaceRevalidation: () => Promise.resolve(),
  createWorkspace: async (cwd, preflight) => {
    await createGitWorktree(cwd, {
      ...preflight.workspace,
      baseRef: preflight.baseRef,
    });
  },
  cleanupWorkspace: cleanupNestedWorkspace,
};

const serializeNestedThreadOutcome = (outcome: NestedThreadCreationOutcome): string =>
  JSON.stringify(outcome);

const serializeNestedThreadBatchOutcome = (outcome: NestedThreadBatchCreationOutcome): string =>
  JSON.stringify(decodeNestedThreadBatchCreationOutcome(outcome));

const nestedThreadFailure = (
  errorCode: NestedThreadCreationErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly workspaceCreated?: boolean;
    readonly cleanupPerformed?: boolean;
  } = {},
): NestedThreadCreationOutcome => ({
  status: "failed",
  threadId: null,
  threadUrl: null,
  retryable: options.retryable ?? false,
  workspaceCreated: options.workspaceCreated ?? false,
  cleanupPerformed: options.cleanupPerformed ?? false,
  errorCode,
  message,
});

function cliBoundaryFailure(
  dryRun: boolean,
  errorCode: "CLI_EXECUTION_FAILED" | "CLI_RESPONSE_INVALID",
  detail: string,
): NestedThreadCreationOutcome {
  if (dryRun) {
    return {
      status: "failed",
      threadId: null,
      threadUrl: null,
      retryable: true,
      workspaceCreated: false,
      cleanupPerformed: false,
      errorCode,
      message:
        errorCode === "CLI_RESPONSE_INVALID"
          ? `Nested-thread validation returned an invalid structured outcome and made no changes: ${detail}`
          : `Nested-thread validation could not complete and made no changes. Retry after resolving the CLI error: ${detail}`,
    };
  }
  return {
    status: "ambiguous",
    threadId: null,
    threadUrl: null,
    retryable: false,
    workspaceCreated: false,
    cleanupPerformed: false,
    errorCode,
    message:
      errorCode === "CLI_RESPONSE_INVALID"
        ? `The CLI returned an invalid structured creation outcome. Inspect child threads before retrying: ${detail}`
        : `The CLI did not return a structured creation outcome. Inspect child threads before retrying: ${detail}`,
  };
}

function parseNestedThreadCliOutcome(
  result: TerminalResult,
  dryRun: boolean,
): NestedThreadCreationOutcome {
  const outcome = decodeNestedThreadCreationOutcome(JSON.parse(result.stdout.trim()) as unknown);
  const succeeded = result.code === 0;
  if (
    (dryRun && succeeded && outcome.status !== "dry-run") ||
    (dryRun && !succeeded && (outcome.status === "created" || outcome.status === "dry-run")) ||
    (!dryRun && outcome.status === "dry-run")
  ) {
    throw new Error(`CLI outcome status '${outcome.status}' does not match this invocation phase`);
  }
  return outcome;
}

async function invokeNestedThreadCli(
  options: McpServeOptions,
  commandArgs: ReadonlyArray<string>,
  dryRun: boolean,
): Promise<NestedThreadCreationOutcome> {
  let result: TerminalResult;
  try {
    result = await runCommand(options.cwd, options.cliCommand, commandArgs);
  } catch (error) {
    if (error instanceof CommandExecutionError && error.result.stdout.trim()) {
      try {
        return parseNestedThreadCliOutcome(error.result, dryRun);
      } catch {
        return cliBoundaryFailure(dryRun, "CLI_RESPONSE_INVALID", error.result.stdout.trim());
      }
    }
    return cliBoundaryFailure(dryRun, "CLI_EXECUTION_FAILED", toErrorMessage(error));
  }
  try {
    return parseNestedThreadCliOutcome(result, dryRun);
  } catch (error) {
    return cliBoundaryFailure(dryRun, "CLI_RESPONSE_INVALID", toErrorMessage(error));
  }
}

function nestedThreadCommandArgs(
  options: McpServeOptions & {
    readonly threadId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly runtimeMode: RuntimeMode;
  },
  input: {
    readonly project: string;
    readonly title: string;
    readonly prompt: string;
    readonly model: string | undefined;
    readonly reasoning: string | undefined;
    readonly workspace: IsolatedWorkspaceSpec | undefined;
    readonly dryRun: boolean;
    readonly followUp: "automatic" | "notify-only";
    readonly threadId?: string;
    readonly assignmentId?: string;
    readonly parentWait?: ChildWaitCondition | null;
  },
): ReadonlyArray<string> {
  return [
    ...(options.cliArgsPrefix ?? []),
    "--log-level",
    "error",
    "chat",
    "new",
    "--project",
    input.project,
    "--parent",
    options.threadId,
    "--follow-up",
    input.followUp,
    ...(input.threadId ? ["--thread-id", input.threadId] : []),
    ...(input.assignmentId ? ["--assignment-id", input.assignmentId] : []),
    ...(!input.dryRun && input.parentWait !== undefined
      ? ["--parent-wait", JSON.stringify(input.parentWait)]
      : []),
    ...(!input.dryRun
      ? [
          "--cross-thread-source",
          options.threadId,
          "--cross-thread-capability",
          issueCrossThreadDispatchCapability(ThreadId.make(options.threadId)),
        ]
      : []),
    ...(input.model ? ["--provider", options.providerInstanceId, "--model", input.model] : []),
    ...(input.reasoning ? ["--reasoning", input.reasoning] : []),
    "--runtime-mode",
    options.runtimeMode,
    ...(input.workspace
      ? ["--branch", input.workspace.branch, "--worktree", input.workspace.path]
      : []),
    ...(input.dryRun ? ["--dry-run"] : []),
    "--title",
    input.title,
    input.prompt,
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ];
}

interface NestedThreadCreationPolicy {
  readonly toolName: "create_nested_thread" | "create_nested_threads" | "delegate_work";
  readonly requireExplicitProject: boolean;
  readonly requireExplicitModel: boolean;
}

const SINGLE_NESTED_THREAD_POLICY: NestedThreadCreationPolicy = {
  toolName: "create_nested_thread",
  requireExplicitProject: true,
  requireExplicitModel: true,
};

const BATCH_NESTED_THREAD_POLICY: NestedThreadCreationPolicy = {
  toolName: "create_nested_threads",
  requireExplicitProject: true,
  requireExplicitModel: true,
};

const DELEGATE_WORK_POLICY: NestedThreadCreationPolicy = {
  toolName: "delegate_work",
  requireExplicitProject: false,
  requireExplicitModel: false,
};

async function createNestedThreadToolImpl(
  options: McpServeOptions,
  args: Record<string, unknown>,
  dependencies: NestedThreadToolDependencies,
  policy: NestedThreadCreationPolicy = SINGLE_NESTED_THREAD_POLICY,
): Promise<NestedThreadCreationOutcome> {
  validateNestedThreadContext(options, policy.toolName);
  const project = asString(args.project)?.trim() || options.cwd;
  const title = asString(args.title)?.trim();
  const prompt = asString(args.prompt)?.trim();
  const model = asString(args.model)?.trim();
  const reasoning = asString(args.reasoning)?.trim();
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") {
    throw new NestedThreadValidationError(`${policy.toolName} dryRun must be a boolean`);
  }
  const dryRun = args.dryRun === true;
  const followUp = args.followUp === undefined ? "automatic" : args.followUp;
  if (followUp !== "automatic" && followUp !== "notify-only") {
    throw new NestedThreadValidationError("followUp must be automatic or notify-only");
  }
  const threadId = asString(args.threadId)?.trim();
  const assignmentId = asString(args.assignmentId)?.trim();
  if ((threadId === undefined) !== (assignmentId === undefined)) {
    throw new NestedThreadValidationError(
      `${policy.toolName} internal child and assignment identifiers must be provided together`,
    );
  }
  let parentWait: ChildWaitCondition | null | undefined;
  if (args.parentWait !== undefined) {
    try {
      parentWait = decodeChildWait(args.parentWait);
    } catch (error) {
      throw new NestedThreadValidationError(
        `${policy.toolName} parentWait is invalid: ${toErrorMessage(error)}`,
      );
    }
  }
  if (parentWait !== undefined && (followUp !== "automatic" || !threadId)) {
    throw new NestedThreadValidationError(
      `${policy.toolName} parentWait requires an identified automatic child`,
    );
  }
  if (policy.requireExplicitProject && !asString(args.project)?.trim()) {
    throw new NestedThreadValidationError(`${policy.toolName} requires a non-empty project`);
  }
  if (!title)
    throw new NestedThreadValidationError(`${policy.toolName} requires a non-empty title`);
  if (!prompt)
    throw new NestedThreadValidationError(`${policy.toolName} requires a non-empty prompt`);
  if (policy.requireExplicitModel && !model) {
    throw new NestedThreadValidationError(`${policy.toolName} requires a non-empty model`);
  }
  if (reasoning && !model) {
    throw new NestedThreadValidationError(
      `${policy.toolName} reasoning requires an explicit model`,
    );
  }
  // The implicit settings default must not satisfy the explicit-model check above.
  // Resolve it here so reasoning without an explicit model fails before `--reasoning`
  // can be forwarded to whatever implicit model would apply.
  const effectiveModel =
    model ||
    options.delegatedDefaultModelSelection?.model?.trim() ||
    options.defaultModel?.trim() ||
    "gpt-6-luna";

  const childPrompt =
    args.promptTemplate === undefined
      ? prompt
      : composeDelegationPrompt(prompt, args.promptTemplate);

  let workspace: IsolatedWorkspaceSpec | undefined;
  if (args.workspace !== undefined) {
    if (!args.workspace || typeof args.workspace !== "object" || Array.isArray(args.workspace)) {
      throw new NestedThreadValidationError(`${policy.toolName} workspace must be an object`);
    }
    const workspaceInput = asRecord(args.workspace);
    if (asString(workspaceInput.mode) !== "isolated") {
      throw new NestedThreadValidationError(`${policy.toolName} workspace mode must be 'isolated'`);
    }
    try {
      workspace = parseIsolatedWorkspaceSpec(workspaceInput, policy.toolName);
    } catch (error) {
      throw new NestedThreadValidationError(toErrorMessage(error));
    }
  }

  const authenticatedOptions = {
    ...options,
    threadId: options.threadId,
    providerInstanceId:
      options.delegatedDefaultModelSelection?.instanceId ?? options.providerInstanceId,
    runtimeMode: options.runtimeMode,
  };
  const validationOutcome = await invokeNestedThreadCli(
    options,
    nestedThreadCommandArgs(authenticatedOptions, {
      project,
      title,
      prompt: childPrompt,
      model: effectiveModel,
      reasoning,
      workspace,
      dryRun: true,
      followUp,
      ...(threadId ? { threadId } : {}),
      ...(assignmentId ? { assignmentId } : {}),
    }),
    true,
  );
  if (validationOutcome.status !== "dry-run") {
    return validationOutcome;
  }

  if (!workspace) {
    if (dryRun) return validationOutcome;
    const creationOutcome = await invokeNestedThreadCli(
      options,
      nestedThreadCommandArgs(authenticatedOptions, {
        project,
        title,
        prompt: childPrompt,
        model: effectiveModel,
        reasoning,
        workspace,
        dryRun: false,
        followUp,
        ...(threadId ? { threadId } : {}),
        ...(assignmentId ? { assignmentId } : {}),
        ...(parentWait !== undefined ? { parentWait } : {}),
      }),
      false,
    );
    return creationOutcome.status === "created" && assignmentId
      ? { ...creationOutcome, assignmentId }
      : creationOutcome;
  }

  const initialPreflight = await preflightGitWorktree(options.cwd, workspace);
  workspace = initialPreflight.workspace;
  if (dryRun) {
    return {
      ...validationOutcome,
      message: `Nested-thread and workspace preflight passed for '${workspace.path}'; no changes were made.`,
    };
  }

  await dependencies.beforeWorkspaceRevalidation();
  const finalPreflight = await preflightGitWorktree(options.cwd, workspace);
  workspace = finalPreflight.workspace;
  try {
    await dependencies.createWorkspace(options.cwd, finalPreflight);
  } catch (error) {
    let sideEffects: Awaited<ReturnType<typeof inspectWorkspaceSideEffects>>;
    try {
      sideEffects = await inspectWorkspaceSideEffects(options.cwd, workspace);
    } catch (inspectionError) {
      return {
        status: "ambiguous",
        threadId: null,
        threadUrl: null,
        retryable: false,
        workspaceCreated: false,
        cleanupPerformed: false,
        errorCode: "WORKSPACE_CREATE_FAILED",
        message: `Git worktree creation failed and its side effects could not be inspected. Inspect '${workspace.path}' and branch '${workspace.branch}' before retrying. Creation error: ${toErrorMessage(error)}. Inspection error: ${toErrorMessage(inspectionError)}`,
      };
    }
    const workspaceCreated =
      sideEffects.branchCreated || sideEffects.pathCreated || sideEffects.worktreeRegistered;
    if (workspaceCreated) {
      return {
        status: "ambiguous",
        threadId: null,
        threadUrl: null,
        retryable: false,
        workspaceCreated: true,
        cleanupPerformed: false,
        errorCode: "WORKSPACE_CREATE_FAILED",
        message: `Git worktree creation failed while branch, path, or registration state appeared concurrently. It was preserved because ownership is ambiguous. Inspect '${workspace.path}' and branch '${workspace.branch}' before retrying: ${toErrorMessage(error)}`,
      };
    }
    return nestedThreadFailure(
      "WORKSPACE_CREATE_FAILED",
      `Git worktree creation failed without leaving a branch, path, or registration. Creation can be retried safely: ${toErrorMessage(error)}`,
      { retryable: true },
    );
  }

  const creationOutcome = await invokeNestedThreadCli(
    options,
    nestedThreadCommandArgs(authenticatedOptions, {
      project,
      title,
      prompt: childPrompt,
      model: effectiveModel,
      reasoning,
      workspace,
      dryRun: false,
      followUp,
      ...(threadId ? { threadId } : {}),
      ...(assignmentId ? { assignmentId } : {}),
      ...(parentWait !== undefined ? { parentWait } : {}),
    }),
    false,
  );
  if (creationOutcome.status === "dry-run") {
    return cliBoundaryFailure(
      false,
      "CLI_RESPONSE_INVALID",
      "mutating nested-thread creation returned a dry-run outcome",
    );
  }
  if (creationOutcome.status === "created" || creationOutcome.status === "ambiguous") {
    return {
      ...creationOutcome,
      ...(creationOutcome.status === "created" && assignmentId ? { assignmentId } : {}),
      workspaceCreated: true,
    };
  }
  const outcomeWithWorkspace = { ...creationOutcome, workspaceCreated: true };
  if (creationOutcome.threadId !== null) {
    if (!creationOutcome.cleanupPerformed) return outcomeWithWorkspace;
    try {
      const sideEffects = await inspectWorkspaceSideEffects(options.cwd, workspace);
      if (sideEffects.branchCreated || sideEffects.pathCreated || sideEffects.worktreeRegistered) {
        return {
          ...outcomeWithWorkspace,
          retryable: false,
          cleanupPerformed: false,
          message: `${creationOutcome.message} Thread deletion committed, but durable worktree cleanup is still pending. Retry with this branch and path only after dryRun preflight succeeds.`,
        };
      }
      return outcomeWithWorkspace;
    } catch (error) {
      return {
        ...outcomeWithWorkspace,
        retryable: false,
        cleanupPerformed: false,
        errorCode: "WORKSPACE_CLEANUP_FAILED",
        message: `${creationOutcome.message} Thread deletion committed, but worktree cleanup state could not be verified. Inspect '${workspace.path}' before retrying: ${toErrorMessage(error)}`,
      };
    }
  }

  try {
    await dependencies.cleanupWorkspace(options, workspace);
    return {
      ...outcomeWithWorkspace,
      retryable: creationOutcome.retryable,
      cleanupPerformed: true,
      message: `${creationOutcome.message} The child worktree and branch were removed.`,
    };
  } catch (error) {
    return {
      ...outcomeWithWorkspace,
      retryable: false,
      cleanupPerformed: false,
      errorCode: "WORKSPACE_CLEANUP_FAILED",
      message: `${creationOutcome.message} Workspace cleanup also failed; inspect '${workspace.path}' and branch '${workspace.branch}' before retrying: ${toErrorMessage(error)}`,
    };
  }
}

async function createNestedThreadTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
  dependencyOverrides: Partial<NestedThreadToolDependencies> = {},
): Promise<string> {
  try {
    return serializeNestedThreadOutcome(
      await createNestedThreadToolImpl(options, args, {
        ...defaultNestedThreadToolDependencies,
        ...dependencyOverrides,
      }),
    );
  } catch (error) {
    return serializeNestedThreadOutcome(
      nestedThreadFailure(
        error instanceof WorkspaceConflictError ? error.errorCode : "VALIDATION_FAILED",
        toErrorMessage(error),
        { retryable: error instanceof WorkspaceConflictError },
      ),
    );
  }
}

interface BatchWorkspaceIdentity {
  readonly branchKey: string;
  readonly pathKey: string;
}

// Reject case-only variants everywhere so a batch remains portable and cannot race on
// case-insensitive Git ref stores or filesystems.
const portableWorkspaceIdentityKey = (value: string): string =>
  value.normalize("NFC").toLowerCase();

async function batchWorkspaceIdentity(
  args: Record<string, unknown>,
  toolName: string,
): Promise<BatchWorkspaceIdentity | null> {
  if (args.workspace === undefined) return null;
  if (!args.workspace || typeof args.workspace !== "object" || Array.isArray(args.workspace)) {
    throw new NestedThreadValidationError(`${toolName} workspace must be an object`);
  }
  const workspaceInput = asRecord(args.workspace);
  if (asString(workspaceInput.mode) !== "isolated") {
    throw new NestedThreadValidationError(`${toolName} workspace mode must be 'isolated'`);
  }
  const workspace = parseIsolatedWorkspaceSpec(workspaceInput, toolName);
  const resolvedPath = await resolvePathThroughExistingAncestor(workspace.path);
  return {
    branchKey: portableWorkspaceIdentityKey(workspace.branch),
    pathKey: portableWorkspaceIdentityKey(resolvedPath),
  };
}

const batchItemFailure = (error: unknown): NestedThreadCreationOutcome =>
  nestedThreadFailure(
    error instanceof WorkspaceConflictError ? error.errorCode : "VALIDATION_FAILED",
    toErrorMessage(error),
    { retryable: error instanceof WorkspaceConflictError },
  );

async function mapWithConcurrency<T, U>(
  values: ReadonlyArray<T>,
  concurrency: number,
  operation: (value: T, index: number) => Promise<U>,
): Promise<Array<U>> {
  const results = Array.from<U>({ length: values.length });
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await operation(values[index] as T, index);
      }
    }),
  );
  return results;
}

async function createNestedThreadsTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
  dependencyOverrides: Partial<NestedThreadToolDependencies> = {},
  policy: NestedThreadCreationPolicy = BATCH_NESTED_THREAD_POLICY,
): Promise<string> {
  validateNestedThreadContext(options, policy.toolName);
  if (!Array.isArray(args.children)) {
    throw new NestedThreadValidationError(`${policy.toolName} requires a children array`);
  }
  if (args.children.length === 0 || args.children.length > MAX_NESTED_THREAD_BATCH_SIZE) {
    throw new NestedThreadValidationError(
      `${policy.toolName} children must contain between 1 and ${String(MAX_NESTED_THREAD_BATCH_SIZE)} items`,
    );
  }
  const concurrency = args.concurrency ?? DEFAULT_NESTED_THREAD_BATCH_CONCURRENCY;
  if (
    typeof concurrency !== "number" ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_NESTED_THREAD_BATCH_CONCURRENCY
  ) {
    throw new NestedThreadValidationError(
      `${policy.toolName} concurrency must be an integer between 1 and ${String(MAX_NESTED_THREAD_BATCH_CONCURRENCY)}`,
    );
  }

  const children = args.children.map((child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      return null;
    }
    return asRecord(child);
  });
  const identities = await Promise.all(
    children.map(async (child) => {
      if (child === null) return new NestedThreadValidationError("Batch child must be an object");
      try {
        return await batchWorkspaceIdentity(child, policy.toolName);
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    }),
  );
  const branchIndices = new Map<string, Array<number>>();
  const pathIndices = new Map<string, Array<number>>();
  for (const [index, identity] of identities.entries()) {
    if (identity === null || identity instanceof Error) continue;
    const branches = branchIndices.get(identity.branchKey) ?? [];
    branches.push(index);
    branchIndices.set(identity.branchKey, branches);
    const paths = pathIndices.get(identity.pathKey) ?? [];
    paths.push(index);
    pathIndices.set(identity.pathKey, paths);
  }

  const collisionMessages = new Map<number, Array<string>>();
  const recordCollisions = (
    label: "branch" | "path",
    collisions: ReadonlyMap<string, ReadonlyArray<number>>,
  ) => {
    for (const [value, indices] of collisions) {
      if (indices.length < 2) continue;
      for (const index of indices) {
        const messages = collisionMessages.get(index) ?? [];
        messages.push(
          `workspace ${label} '${value}' is also requested by batch item(s) ${indices
            .filter((otherIndex) => otherIndex !== index)
            .join(", ")}`,
        );
        collisionMessages.set(index, messages);
      }
    }
  };
  recordCollisions("branch", branchIndices);
  recordCollisions("path", pathIndices);

  const dependencies = {
    ...defaultNestedThreadToolDependencies,
    ...dependencyOverrides,
  };
  const outcomes = await mapWithConcurrency(children, concurrency, async (child, index) => {
    const identity = identities[index];
    if (identity instanceof Error) return batchItemFailure(identity);
    if (child === null) {
      return batchItemFailure(new NestedThreadValidationError("Batch child must be an object"));
    }
    const collisions = collisionMessages.get(index);
    if (collisions) {
      return nestedThreadFailure(
        "VALIDATION_FAILED",
        `Batch item ${String(index)} was not started because its ${collisions.join(" and its ")}. Every item sharing a branch or canonical path is rejected before mutation.`,
        { retryable: true },
      );
    }
    try {
      return await createNestedThreadToolImpl(options, child, dependencies, policy);
    } catch (error) {
      return batchItemFailure(error);
    }
  });

  return serializeNestedThreadBatchOutcome({
    results: outcomes.map((outcome, index) => ({ index, outcome })),
  });
}

function delegateWorkChild(
  options: McpServeOptions,
  defaults: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  return {
    project: child.project ?? defaults.project ?? options.cwd,
    title: child.title,
    prompt: child.prompt,
    // Keep only the explicit model here. The implicit settings default is resolved
    // in createNestedThreadToolImpl after the explicit-model validation, so
    // `reasoning` without an explicit model fails instead of silently targeting
    // the implicit default.
    model: child.model ?? defaults.model,
    reasoning: child.reasoning ?? defaults.reasoning,
    promptTemplate: child.promptTemplate ?? defaults.promptTemplate,
    followUp: child.followUp ?? defaults.followUp ?? "automatic",
    dryRun: child.dryRun ?? defaults.dryRun,
    workspace: child.workspace,
  };
}

async function delegateWorkTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
  dependencyOverrides: Partial<NestedThreadToolDependencies> = {},
): Promise<string> {
  validateNestedThreadContext(options, "delegate_work");
  const parentThreadId = options.threadId;
  if (!parentThreadId) {
    throw new NestedThreadValidationError("delegate_work requires a T3 provider session");
  }
  if (
    args.defaults !== undefined &&
    (!args.defaults || typeof args.defaults !== "object" || Array.isArray(args.defaults))
  ) {
    throw new NestedThreadValidationError("delegate_work defaults must be an object");
  }
  if (!Array.isArray(args.children)) {
    throw new NestedThreadValidationError("delegate_work requires a children array");
  }
  const defaults = args.defaults === undefined ? {} : asRecord(args.defaults);
  if (
    args.wait !== undefined &&
    args.wait !== "all" &&
    args.wait !== "any" &&
    args.wait !== "none"
  ) {
    throw new NestedThreadValidationError("delegate_work wait must be all, any, or none");
  }
  const children = args.children.map((child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? delegateWorkChild(options, defaults, asRecord(child))
      : child,
  );
  const childIdentities = children.map((child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return null;
    const record = asRecord(child);
    return {
      threadId: crypto.randomUUID(),
      assignmentId: crypto.randomUUID(),
      followUp: record.followUp,
      dryRun: record.dryRun === true,
    };
  });
  const automaticCount = childIdentities.filter(
    (identity) => identity?.followUp === "automatic",
  ).length;
  const waitMode = args.wait ?? (automaticCount > 1 ? "all" : "none");
  if (waitMode !== "none" && automaticCount === 0) {
    throw new NestedThreadValidationError(
      "delegate_work wait all or any requires at least one automatic child",
    );
  }
  const waitableIndices = new Set(
    childIdentities.flatMap((identity, index) =>
      identity?.followUp === "automatic" && !identity.dryRun ? [index] : [],
    ),
  );
  const initialParentWait: ChildWaitCondition | null =
    waitMode === "none"
      ? null
      : {
          mode: waitMode,
          assignments: childIdentities.flatMap((identity, index) =>
            identity && waitableIndices.has(index)
              ? [
                  {
                    childThreadId: ThreadId.make(identity.threadId),
                    assignmentId: MessageId.make(identity.assignmentId),
                  },
                ]
              : [],
          ),
        };
  const preparedChildren = children.map((child, index) => {
    const identity = childIdentities[index];
    if (!identity || !child || typeof child !== "object" || Array.isArray(child)) return child;
    return {
      ...asRecord(child),
      threadId: identity.threadId,
      assignmentId: identity.assignmentId,
      ...(waitableIndices.has(index) ? { parentWait: initialParentWait } : {}),
    };
  });
  const serializedBatch = await createNestedThreadsTool(
    options,
    {
      children: preparedChildren,
      ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
    },
    dependencyOverrides,
    DELEGATE_WORK_POLICY,
  );
  if (waitableIndices.size === 0 || initialParentWait === null) return serializedBatch;

  const batch = decodeNestedThreadBatchCreationOutcome(JSON.parse(serializedBatch) as unknown);
  const assignmentsToRemove = batch.results.flatMap(({ index, outcome }) => {
    const identity = childIdentities[index];
    if (!identity || !waitableIndices.has(index)) return [];
    if (
      outcome.status === "created" ||
      (outcome.status === "ambiguous" && outcome.threadId !== null)
    ) {
      if (outcome.threadId !== identity.threadId) {
        throw new Error(
          `delegate_work child ${String(index)} returned a different thread id than requested.`,
        );
      }
      return [];
    }
    return [
      {
        childThreadId: ThreadId.make(identity.threadId),
        assignmentId: MessageId.make(identity.assignmentId),
      },
    ];
  });
  if (assignmentsToRemove.length > 0) {
    await runCommand(options.cwd, options.cliCommand, [
      ...(options.cliArgsPrefix ?? []),
      "--log-level",
      "error",
      "chat",
      "wait-prune",
      parentThreadId,
      JSON.stringify(assignmentsToRemove),
      ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
    ]);
  }
  return serializedBatch;
}

async function sendToThreadTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
  mode: "message" | "assignment" = "message",
): Promise<string> {
  const toolName = mode === "assignment" ? "assign_to_thread" : "send_to_thread";
  if (!options.threadId) {
    throw new Error(`${toolName} is only available from a T3 provider session`);
  }
  const thread = asString(args.thread)?.trim();
  const prompt = asString(args.prompt)?.trim();
  if (!thread) throw new Error(`${toolName} requires a non-empty thread`);
  if (!prompt) throw new Error(`${toolName} requires a non-empty prompt`);
  const requestId = asString(args.requestId)?.trim();
  const respondToReportId = asString(args.respondToReportId)?.trim();
  const assignmentId = asString(args.assignmentId)?.trim();
  const followUp = args.followUp ?? "automatic";
  if (mode === "assignment" && followUp !== "automatic" && followUp !== "notify-only") {
    throw new Error("followUp must be automatic or notify-only");
  }
  if ((mode === "assignment" || respondToReportId) && !requestId) {
    throw new Error("Tracked assignments and decision responses require a stable requestId.");
  }
  if (respondToReportId && (!assignmentId || mode === "assignment")) {
    throw new Error("A decision response requires its assignmentId and cannot create new work.");
  }

  const result = await runCommand(options.cwd, options.cliCommand, [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "queue",
    "add",
    thread,
    prompt,
    "--cross-thread-source",
    options.threadId,
    "--cross-thread-capability",
    issueCrossThreadDispatchCapability(ThreadId.make(options.threadId)),
    ...(mode === "assignment" ? ["--assignment-follow-up", String(followUp)] : []),
    ...(requestId ? ["--request-id", requestId] : []),
    ...(respondToReportId ? ["--respond-to-report", respondToReportId] : []),
    ...(assignmentId ? ["--assignment-id", assignmentId] : []),
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ]);
  return result.stdout.trim();
}

async function setChildWaitTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
): Promise<string> {
  if (!options.threadId) throw new Error("set_child_wait requires a T3 provider session");
  const condition = decodeChildWait(args.condition);
  const result = await runCommand(options.cwd, options.cliCommand, [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "wait",
    options.threadId,
    JSON.stringify(condition),
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ]);
  return result.stdout.trim();
}

async function reportToParentTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
): Promise<string> {
  if (!options.threadId) throw new Error("report_to_parent requires a T3 provider session");
  const reportId = asString(args.reportId)?.trim();
  const summary = asString(args.summary)?.trim();
  const kind = args.kind;
  const assignmentId = asString(args.assignmentId)?.trim();
  const dispatchId = asString(args.dispatchId)?.trim();
  const decision = args.decision === undefined ? undefined : decodeChildDecision(args.decision);
  if (args.canContinue !== undefined && typeof args.canContinue !== "boolean") {
    throw new Error("canContinue must be a boolean");
  }
  if (
    !reportId ||
    reportId.length > 200 ||
    !summary ||
    summary.length > 4000 ||
    (kind !== "progress" && kind !== "decision-needed" && kind !== "important-update") ||
    !assignmentId ||
    !dispatchId
  ) {
    throw new Error(
      "report_to_parent requires reportId (1-200 characters), summary (1-4000 characters), assignmentId, dispatchId, and a valid kind",
    );
  }
  const originTurnId = asString(args.originTurnId)?.trim();
  if (!originTurnId) {
    throw new Error("report_to_parent requires originTurnId from the current T3 execution context");
  }
  const result = await runCommand(options.cwd, options.cliCommand, [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "report",
    options.threadId,
    summary,
    "--kind",
    kind,
    "--report-id",
    reportId,
    "--assignment-id",
    assignmentId,
    "--dispatch-id",
    dispatchId,
    ...(decision ? ["--decision", JSON.stringify(decision)] : []),
    ...(args.canContinue !== undefined ? ["--can-continue", String(args.canContinue)] : []),
    "--turn-id",
    originTurnId,
    ...(asString(args.supersedesReportId)
      ? ["--supersedes-report", String(args.supersedesReportId)]
      : []),
    "--cross-thread-capability",
    issueCrossThreadDispatchCapability(ThreadId.make(options.threadId)),
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ]);
  return result.stdout.trim();
}

async function associatePullRequestTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
): Promise<string> {
  if (!options.threadId) {
    throw new Error("associate_pull_request is only available from a T3 provider session");
  }

  const reference = asString(args.reference)?.trim();
  if (!reference) {
    throw new Error("associate_pull_request requires a pull request URL or number");
  }

  const result = await runCommand(options.cwd, options.cliCommand, [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "associate-pr",
    options.threadId,
    reference,
    "--cwd",
    options.cwd,
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ]);
  return result.stdout.trim();
}

async function linkPullRequestTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
): Promise<string> {
  if (!options.threadId)
    throw new Error("link_pull_request is only available from a T3 provider session");
  const reference = asString(args.reference)?.trim();
  if (!reference) throw new Error("link_pull_request requires a pull request URL or number");
  const result = await runCommand(options.cwd, options.cliCommand, [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "link-pr",
    options.threadId,
    reference,
    "--cwd",
    options.cwd,
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ]);
  return result.stdout.trim();
}

async function unlinkPullRequestTool(
  options: McpServeOptions,
  args: Record<string, unknown>,
): Promise<string> {
  if (!options.threadId)
    throw new Error("unlink_pull_request is only available from a T3 provider session");
  const reference = asString(args.reference)?.trim();
  if (!reference) throw new Error("unlink_pull_request requires a pull request URL or number");
  const result = await runCommand(options.cwd, options.cliCommand, [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "unlink-pr",
    options.threadId,
    reference,
    "--cwd",
    options.cwd,
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ]);
  return result.stdout.trim();
}

async function listThreadPullRequestsTool(options: McpServeOptions): Promise<string> {
  if (!options.threadId) {
    throw new Error("list_thread_pull_requests is only available from a T3 provider session");
  }
  const result = await runCommand(options.cwd, options.cliCommand, [
    ...(options.cliArgsPrefix ?? []),
    "chat",
    "list-prs",
    options.threadId,
    ...(options.cliBaseDir ? ["--base-dir", options.cliBaseDir] : []),
  ]);
  return result.stdout.trim();
}

const NESTED_THREAD_WORKSPACE_INPUT_SCHEMA = {
  type: "object",
  description: "Optional isolated checkout created and bound to the child before its first turn.",
  properties: {
    mode: { type: "string", enum: ["isolated"] },
    branch: { type: "string" },
    path: { type: "string", description: "Absolute path for the child worktree." },
    baseRef: { type: "string", description: "Optional branch or ref to start from." },
  },
  required: ["mode", "branch", "path"],
  additionalProperties: false,
} as const;

const NESTED_THREAD_PROMPT_TEMPLATE_INPUT_SCHEMA = {
  type: "object",
  description:
    "Optional reusable prompt blocks. Only selected blocks are emitted; canonical ordering prevents contradictory layout, while overrides replace one standard block and additions append to it.",
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: [...DELEGATION_PROMPT_BLOCKS] },
      description:
        "Prompt blocks to compose. investigation-only conflicts with implementation, commit, and push-and-create-pr.",
    },
    repository: {
      type: "object",
      properties: {
        context: { type: "string", minLength: 1 },
        instructionFiles: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
      additionalProperties: false,
    },
    validation: {
      type: "object",
      description: "Required when the validation block is selected.",
      properties: {
        commands: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        scenarios: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
          description: "Observable acceptance criteria, not just pages to visit.",
        },
        evidence: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: ["screenshot", "recording"] },
          description: "Required published media. Requires scenarios.",
        },
        owner: {
          type: "string",
          enum: ["child", "parent"],
          description:
            "Required with scenarios or evidence. Who owns integrated browser validation; parent prevents competing child dev servers.",
        },
      },
      required: ["commands"],
      dependentRequired: {
        scenarios: ["owner"],
        evidence: ["scenarios", "owner"],
      },
      additionalProperties: false,
    },
    commit: {
      type: "object",
      properties: {
        requirements: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
      additionalProperties: false,
    },
    pullRequest: {
      type: "object",
      properties: {
        requirements: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
      additionalProperties: false,
    },
    reporting: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
      additionalProperties: false,
    },
    overrides: {
      type: "object",
      description: "Replacement text keyed by a selected block.",
      properties: Object.fromEntries(
        DELEGATION_PROMPT_BLOCKS.map((block) => [block, { type: "string", minLength: 1 }]),
      ),
      additionalProperties: false,
    },
    additions: {
      type: "object",
      description: "Additional bullet items keyed by a selected block.",
      properties: Object.fromEntries(
        DELEGATION_PROMPT_BLOCKS.map((block) => [
          block,
          {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        ]),
      ),
      additionalProperties: false,
    },
  },
  required: ["blocks"],
  additionalProperties: false,
} as const;

const NESTED_THREAD_INPUT_PROPERTIES = {
  followUp: {
    type: "string",
    enum: ["automatic", "notify-only"],
    description:
      "Automatic (default) queues parent follow-up for results, failures, and actionable reports. Notify-only records updates without waking the parent.",
  },
  project: { type: "string", description: "Project id, title, or workspace root." },
  title: { type: "string" },
  prompt: { type: "string" },
  promptTemplate: NESTED_THREAD_PROMPT_TEMPLATE_INPUT_SCHEMA,
  model: {
    type: "string",
    minLength: 1,
    description: "Any model slug available through the authenticated Copilot provider.",
  },
  reasoning: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
  dryRun: {
    type: "boolean",
    description: "Validate the request and workspace preflight without making changes.",
  },
  workspace: NESTED_THREAD_WORKSPACE_INPUT_SCHEMA,
} as const;

const NESTED_THREAD_REQUIRED_INPUTS = ["project", "title", "prompt", "model"] as const;

const DELEGATE_WORK_DEFAULT_PROPERTIES = {
  followUp: NESTED_THREAD_INPUT_PROPERTIES.followUp,
  project: {
    ...NESTED_THREAD_INPUT_PROPERTIES.project,
    description:
      "Project id, title, or workspace root. Defaults to the authenticated parent workspace.",
  },
  promptTemplate: NESTED_THREAD_INPUT_PROPERTIES.promptTemplate,
  model: {
    ...NESTED_THREAD_INPUT_PROPERTIES.model,
    description:
      "Model slug for every child unless overridden. Defaults to the settings delegated-thread model (factory Copilot gpt-6-luna).",
  },
  reasoning: NESTED_THREAD_INPUT_PROPERTIES.reasoning,
  dryRun: NESTED_THREAD_INPUT_PROPERTIES.dryRun,
} as const;

const DELEGATE_WORK_CHILD_PROPERTIES = {
  title: NESTED_THREAD_INPUT_PROPERTIES.title,
  prompt: NESTED_THREAD_INPUT_PROPERTIES.prompt,
  ...DELEGATE_WORK_DEFAULT_PROPERTIES,
  workspace: NESTED_THREAD_INPUT_PROPERTIES.workspace,
} as const;

const ALL_TOOLS: ReadonlyArray<McpTool> = [
  {
    name: "assign_to_thread",
    description:
      "Create a new tracked assignment in an existing child of this thread. The previous assignment must be finished and have no unresolved decision. Atomically queues the prompt and returns assignmentId. Reuse requestId on retry. For a decision response, use send_to_thread with respondToReportId instead.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string" },
        prompt: { type: "string" },
        requestId: { type: "string", minLength: 1, maxLength: 200 },
        followUp: { type: "string", enum: ["automatic", "notify-only"] },
      },
      required: ["thread", "prompt", "requestId"],
    },
  },
  {
    name: "set_child_wait",
    description:
      "Set when this parent should continue: any selected result, all selected results, or decisions/blockers only. Optionally set deadlineAt as an ISO timestamp; any assignments still unsettled at that deadline are reported as blocked without stopping the children. Pass null to restore automatic follow-up. Use exact assignment IDs from spawn/assignment results or chat show. Membership is fixed; partial spawn failures must be handled explicitly. Never interrupts an active turn or overrides Stop.",
    inputSchema: {
      type: "object",
      properties: {
        condition: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["any", "all", "decisions-only"] },
                deadlineAt: { type: "string", format: "date-time" },
                assignments: {
                  type: "array",
                  maxItems: 32,
                  items: {
                    type: "object",
                    properties: {
                      childThreadId: { type: "string" },
                      assignmentId: { type: "string" },
                    },
                    required: ["childThreadId", "assignmentId"],
                  },
                },
              },
              required: ["mode", "assignments"],
            },
          ],
        },
      },
      required: ["condition"],
    },
  },
  {
    name: "report_to_parent",
    description:
      "Report progress or an early decision/blocker to the authenticated child's parent. Progress never wakes the parent; actionable reports follow the parent's policy and never interrupt it. Reuse reportId when retrying the same report. Results and failures are reported automatically; do not send duplicate completion messages.",
    inputSchema: {
      type: "object",
      properties: {
        reportId: { type: "string", minLength: 1, maxLength: 200 },
        kind: { type: "string", enum: ["progress", "decision-needed", "important-update"] },
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        assignmentId: {
          type: "string",
          description:
            "The assignment that produced this report. Required for reused children; never substitute a newer assignment.",
        },
        dispatchId: {
          type: "string",
          description:
            "The immutable execution dispatch ID provided in the current prompt. Pass it exactly; never infer it from current thread state.",
        },
        decision: {
          type: "object",
          properties: {
            question: { type: "string", minLength: 1, maxLength: 2000 },
            options: { type: "array", maxItems: 8, items: { type: "string", maxLength: 500 } },
            recommendation: { type: "string", maxLength: 1000 },
          },
          required: ["question"],
        },
        canContinue: { type: "boolean" },
        supersedesReportId: {
          type: "string",
          description: "Exact ID of the unresolved decision being replaced.",
        },
        originTurnId: {
          type: "string",
          description:
            "The immutable T3 execution turn ID provided in the current prompt. Pass it exactly; never infer it from current thread state.",
        },
      },
      required: ["reportId", "kind", "summary", "assignmentId", "dispatchId", "originTurnId"],
    },
  },
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
    name: "delegate_work",
    description:
      "Canonical delegation tool for one or many helper threads. Supply children with only title and prompt; shared project, model, reasoning, prompt template, follow-up policy, and dry-run settings belong in defaults and may be overridden per child. Project defaults to the authenticated parent workspace; model defaults to the settings delegated-thread model (factory Copilot gpt-6-luna). For automatic children, wait selects all, any, or no batch wait; the default is all when more than one automatic child is created and none for one child or notify-only work. The wait is installed atomically with child creation and revised to include only created assignments before this tool returns. T3 preserves input order, rejects workspace collisions before mutation, and returns indexed outcomes including partial failures.",
    inputSchema: {
      type: "object",
      properties: {
        defaults: {
          type: "object",
          properties: DELEGATE_WORK_DEFAULT_PROPERTIES,
          additionalProperties: false,
        },
        children: {
          type: "array",
          minItems: 1,
          maxItems: MAX_NESTED_THREAD_BATCH_SIZE,
          items: {
            type: "object",
            properties: DELEGATE_WORK_CHILD_PROPERTIES,
            required: ["title", "prompt"],
            additionalProperties: false,
          },
        },
        concurrency: {
          type: "integer",
          minimum: 1,
          maximum: MAX_NESTED_THREAD_BATCH_CONCURRENCY,
          default: DEFAULT_NESTED_THREAD_BATCH_CONCURRENCY,
          description: "Maximum number of child creations in flight.",
        },
        wait: {
          type: "string",
          enum: ["all", "any", "none"],
          description:
            "Parent follow-up policy for automatic children. Defaults to all for batches with more than one automatic child, otherwise none. Notify-only children are never included.",
        },
      },
      required: ["children"],
    },
  },
  {
    name: "create_isolated_workspace",
    description:
      "Move the current calling thread to a new isolated checkout instead of running git worktree add directly. Creates a Git worktree, durably binds this T3 thread to it, and queues an automatic continuation. Never use this tool to prepare a workspace for a future delegated thread; pass workspace to delegate_work instead. After calling, do not edit the new worktree during the current turn; finish so T3 can restart in the bound workspace and continue automatically.",
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
      "Compatibility only — use delegate_work for every new delegation. Create and start a helper thread nested under the current T3 thread. Every result includes status, threadId, threadUrl, retryable, workspaceCreated, cleanupPerformed, errorCode, and message. When the child needs an isolated checkout, pass workspace here so T3 validates ownership and collisions, revalidates for races, then creates and binds the child before its first turn without moving the parent. Set dryRun to validate without mutation. Always call this tool before any child workspace operation; do not use terminal-based `t3 chat new` for delegation.",
    inputSchema: {
      type: "object",
      properties: NESTED_THREAD_INPUT_PROPERTIES,
      required: NESTED_THREAD_REQUIRED_INPUTS,
    },
  },
  {
    name: "create_nested_threads",
    description:
      "Compatibility only — use delegate_work for every new delegation. Create and start multiple sibling helper threads under the authenticated current T3 thread. Returns one indexed NestedThreadCreationOutcome per child in input order, including partial failures. Runs at most four creations concurrently. Every item sharing a workspace branch or canonical path with another batch item is rejected before mutation; other items continue. Never retry a non-retryable or ambiguous item.",
    inputSchema: {
      type: "object",
      properties: {
        children: {
          type: "array",
          minItems: 1,
          maxItems: MAX_NESTED_THREAD_BATCH_SIZE,
          items: {
            type: "object",
            properties: NESTED_THREAD_INPUT_PROPERTIES,
            required: NESTED_THREAD_REQUIRED_INPUTS,
            additionalProperties: false,
          },
        },
        concurrency: {
          type: "integer",
          minimum: 1,
          maximum: MAX_NESTED_THREAD_BATCH_CONCURRENCY,
          default: DEFAULT_NESTED_THREAD_BATCH_CONCURRENCY,
          description: "Maximum number of child creations in flight.",
        },
      },
      required: ["children"],
    },
  },
  {
    name: "send_to_thread",
    description:
      "Durably queue a prompt for an existing T3 thread from the authenticated current thread. Returns a queuedTurnId immediately; delivery starts in queue order once the destination has no active turn or pending approval/input. Does not interrupt the destination or wait for completion. T3 records the initiating source message as provenance when queued; do not use terminal-based `t3 chat send` for cross-thread messaging.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "Destination thread id or title." },
        prompt: { type: "string" },
        requestId: {
          type: "string",
          description: "Stable retry ID; required for decision responses.",
        },
        assignmentId: { type: "string" },
        respondToReportId: {
          type: "string",
          description: "Resolve this decision atomically with queueing the response.",
        },
      },
      required: ["thread", "prompt"],
    },
  },
  {
    name: "associate_pull_request",
    description:
      "Durably associate a pull request with the authenticated current T3 thread. Call this after successfully creating or explicitly opening a PR for this thread. The URL or number is resolved through GitHub and persisted on the thread; never infer association from the current branch.",
    inputSchema: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description: "Pull request URL or number, such as https://github.com/acme/repo/pull/42.",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "link_pull_request",
    description:
      "Link a pull request to the authenticated current T3 thread without changing its workspace pull request. The operation is idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description: "Pull request URL or number.",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "unlink_pull_request",
    description:
      "Unlink a pull request from the authenticated current T3 thread. The operation is idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description: "Pull request URL or number.",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "list_thread_pull_requests",
    description: "List all pull requests linked to the authenticated current T3 thread.",
    inputSchema: { type: "object", properties: {} },
  },
];

function availableTools(toolsets: ReadonlySet<string>): ReadonlyArray<McpTool> {
  return ALL_TOOLS.filter((tool) => toolsets.has(tool.name));
}

export function fingerprintMcpToolContract(toolsets: ReadonlySet<string>): string {
  return createHash("sha256")
    .update(JSON.stringify(availableTools(toolsets)))
    .digest("hex");
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
    case "delegate_work":
      return await delegateWorkTool(options, args);
    case "create_nested_thread":
      return await createNestedThreadTool(options, args);
    case "create_nested_threads":
      return await createNestedThreadsTool(options, args);
    case "send_to_thread":
      return await sendToThreadTool(options, args);
    case "report_to_parent":
      return await reportToParentTool(options, args);
    case "assign_to_thread":
      return await sendToThreadTool(options, args, "assignment");
    case "set_child_wait":
      return await setChildWaitTool(options, args);
    case "associate_pull_request":
      return await associatePullRequestTool(options, args);
    case "link_pull_request":
      return await linkPullRequestTool(options, args);
    case "unlink_pull_request":
      return await unlinkPullRequestTool(options, args);
    case "list_thread_pull_requests":
      return await listThreadPullRequestsTool(options);
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
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // A malformed line must not kill the stdio server; answer with a
      // parse error and keep serving subsequent requests.
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Malformed JSON-RPC line" },
      });
      continue;
    }
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      // Valid JSON but not a request object (e.g. `null`): handleRequest reads
      // request.id before its try block, so reject here instead of crashing.
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      });
      continue;
    }
    await handleRequest(options, request);
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error("T3_MCP_CLI_ARGS_PREFIX must be a JSON array of strings");
        }
        if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
          throw new Error("T3_MCP_CLI_ARGS_PREFIX must be a JSON array of strings");
        }
        return parsed;
      })(),
    }),
  );

/** Exposed for tests. */
export const __testing = {
  associatePullRequestTool,
  availableTools,
  cleanupNestedWorkspace,
  createIsolatedWorkspaceTool,
  delegateWorkTool,
  createNestedThreadTool,
  createNestedThreadsTool,
  sendToThreadTool,
  reportToParentTool,
  switchWorkspaceTool,
};
