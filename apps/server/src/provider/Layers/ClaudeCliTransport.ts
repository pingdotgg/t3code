// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalRandom:off
// @effect-diagnostics globalTimers:off
/**
 * ClaudeCliTransport - SDK-free driver for the native `claude` binary.
 *
 * Replaces `@anthropic-ai/claude-agent-sdk`'s `query()` runtime with a direct
 * child-process spawn that speaks the binary's `stream-json` IPC protocol.
 * The shape it returns is intentionally identical to the SDK's query object
 * (`AsyncIterable<SDKMessage>` plus `interrupt/setModel/setPermissionMode/
 * setMaxThinkingTokens/close`) so it drops straight into the existing
 * `createQuery` seam in {@link module:ClaudeAdapterLive} with no downstream
 * changes.
 *
 * Billing rationale: the SDK package is a *type-only* dependency after this
 * change. No SDK runtime code executes, so usage bills against the local
 * `claude` login (subscription) rather than pay-per-token API credits — as
 * long as the caller does not inject ANTHROPIC_API_KEY into `options.env`.
 *
 * Wire protocol (reverse-engineered from sdk.mjs @ 0.2.111 — the contract we
 * must match exactly):
 *
 *  - Base flags: `--output-format stream-json --verbose --input-format
 *    stream-json`. With a `canUseTool` callback the SDK adds
 *    `--permission-prompt-tool stdio`, so permission prompts arrive as
 *    `control_request{subtype:can_use_tool}` on stdout and are answered with
 *    a `control_response` on stdin. No separate MCP server is involved.
 *  - stdin (NDJSON): user messages; our control requests
 *    `{request_id,type:"control_request",request:{subtype}}`; our permission
 *    answers `{type:"control_response",response:{subtype:"success",
 *    request_id,response:<PermissionResult>}}`.
 *  - stdout (NDJSON): SDKMessage objects; `control_response`; inbound
 *    `control_request` (can_use_tool); `control_cancel_request`; plus
 *    `keep_alive` / `transcript_mirror` which are ignored.
 *
 * @module ClaudeCliTransport
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type {
  CanUseTool,
  Options as ClaudeQueryOptions,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The exact interface the Claude adapter expects back from `createQuery`.
 * Mirrors the SDK's query object.
 */
export interface ClaudeCliQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: string) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
  /**
   * Resolves with the CLI's `initialize` control-response payload
   * (`{ account, commands, models, ... }`). The handshake is sent
   * automatically on startup; this returns the (memoised) result. Used by
   * the capabilities/auth probe, which never sends a prompt.
   */
  readonly initialize: () => Promise<InitializeResult>;
}

export interface InitializeResult {
  readonly account?: {
    readonly email?: string;
    readonly subscriptionType?: string;
    readonly tokenSource?: string;
  };
  readonly commands?: ReadonlyArray<unknown>;
  readonly models?: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
}

export interface ClaudeCliQueryInput {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: ClaudeQueryOptions;
}

/** Milliseconds to wait after closing stdin before escalating SIGTERM→SIGKILL. */
const GRACEFUL_SHUTDOWN_MS = 2_000;
const SIGKILL_ESCALATION_MS = 3_000;

/** Treat a path as a JS entrypoint (needs node/bun) if it has a JS/TS ext. */
function isJsEntrypoint(path: string): boolean {
  return [".js", ".mjs", ".cjs", ".tsx", ".ts", ".jsx"].some((ext) => path.endsWith(ext));
}

function defaultExecutable(): string {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ||
    process.versions.bun !== undefined
    ? "bun"
    : "node";
}

function newRequestId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * Build the binary argv from `ClaudeQueryOptions`, mirroring the flag builder
 * in the SDK. Only the options the Claude adapter actually sets are mapped;
 * unknown extras flow through `extraArgs`.
 */
function buildArgs(options: ClaudeQueryOptions): string[] {
  const args: string[] = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
  ];

  const o = options as ClaudeQueryOptions & {
    readonly settings?: unknown;
    readonly extraArgs?: Record<string, string | null>;
    readonly additionalDirectories?: ReadonlyArray<string>;
  };

  if (o.effort) args.push("--effort", String(o.effort));
  if (o.model) args.push("--model", String(o.model));
  if (o.fallbackModel) args.push("--fallback-model", String(o.fallbackModel));

  // A canUseTool callback routes permission prompts through stdio control IPC.
  if (typeof o.canUseTool === "function") {
    args.push("--permission-prompt-tool", "stdio");
  }

  if (o.resume) args.push("--resume", String(o.resume));
  if (o.sessionId) args.push("--session-id", String(o.sessionId));
  if (o.resumeSessionAt) args.push("--resume-session-at", String(o.resumeSessionAt));
  if (o.forkSession) args.push("--fork-session");
  if ((o as { persistSession?: boolean }).persistSession === false) {
    args.push("--no-session-persistence");
  }

  const settingSources = o.settingSources;
  if (settingSources !== undefined) {
    args.push(`--setting-sources=${(settingSources as ReadonlyArray<string>).join(",")}`);
  }

  if (o.permissionMode) args.push("--permission-mode", String(o.permissionMode));
  if (o.allowDangerouslySkipPermissions) args.push("--allow-dangerously-skip-permissions");
  if (o.includePartialMessages) args.push("--include-partial-messages");

  for (const dir of o.additionalDirectories ?? []) {
    args.push("--add-dir", dir);
  }

  // `settings` is a JSON blob the CLI accepts via --settings.
  if (o.settings !== undefined) {
    args.push(
      "--settings",
      typeof o.settings === "string" ? o.settings : JSON.stringify(o.settings),
    );
  }

  // Pass-through extra flags: { "flag-name": value | null }. null = boolean flag.
  for (const [flag, value] of Object.entries(o.extraArgs ?? {})) {
    if (value === null) args.push(`--${flag}`);
    else args.push(`--${flag}`, value);
  }

  return args;
}

/**
 * Build the `initialize` control-request payload, mirroring the SDK. We don't
 * use hooks / sdkMcpServers / jsonSchema, so those stay undefined; the
 * systemPrompt and related fields flow through from options when present.
 */
function buildInitializePayload(options: ClaudeQueryOptions): Record<string, unknown> {
  const o = options as ClaudeQueryOptions & {
    readonly systemPrompt?: unknown;
    readonly appendSystemPrompt?: unknown;
    readonly appendSubagentSystemPrompt?: unknown;
    readonly excludeDynamicSections?: unknown;
    readonly agents?: unknown;
    readonly promptSuggestions?: unknown;
    readonly agentProgressSummaries?: unknown;
  };
  return {
    subtype: "initialize",
    hooks: undefined,
    sdkMcpServers: undefined,
    jsonSchema: undefined,
    systemPrompt: typeof o.systemPrompt === "string" ? [o.systemPrompt] : o.systemPrompt,
    appendSystemPrompt: o.appendSystemPrompt,
    appendSubagentSystemPrompt: o.appendSubagentSystemPrompt,
    excludeDynamicSections: o.excludeDynamicSections,
    agents: o.agents,
    promptSuggestions: o.promptSuggestions,
    agentProgressSummaries: o.agentProgressSummaries,
  };
}

interface AsyncQueue<T> {
  push: (value: T) => void;
  end: () => void;
  fail: (error: unknown) => void;
  iterator: () => AsyncIterator<T>;
}

/**
 * Unbounded async queue bridging push-based stdout framing to the pull-based
 * `for await` the adapter consumes. Matches the buffering semantics of the
 * SDK's internal message stream (and the test FakeClaudeQuery).
 */
function makeAsyncQueue<T>(): AsyncQueue<T> {
  const buffer: T[] = [];
  const waiters: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  let ended = false;
  let failure: unknown | undefined;

  return {
    push(value) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ done: false, value });
      else buffer.push(value);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const w of waiters.splice(0)) w.resolve({ done: true, value: undefined });
    },
    fail(error) {
      if (ended) return;
      ended = true;
      failure = error;
      for (const w of waiters.splice(0)) w.reject(error);
    },
    iterator() {
      return {
        next() {
          if (buffer.length > 0) {
            return Promise.resolve({ done: false, value: buffer.shift() as T });
          }
          if (failure !== undefined) {
            const err = failure;
            failure = undefined;
            return Promise.reject(err);
          }
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };
}

interface ControlRequestEnvelope {
  readonly type: "control_request";
  readonly request_id: string;
  readonly request: {
    readonly subtype: string;
    readonly tool_name?: string;
    readonly input?: Record<string, unknown>;
    readonly permission_suggestions?: unknown;
    readonly blocked_path?: string;
    readonly decision_reason?: unknown;
    readonly title?: string;
  };
}

interface ControlResponseEnvelope {
  readonly type: "control_response";
  readonly response: {
    readonly request_id: string;
    readonly subtype: "success" | "error";
    readonly error?: string;
    readonly response?: unknown;
  };
}

/**
 * Start a `claude` session over stream-json IPC and return a runtime object
 * shaped like the SDK's query.
 */
export function makeClaudeCliQuery(input: ClaudeCliQueryInput): ClaudeCliQueryRuntime {
  const { options } = input;
  const o = options as ClaudeQueryOptions & {
    readonly pathToClaudeCodeExecutable?: string;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly executableArgs?: ReadonlyArray<string>;
    readonly canUseTool?: CanUseTool;
  };

  const binaryPath = o.pathToClaudeCodeExecutable ?? "claude";
  const flags = buildArgs(options);
  const executableArgs = [...(o.executableArgs ?? [])];

  const isJs = isJsEntrypoint(binaryPath);
  const command = isJs ? defaultExecutable() : binaryPath;
  const commandArgs = isJs
    ? [...executableArgs, binaryPath, ...flags]
    : [...executableArgs, ...flags];

  const env = { ...(o.env ?? process.env) };
  // Match the SDK: tag the entrypoint and never leak NODE_OPTIONS into the
  // child (it can crash the bundled CLI).
  if (!env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  delete env.NODE_OPTIONS;

  const child: ChildProcessWithoutNullStreams = spawn(command, commandArgs, {
    cwd: o.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const messages = makeAsyncQueue<SDKMessage>();
  const pendingControl = new Map<
    string,
    { resolve: (r: ControlResponseEnvelope["response"]) => void; reject: (e: unknown) => void }
  >();
  const cancelControllers = new Map<string, AbortController>();
  let closed = false;
  let exited = false;
  let killTimer: NodeJS.Timeout | undefined;

  const writeLine = (obj: unknown): void => {
    if (closed || exited || !child.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* stdin closed underneath us — surfaced via the exit handler */
    }
  };

  // ── stdout NDJSON framing ────────────────────────────────────────────
  let stdoutBuffer = "";
  const handleParsed = (parsed: unknown): void => {
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as { type?: unknown };

    if (record.type === "control_response") {
      const env_ = parsed as ControlResponseEnvelope;
      const pending = pendingControl.get(env_.response.request_id);
      if (pending) {
        pendingControl.delete(env_.response.request_id);
        if (env_.response.subtype === "success") pending.resolve(env_.response);
        else pending.reject(new Error(env_.response.error ?? "control request failed"));
      }
      return;
    }

    if (record.type === "control_request") {
      void handleInboundControlRequest(parsed as ControlRequestEnvelope);
      return;
    }

    if (record.type === "control_cancel_request") {
      const reqId = (parsed as { request_id?: string }).request_id;
      if (reqId) {
        cancelControllers.get(reqId)?.abort();
        cancelControllers.delete(reqId);
      }
      return;
    }

    if (record.type === "keep_alive" || record.type === "transcript_mirror") {
      return;
    }

    messages.push(parsed as SDKMessage);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          handleParsed(JSON.parse(line));
        } catch {
          /* tolerate a malformed line rather than tearing down the stream */
        }
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-4_000);
  });

  // ── inbound can_use_tool → canUseTool callback ───────────────────────
  const handleInboundControlRequest = async (req: ControlRequestEnvelope): Promise<void> => {
    if (req.request.subtype !== "can_use_tool") {
      // Unknown inbound control request: acknowledge with an error so the CLI
      // does not hang waiting for a response.
      writeLine({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: req.request_id,
          error: `Unsupported control request subtype: ${req.request.subtype}`,
        },
      });
      return;
    }

    const callback = o.canUseTool;
    if (typeof callback !== "function") {
      writeLine({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: req.request_id,
          error: "canUseTool callback is not provided.",
        },
      });
      return;
    }

    const controller = new AbortController();
    cancelControllers.set(req.request_id, controller);
    try {
      const result: PermissionResult = await callback(
        req.request.tool_name ?? "",
        req.request.input ?? {},
        {
          signal: controller.signal,
          suggestions: req.request.permission_suggestions,
          blockedPath: req.request.blocked_path,
          decisionReason: req.request.decision_reason,
          title: req.request.title,
        } as unknown as Parameters<CanUseTool>[2],
      );
      writeLine({
        type: "control_response",
        response: { subtype: "success", request_id: req.request_id, response: result },
      });
    } catch (error) {
      writeLine({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: req.request_id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      cancelControllers.delete(req.request_id);
    }
  };

  // ── outbound control request (interrupt / set_* / etc.) ───────────────
  const sendControlRequest = (request: Record<string, unknown>): Promise<unknown> => {
    if (closed || exited) {
      return Promise.reject(new Error("Claude CLI session is closed."));
    }
    const requestId = newRequestId();
    return new Promise((resolve, reject) => {
      pendingControl.set(requestId, {
        resolve: (r) => resolve(r.response),
        reject,
      });
      try {
        writeLine({ request_id: requestId, type: "control_request", request });
      } catch (error) {
        pendingControl.delete(requestId);
        reject(error);
      }
    });
  };

  // ── initialize handshake ─────────────────────────────────────────────
  // Sent synchronously (before the async prompt pump's first write) so the
  // CLI is configured before any user message is processed, matching the
  // SDK which always runs `this.initialization = this.initialize()`.
  const initialization = sendControlRequest(
    buildInitializePayload(options),
  ) as Promise<InitializeResult>;
  // Prevent an unhandled rejection when no one awaits the handshake (the
  // conversational path ignores it; only the probe consumes the result).
  initialization.catch(() => {});

  // ── prompt pump: user messages → stdin NDJSON ─────────────────────────
  void (async () => {
    try {
      for await (const message of input.prompt) {
        if (closed || exited) break;
        writeLine(message);
      }
    } catch {
      /* prompt iterable ended via interruption — normal shutdown path */
    } finally {
      if (!closed && !exited && child.stdin.writable) {
        try {
          child.stdin.end();
        } catch {
          /* already ended */
        }
      }
    }
  })();

  // ── lifecycle ─────────────────────────────────────────────────────────
  child.on("error", (error: Error) => {
    exited = true;
    for (const pending of pendingControl.values()) pending.reject(error);
    pendingControl.clear();
    messages.fail(error);
  });

  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    for (const pending of pendingControl.values()) {
      pending.reject(new Error("Claude CLI session closed."));
    }
    pendingControl.clear();
    if (closed || code === 0 || code === null) {
      messages.end();
    } else {
      const detail = stderrTail.trim();
      messages.fail(
        new Error(
          `Claude CLI exited with code ${code}${signal ? ` (signal ${signal})` : ""}${
            detail ? `: ${detail}` : ""
          }`,
        ),
      );
    }
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      if (child.stdin.writable) child.stdin.end();
    } catch {
      /* already ended */
    }
    killTimer = setTimeout(() => {
      if (exited) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, SIGKILL_ESCALATION_MS).unref?.();
    }, GRACEFUL_SHUTDOWN_MS);
    killTimer.unref?.();
  };

  return {
    [Symbol.asyncIterator]: () => messages.iterator(),
    interrupt: async () => {
      await sendControlRequest({ subtype: "interrupt" });
    },
    setModel: async (model?: string) => {
      await sendControlRequest({ subtype: "set_model", model });
    },
    setPermissionMode: async (mode: string) => {
      await sendControlRequest({ subtype: "set_permission_mode", mode });
    },
    setMaxThinkingTokens: async (maxThinkingTokens: number | null) => {
      await sendControlRequest({
        subtype: "set_max_thinking_tokens",
        max_thinking_tokens: maxThinkingTokens,
      });
    },
    initialize: () => initialization,
    close,
  };
}
