/**
 * Maps canonical provider runtime events onto OpenTelemetry GenAI spans.
 *
 * One `invoke_agent` span covers a provider turn. Tool items become
 * `execute_tool` children. Claude and Codex report usage per model response,
 * and each of those reports closes a `chat` child. Everything is derived from
 * events every adapter already emits, so this module never talks to a
 * provider. Values a provider does not expose are omitted, not guessed.
 *
 * Timing notes that matter when reading the spans:
 * - Tool spans end at the provider's item completion. Claude starts a tool
 *   item when the model begins streaming the call, so its span opens when the
 *   response listing the call ends (or at completion, if the tool finished
 *   first, which Claude Code does for tools it runs while still streaming).
 *   `t3.tool.call_streaming_ms` keeps the streaming time.
 * - `chat` spans come from `model.response.completed`, where adapters report
 *   each response's request start, first chunk, and end. Claude's start is
 *   its own time-to-first-token subtracted from the first chunk; Codex's is
 *   when it recorded the request's last input item. Sessions without that
 *   event (a resumed Codex thread) fall back to per-response usage, and the
 *   span starts at the previous observed boundary. `t3.genai.chat.start_source`
 *   always says which.
 *
 * @module observability/AgentTelemetry
 */
import { classifyTaskAgentKind, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

const AGENT_NAME_PREFIX = "T3 Code";

const MAX_TEXT_CHARS = 32_000;
const MAX_JSON_STRING_CHARS = 16_000;
const STREAM_TRUNCATED_MARKER = "… [truncated]";
/** How long a sent prompt waits for its turn to start before it is dropped. */
const PENDING_INPUT_TTL_MS = 5 * 60_000;

// Logfire's default scrubbing patterns, applied to structured tool argument
// keys only. Matching free text would redact ordinary transcript sentences.
const SENSITIVE_KEY_PATTERN = new RegExp(
  [
    "password",
    "passwd",
    "mysql_pwd",
    "secret",
    "auth(?!ors?\\b)",
    "credential",
    "private[._ -]?key",
    "api[._ -]?key",
    "session",
    "cookie",
    "csrf",
    "xsrf",
    "jwt",
    // Not in Logfire's defaults; catches access_token, refresh_token, etc.
    "token",
    "ssn",
    "social[._ -]?security",
    "credit[._ -]?card",
  ].join("|"),
  "iu",
);

interface ProviderIdentity {
  readonly label: string;
  /** `gen_ai.provider.name` for the model vendor, when the driver implies one. */
  readonly genAiProvider?: string;
  /** Whether the driver reports usage once per model response. */
  readonly reportsRequestUsage: boolean;
  /**
   * The driver starts a tool item while the model is still streaming the
   * call and runs it after the response ends (Claude Code does both).
   */
  readonly toolStartsWhileStreaming?: boolean;
}

const PROVIDER_IDENTITIES: Record<string, ProviderIdentity> = {
  claudeAgent: {
    label: "Claude",
    genAiProvider: "anthropic",
    reportsRequestUsage: true,
    toolStartsWhileStreaming: true,
  },
  codex: { label: "Codex", genAiProvider: "openai", reportsRequestUsage: true },
  cursor: { label: "Cursor", reportsRequestUsage: false },
  grok: { label: "Grok", genAiProvider: "xai", reportsRequestUsage: false },
  opencode: { label: "OpenCode", reportsRequestUsage: false },
  antigravity: { label: "Antigravity", reportsRequestUsage: false },
};

function providerIdentity(driver: string): ProviderIdentity {
  return PROVIDER_IDENTITIES[driver] ?? { label: driver, reportsRequestUsage: false };
}

/** Stable agent name per provider driver, e.g. `T3 Code / Claude`. */
function agentNameForDriver(driver: string): string {
  return `${AGENT_NAME_PREFIX} / ${providerIdentity(driver).label}`;
}

type MessagePart =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "thinking"; readonly content: string }
  | {
      type: "tool_call";
      readonly id: string;
      readonly name: string;
      arguments?: unknown;
    }
  | {
      readonly type: "tool_call_response";
      readonly id: string;
      readonly name: string;
      readonly result: unknown;
    };

interface Message {
  readonly role: "user" | "assistant";
  readonly parts: Array<MessagePart>;
  finish_reason?: string;
}

interface ToolRun {
  /** Unset until execution is known to have started; see `openToolSpan`. */
  span: Tracer.Span | undefined;
  readonly spanName: string;
  /**
   * An execution inside a model tool call that the adapter reported
   * separately (a Codex `exec` script running shell or MCP tools). It has
   * native tool details but is not counted as another direct model call.
   */
  readonly nested: boolean;
  readonly parent: Tracer.AnySpan;
  readonly attributes: Map<string, unknown>;
  readonly itemId: string;
  readonly name: string;
  readonly startMs: number;
  readonly call: Extract<MessagePart, { type: "tool_call" }>;
  approvalWaitMs: number;
  approvalOpenedAtMs: number | undefined;
}

/** A tool call the model made, reported by the adapter rather than an item. */
interface ModelToolCall {
  readonly span: Tracer.Span;
  readonly name: string;
  readonly startMs: number;
  failedExecutions: number;
}

interface FinishDetails {
  readonly errorMessage?: string | undefined;
  readonly stopReason?: string | null | undefined;
  readonly totalCostUsd?: number | undefined;
  readonly modelUsage?: Record<string, unknown> | undefined;
  readonly tokenUsage?:
    | {
        readonly usageStatus: string;
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly cachedInputTokens?: number | undefined;
        readonly cacheCreationTokens?: number | undefined;
      }
    | undefined;
}

interface AgentRun {
  readonly threadId: string;
  readonly turnId: string;
  readonly driver: string;
  readonly identity: ProviderIdentity;
  readonly agentName: string;
  readonly span: Tracer.Span;
  readonly startMs: number;
  /** Current model; a reroute changes it for later responses. */
  model: string | undefined;
  readonly transcript: Array<Message>;
  /** Messages observed since the last closed model response. */
  newMessages: Array<Message>;
  output: Message | undefined;
  outputStartedMs: number | undefined;
  requestStartMs: number;
  requestStartSource: "turn_start" | "previous_response" | "tool_result";
  readonly tools: Map<string, ToolRun>;
  readonly subagents: Map<string, Tracer.Span>;
  readonly assistantText: Map<string, string>;
  readonly reasoningText: Map<string, string>;
  lastAssistantText: string | undefined;
  modelRequests: number;
  toolCallingRequests: number;
  toolCalls: number;
  failedToolCalls: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  lastCodexTotal: string | undefined;
  /** Set once the adapter reports response boundaries for this run. */
  responseEvents: boolean;
  readonly modelCalls: Map<string, ModelToolCall>;
  toolExecutions: number;
  /** Execution items ended early; their late completions are ignored. */
  readonly retiredItemIds: Set<string>;
  promptRecorded: boolean;
}

export interface TurnInputNote {
  readonly threadId: string;
  readonly text: string | undefined;
  readonly attachmentCount: number;
  readonly model: string | undefined;
  readonly link: Tracer.AnySpan | undefined;
}

export interface AgentTelemetryOptions {
  readonly tracer: Tracer.Tracer;
  readonly captureContent: boolean;
  /** Attributes added to every agent span, e.g. host and app version. */
  readonly staticAttributes: Readonly<Record<string, string>>;
  /** Wall clock in milliseconds, used only when an event time is unreadable. */
  readonly nowMs: () => number;
  /** Session facts looked up when a turn starts. */
  readonly sessionFacts?: (threadId: string) =>
    | {
        readonly model?: string | undefined;
        readonly cwd?: string | undefined;
        readonly instanceId?: string | undefined;
      }
    | undefined;
}

const toNanos = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function truncateText(text: string, limit = MAX_TEXT_CHARS): string {
  if (text.length <= limit) return text;
  // Already capped while streaming.
  if (
    text.length <= limit + STREAM_TRUNCATED_MARKER.length &&
    text.endsWith(STREAM_TRUNCATED_MARKER)
  ) {
    return text;
  }
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

/** Redacts sensitive keys and bounds string sizes in structured tool data. */
function sanitizeStructured(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateText(value, MAX_JSON_STRING_CHARS);
  if (depth > 8) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeStructured(v, depth + 1));
  const record = asRecord(value);
  if (!record) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    // Like Logfire's scrubber: a sensitive key hides any value except plain
    // booleans, numbers, and null, so nested objects and arrays cannot leak.
    const keepsValue = entry === null || typeof entry === "boolean" || typeof entry === "number";
    const match = keepsValue ? null : key.match(SENSITIVE_KEY_PATTERN);
    out[key] = match ? `[Scrubbed due to '${match[0]}']` : sanitizeStructured(entry, depth + 1);
  }
  return out;
}

function sanitizeArguments(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return sanitizeStructured(JSON.parse(value));
    } catch {
      // Custom tools such as Codex exec accept code rather than JSON.
    }
  }
  return sanitizeStructured(value);
}

function toolResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const texts = value.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) return [];
      if (typeof record.text === "string") return [record.text];
      if (record.type === "image") return ["[image]"];
      return [];
    });
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  return undefined;
}

interface ToolCallFacts {
  readonly name: string;
  readonly arguments: unknown;
  readonly result: unknown;
  readonly error: string | undefined;
  readonly providerDurationMs: number | undefined;
}

/** Reads tool name, arguments, and result from a canonical item payload. */
function readToolCall(
  driver: string,
  payload: {
    readonly itemType: string;
    readonly title?: string | undefined;
    readonly data?: unknown;
  },
): ToolCallFacts {
  const data = asRecord(payload.data);
  if (driver === "claudeAgent") {
    const resultBlock = asRecord(data?.result);
    const resultText = toolResultText(resultBlock?.content);
    return {
      name: asString(data?.toolName) ?? payload.title ?? payload.itemType,
      arguments: data?.input,
      result: resultText ?? resultBlock?.content,
      error: resultBlock?.is_error === true ? (resultText ?? "Tool reported an error") : undefined,
      providerDurationMs: undefined,
    };
  }
  if (driver === "codex") {
    const item = asRecord(data?.item) ?? {};
    const type = asString(item.type) ?? payload.itemType;
    const error = asString(asRecord(item.error)?.message);
    switch (type) {
      case "commandExecution":
        return {
          name: "command_execution",
          arguments: { command: item.command, cwd: item.cwd },
          result:
            item.aggregatedOutput === undefined && item.exitCode === undefined
              ? undefined
              : { exit_code: item.exitCode, output: item.aggregatedOutput },
          error:
            typeof item.exitCode === "number" && item.exitCode !== 0
              ? `Exit code ${item.exitCode}`
              : error,
          providerDurationMs: asCount(item.durationMs),
        };
      case "mcpToolCall":
        return {
          name: `${asString(item.server) ?? "mcp"}.${asString(item.tool) ?? "tool"}`,
          arguments: item.arguments,
          result: item.result,
          error,
          providerDurationMs: asCount(item.durationMs),
        };
      case "dynamicToolCall":
        return {
          name: asString(item.tool) ?? "dynamic_tool",
          arguments: item.arguments,
          result: item.contentItems ?? item.result,
          error,
          providerDurationMs: asCount(item.durationMs),
        };
      case "fileChange":
        return {
          name: "file_change",
          arguments: {
            changes: Array.isArray(item.changes)
              ? item.changes.map((change) => {
                  const record = asRecord(change);
                  return { path: record?.path, kind: record?.kind };
                })
              : undefined,
          },
          result: Array.isArray(item.changes)
            ? item.changes.map((change) => asRecord(change)?.diff)
            : undefined,
          error,
          providerDurationMs: undefined,
        };
      case "webSearch":
        return {
          name: "web_search",
          arguments: { query: item.query },
          result: item.action,
          error,
          providerDurationMs: undefined,
        };
      default: {
        const { id: _id, status: _status, ...rest } = item;
        return {
          name: type,
          arguments: rest,
          result: undefined,
          error,
          providerDurationMs: asCount(item.durationMs),
        };
      }
    }
  }
  // ACP-style adapters (Cursor, Grok, OpenCode, Antigravity) vary; read the
  // common shapes and fall back to the item title.
  return {
    name: asString(data?.toolName) ?? asString(data?.name) ?? payload.title ?? payload.itemType,
    arguments: data?.input ?? data?.rawInput ?? data?.args ?? data?.arguments,
    result: data?.result ?? data?.output ?? data?.rawOutput,
    error: asString(asRecord(data?.error)?.message) ?? asString(data?.error),
    providerDurationMs: undefined,
  };
}

interface RequestUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number | undefined;
  readonly cacheWrite: number | undefined;
  readonly reasoning: number | undefined;
  readonly finishReason: string | undefined;
}

interface ResponseTiming {
  readonly startMs: number;
  readonly startSource: "provider_ttft" | "input_recorded";
  readonly firstChunkMs: number | undefined;
  readonly responseModel: string | undefined;
  readonly responseId: string | undefined;
}

interface ResponseToolFacts {
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments?: unknown;
  }>;
}

/**
 * Per-response usage from a Codex `tokenUsage.last` snapshot. Only used when
 * the session does not report `model.response.completed` (a resumed Codex
 * thread). Input tokens include cache writes, matching Pydantic AI.
 */
function readRequestUsage(
  event: Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>,
): (RequestUsage & { readonly codexTotalKey?: string }) | undefined {
  const raw = event.raw;
  if (!raw) return undefined;
  if (raw.method === "thread/tokenUsage/updated") {
    const tokenUsage = asRecord(asRecord(raw.payload)?.tokenUsage);
    const last = asRecord(tokenUsage?.last);
    if (!last) return undefined;
    const cacheWrite = asCount(last.cacheWriteInputTokens);
    return {
      input: (asCount(last.inputTokens) ?? 0) + (cacheWrite ?? 0),
      output: asCount(last.outputTokens) ?? 0,
      cacheRead: asCount(last.cachedInputTokens),
      cacheWrite,
      reasoning: asCount(last.reasoningOutputTokens),
      finishReason: undefined,
      codexTotalKey: JSON.stringify(tokenUsage?.total ?? null),
    };
  }
  return undefined;
}

const JSON_SCHEMA_AGENT = JSON.stringify({
  type: "object",
  properties: {
    "pydantic_ai.all_messages": { type: "array" },
  },
});
const JSON_SCHEMA_CHAT = JSON.stringify({
  type: "object",
  properties: {
    "gen_ai.input.messages": { type: "array" },
    "gen_ai.output.messages": { type: "array" },
  },
});
const JSON_SCHEMA_TOOL = JSON.stringify({
  type: "object",
  properties: {
    "gen_ai.tool.call.arguments": { type: "object" },
    "gen_ai.tool.call.result": { type: "object" },
  },
});

function exitFailure(message: string): Exit.Exit<unknown, unknown> {
  const error = new Error(message);
  error.name = "AgentRunError";
  error.stack = `${error.name}: ${message}`;
  return Exit.fail(error);
}

const exitInterrupted = (): Exit.Exit<unknown, unknown> => Exit.failCause(Cause.interrupt());

/**
 * Stateful recorder for one server process. Feed it every canonical runtime
 * event plus the input text of each sent turn; it opens and closes spans.
 */
export class AgentTelemetryRecorder {
  private readonly runs = new Map<string, AgentRun>();
  /** Sends not yet matched to a turn start, with when they were noted. */
  private readonly pendingInputs: Array<{
    readonly id: number;
    readonly note: TurnInputNote;
    readonly notedAtMs: number;
    /** Set once `sendTurn` returned the turn this send belongs to. */
    turnId: string | undefined;
  }> = [];
  private nextInputId = 1;
  /**
   * Subagents still running when their parent turn ended (Claude background
   * agents). They end when their own terminal event arrives.
   */
  private readonly detachedSubagents = new Map<
    string,
    { readonly span: Tracer.Span; readonly threadId: string }
  >();
  /**
   * Finished runs whose thread still has an unbound send. A fast turn can end
   * before `sendTurn` returns its id, so the run waits for that binding (or
   * for `abandonTurnInput`) before its span ends.
   */
  private readonly heldRuns = new Map<
    string,
    { run: AgentRun; state: string; details: FinishDetails; atMs: number }
  >();

  private readonly options: AgentTelemetryOptions;

  constructor(options: AgentTelemetryOptions) {
    this.options = options;
  }

  private eventMs(event: { readonly createdAt: string }): number {
    const parsed = Date.parse(event.createdAt);
    return Number.isFinite(parsed) ? parsed : this.options.nowMs();
  }

  /**
   * Records the text T3 is about to send. It is noted before `sendTurn`
   * because a fast turn can start and finish before `sendTurn` returns; the
   * returned id binds it to its turn afterwards with `bindTurnInput`.
   */
  noteTurnInput(note: TurnInputNote): number {
    // A send whose turn never starts (it failed or was cancelled) must not
    // hold its prompt forever.
    const nowMs = this.options.nowMs();
    for (let index = this.pendingInputs.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingInputs[index]!;
      if (nowMs - pending.notedAtMs > PENDING_INPUT_TTL_MS) {
        this.pendingInputs.splice(index, 1);
        this.releaseHeldRuns(pending.note.threadId);
      }
    }
    const id = this.nextInputId++;
    this.pendingInputs.push({
      id,
      note: { ...note, text: note.text === undefined ? undefined : truncateText(note.text) },
      notedAtMs: nowMs,
      turnId: undefined,
    });
    return id;
  }

  /** Ties a noted send to the turn `sendTurn` started or steered. */
  bindTurnInput(inputId: number, turnId: string): void {
    const index = this.pendingInputs.findIndex((pending) => pending.id === inputId);
    if (index < 0) return;
    const pending = this.pendingInputs[index]!;
    const key = `${pending.note.threadId}:${turnId}`;
    const run = this.runs.get(key) ?? this.heldRuns.get(key)?.run;
    if (!run) {
      pending.turnId = turnId;
      this.releaseHeldRuns(pending.note.threadId);
      return;
    }
    this.pendingInputs.splice(index, 1);
    if (pending.note.link) {
      run.span.addLinks([
        { span: pending.note.link, attributes: { "t3.link": "provider.sendTurn" } },
      ]);
    }
    // The first send is the turn's prompt; later ones steer it.
    this.addUserMessage(
      run,
      pending.note,
      !run.promptRecorded,
      this.heldRuns.get(key)?.atMs ?? this.options.nowMs(),
    );
    this.releaseHeldRuns(pending.note.threadId);
  }

  /** Drops a noted send whose `sendTurn` failed. */
  abandonTurnInput(inputId: number): void {
    const index = this.pendingInputs.findIndex((pending) => pending.id === inputId);
    if (index < 0) return;
    const [pending] = this.pendingInputs.splice(index, 1);
    this.releaseHeldRuns(pending!.note.threadId);
  }

  /** Ends a thread's held runs once none of its sends is still unbound. */
  private releaseHeldRuns(threadId: string, force = false): void {
    if (!force && this.hasUnboundInput(threadId)) return;
    for (const [key, held] of Array.from(this.heldRuns)) {
      if (held.run.threadId !== threadId) continue;
      this.heldRuns.delete(key);
      this.endRun(held.run, held.state, held.details, held.atMs);
    }
  }

  private hasUnboundInput(threadId: string): boolean {
    return this.pendingInputs.some(
      (pending) => pending.note.threadId === threadId && pending.turnId === undefined,
    );
  }

  handle(event: ProviderRuntimeEvent): void {
    switch (event.type) {
      case "turn.started":
        this.startRun(event);
        return;
      case "turn.completed":
        this.finishRun(event, event.payload.state, event.payload);
        return;
      case "turn.aborted":
        this.finishRun(event, "interrupted", { errorMessage: event.payload.reason });
        return;
      case "session.exited": {
        for (let index = this.pendingInputs.length - 1; index >= 0; index -= 1) {
          if (this.pendingInputs[index]!.note.threadId === event.threadId) {
            this.pendingInputs.splice(index, 1);
          }
        }
        this.releaseHeldRuns(event.threadId, true);
        this.endDetachedSubagents(event.threadId, this.eventMs(event));
        const run = this.activeRun(event.threadId);
        if (run) {
          this.finishRun(
            { ...event, turnId: run.turnId as never },
            event.payload.exitKind === "error" ? "failed" : "interrupted",
            { errorMessage: event.payload.reason ?? "Provider session exited" },
          );
        }
        return;
      }
      default:
        break;
    }
    if (
      (event.type === "task.completed" || event.type === "task.updated") &&
      this.detachedSubagents.has(event.payload.taskId)
    ) {
      this.onTaskEnd(undefined, event, this.eventMs(event));
      return;
    }
    const run = this.runFor(event);
    if (!run) return;
    const at = this.eventMs(event);
    switch (event.type) {
      case "content.delta":
        this.onDelta(run, event, at);
        return;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.onItem(run, event, at);
        return;
      case "thread.token-usage.updated":
        this.onUsage(run, event, at);
        return;
      case "model.response.completed":
        this.onResponse(run, event, at);
        return;
      case "model.tool_call.started":
        this.startModelToolCall(run, event, at);
        return;
      case "model.tool_call.completed":
        this.finishModelToolCall(run, event, at);
        return;
      case "request.opened":
      case "request.resolved":
        this.onRequest(run, event, at);
        return;
      case "task.started":
        this.onTaskStarted(run, event, at);
        return;
      case "task.completed":
      case "task.updated":
        this.onTaskEnd(run, event, at);
        return;
      case "runtime.error":
        run.span.event("runtime.error", toNanos(at), {
          "error.message": event.payload.message,
          ...(event.payload.class ? { "error.class": event.payload.class } : {}),
        });
        return;
      case "runtime.warning":
        run.span.event("runtime.warning", toNanos(at), {
          message: event.payload.message,
        });
        return;
      case "model.rerouted":
        run.model = event.payload.toModel;
        run.span.event("model.rerouted", toNanos(at), {
          from: event.payload.fromModel,
          to: event.payload.toModel,
          reason: event.payload.reason,
        });
        return;
      default:
        return;
    }
  }

  /** Ends every open span, for server shutdown. */
  private endDetachedSubagents(threadId: string | undefined, atMs: number): void {
    for (const [taskId, detached] of Array.from(this.detachedSubagents)) {
      if (threadId !== undefined && detached.threadId !== threadId) continue;
      this.detachedSubagents.delete(taskId);
      detached.span.end(toNanos(atMs), exitInterrupted());
    }
  }

  closeAll(reason: string): void {
    for (const held of Array.from(this.heldRuns.values())) {
      this.releaseHeldRuns(held.run.threadId, true);
    }
    const atMs = this.options.nowMs();
    for (const run of Array.from(this.runs.values())) {
      this.endRun(run, "interrupted", { errorMessage: reason }, atMs);
    }
    this.endDetachedSubagents(undefined, atMs);
  }

  get openRunCount(): number {
    return this.runs.size + this.heldRuns.size;
  }

  private activeRun(threadId: string): AgentRun | undefined {
    for (const run of this.runs.values()) {
      if (run.threadId === threadId) return run;
    }
    return undefined;
  }

  private runFor(event: ProviderRuntimeEvent): AgentRun | undefined {
    if (event.turnId !== undefined) {
      return this.runs.get(`${event.threadId}:${event.turnId}`);
    }
    return this.activeRun(event.threadId);
  }

  private startSpan(
    name: string,
    parent: Tracer.AnySpan | undefined,
    startMs: number,
    attributes: Record<string, unknown>,
    links: Array<Tracer.SpanLink> = [],
  ): Tracer.Span {
    const span = this.options.tracer.span({
      name,
      parent: parent ? Option.some(parent) : Option.none(),
      annotations: Context.empty(),
      links,
      startTime: toNanos(startMs),
      kind: "internal",
      root: parent === undefined,
      sampled: true,
    });
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.attribute(key, value);
    }
    // Logfire shows a span only once it ends. A zero-length pending twin
    // makes a long agent run or tool call visible while it is still running.
    const pending = this.options.tracer.span({
      name,
      parent: Option.some(span),
      annotations: Context.empty(),
      links: [],
      startTime: toNanos(startMs),
      kind: "internal",
      root: false,
      sampled: true,
    });
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) pending.attribute(key, value);
    }
    pending.attribute("logfire.span_type", "pending_span");
    pending.attribute("logfire.pending_parent_id", parent ? parent.spanId : "0000000000000000");
    pending.end(toNanos(startMs), Exit.void);
    return span;
  }

  private startRun(event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>): void {
    if (!event.turnId) return;
    const existing = this.activeRun(event.threadId);
    const at = this.eventMs(event);
    if (existing) {
      if (existing.turnId === event.turnId) return;
      this.endRun(existing, "interrupted", { errorMessage: "Superseded by a new turn" }, at);
    }
    const identity = providerIdentity(event.provider);
    const agentName = agentNameForDriver(event.provider);
    const facts = this.options.sessionFacts?.(event.threadId);
    // Sends already bound to this turn, in order: a prompt, then any steers.
    // Unbound sends wait for `bindTurnInput`; a turn that started meanwhile
    // (a Claude background turn) must not take them.
    const turnId = event.turnId;
    const notes = this.pendingInputs
      .filter((pending) => pending.note.threadId === event.threadId && pending.turnId === turnId)
      .map((pending) => pending.note);
    for (let index = this.pendingInputs.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingInputs[index]!;
      if (notes.includes(pending.note)) this.pendingInputs.splice(index, 1);
    }
    const note = notes[0];
    const model = event.payload.model ?? note?.model ?? facts?.model;
    const cwd = facts?.cwd;
    const workspaceName = cwd ? cwd.split(/[\\/]/u).findLast((part) => part.length > 0) : undefined;
    const span = this.startSpan(
      `invoke_agent ${agentName}`,
      undefined,
      at,
      {
        "logfire.msg": `${agentName} run`,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": agentName,
        "gen_ai.agent.call.id": event.turnId,
        "gen_ai.conversation.id": event.threadId,
        "gen_ai.provider.name": identity.genAiProvider,
        "gen_ai.system": identity.genAiProvider,
        "gen_ai.request.model": model,
        "t3.provider.driver": event.provider,
        "t3.provider.instance_id": event.providerInstanceId ?? facts?.instanceId,
        "t3.thread.id": event.threadId,
        "t3.turn.id": event.turnId,
        "t3.workspace.name": workspaceName,
        "t3.genai.content_captured": this.options.captureContent,
        "t3.genai.transcript_scope": "observed provider events in this turn",
        "t3.genai.system_instructions_captured": false,
        "t3.genai.provider_history_captured": false,
        "t3.genai.message_character_limit": MAX_TEXT_CHARS,
        "t3.genai.tool_string_character_limit": MAX_JSON_STRING_CHARS,
        "logfire.json_schema": JSON_SCHEMA_AGENT,
        ...this.options.staticAttributes,
      },
      note?.link ? [{ span: note.link, attributes: { "t3.link": "provider.sendTurn" } }] : [],
    );
    const run: AgentRun = {
      threadId: event.threadId,
      turnId: event.turnId,
      driver: event.provider,
      identity,
      agentName,
      span,
      startMs: at,
      model,
      transcript: [],
      newMessages: [],
      output: undefined,
      outputStartedMs: undefined,
      requestStartMs: at,
      requestStartSource: "turn_start",
      tools: new Map(),
      subagents: new Map(),
      assistantText: new Map(),
      reasoningText: new Map(),
      lastAssistantText: undefined,
      modelRequests: 0,
      toolCallingRequests: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      lastCodexTotal: undefined,
      responseEvents: false,
      modelCalls: new Map(),
      toolExecutions: 0,
      retiredItemIds: new Set(),
      promptRecorded: false,
    };
    this.runs.set(`${event.threadId}:${event.turnId}`, run);
    notes.forEach((entry, index) => this.addUserMessage(run, entry, index === 0, at));
  }

  private addUserMessage(run: AgentRun, note: TurnInputNote, isPrompt: boolean, at: number): void {
    if (isPrompt) run.promptRecorded = true;
    const text = note.text ?? "";
    const parts: Array<MessagePart> =
      this.options.captureContent && text.length > 0
        ? [{ type: "text", content: truncateText(text) }]
        : [];
    if (note.attachmentCount > 0) {
      run.span.attribute("t3.input.attachment_count", note.attachmentCount);
    }
    run.span.attribute("t3.input.chars", text.length);
    if (parts.length === 0) return;
    const message: Message = { role: "user", parts };
    if (isPrompt) {
      // A prompt noted after the turn started still opens the conversation.
      run.transcript.unshift(message);
      run.newMessages.unshift(message);
    } else {
      run.transcript.push(message);
      run.newMessages.push(message);
    }
    this.emitMessage(run, message, at);
  }

  /** Export completed messages immediately; no span per streamed token. */
  private emitMessage(run: AgentRun, message: Message, at: number): void {
    if (!this.options.captureContent || message.parts.length === 0) return;
    const preview = message.parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join(" ")
      .replace(/\s+/gu, " ");
    const span = this.options.tracer.span({
      name: `${message.role} message`,
      parent: Option.some(run.span),
      annotations: Context.empty(),
      links: [],
      startTime: toNanos(at),
      kind: "internal",
      root: false,
      sampled: true,
    });
    const key = message.role === "user" ? "gen_ai.input.messages" : "gen_ai.output.messages";
    span.attribute("logfire.span_type", "log");
    span.attribute("logfire.level_num", 9);
    span.attribute(
      "logfire.msg",
      `${message.role}: ${preview.length > 160 ? `${preview.slice(0, 160)}…` : preview}`,
    );
    span.attribute("logfire.json_schema", JSON_SCHEMA_CHAT);
    span.attribute(key, JSON.stringify([message]));
    span.attribute("gen_ai.conversation.id", run.threadId);
    span.attribute("t3.turn.id", run.turnId);
    span.end(toNanos(at), Exit.void);
  }

  private currentOutput(run: AgentRun, at: number): Message {
    if (!run.output) {
      run.output = { role: "assistant", parts: [] };
      run.outputStartedMs = at;
      run.transcript.push(run.output);
    }
    return run.output;
  }

  private onDelta(
    run: AgentRun,
    event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>,
    at: number,
  ): void {
    const key = event.itemId ?? "default";
    if (event.payload.streamKind === "assistant_text") {
      this.currentOutput(run, at);
      run.assistantText.set(key, appendCapped(run.assistantText.get(key), event.payload.delta));
    } else if (
      event.payload.streamKind === "reasoning_text" ||
      event.payload.streamKind === "reasoning_summary_text"
    ) {
      this.currentOutput(run, at);
      run.reasoningText.set(key, appendCapped(run.reasoningText.get(key), event.payload.delta));
    }
  }

  /** Starts a tool's span (once) with every attribute recorded so far. */
  private openToolSpan(tool: ToolRun, startMs: number): Tracer.Span {
    if (!tool.span) {
      tool.span = this.startSpan(
        tool.spanName,
        tool.parent,
        startMs,
        Object.fromEntries(tool.attributes),
      );
    }
    return tool.span;
  }

  private onItem(
    run: AgentRun,
    event: Extract<
      ProviderRuntimeEvent,
      { type: "item.started" | "item.updated" | "item.completed" }
    >,
    at: number,
  ): void {
    const payload = event.payload;
    const itemId = event.itemId ?? "";
    if (payload.itemType === "assistant_message" && event.type === "item.completed") {
      const text = run.assistantText.get(itemId) ?? payload.detail ?? this.codexItemText(event);
      run.assistantText.delete(itemId);
      if (text && text.trim().length > 0) {
        run.lastAssistantText = text;
        const output = this.currentOutput(run, at);
        if (this.options.captureContent) {
          const part = { type: "text" as const, content: truncateText(text) };
          output.parts.push(part);
          this.emitMessage(run, { role: "assistant", parts: [part] }, at);
        }
      }
      return;
    }
    if (payload.itemType === "reasoning" && event.type === "item.completed") {
      const text = run.reasoningText.get(itemId) ?? payload.detail;
      run.reasoningText.delete(itemId);
      if (text && text.trim().length > 0 && this.options.captureContent) {
        this.currentOutput(run, at).parts.push({ type: "thinking", content: truncateText(text) });
      }
      return;
    }
    if (!isToolItem(payload.itemType)) return;
    if (run.retiredItemIds.has(itemId)) return;

    const existing = run.tools.get(itemId);
    const facts = readToolCall(run.driver, payload);
    if (!existing) {
      if (event.type === "item.completed" && payload.status === undefined) return;
      const call: Extract<MessagePart, { type: "tool_call" }> = {
        type: "tool_call",
        id: itemId,
        name: facts.name,
        ...(this.options.captureContent && facts.arguments !== undefined
          ? { arguments: sanitizeArguments(facts.arguments) }
          : {}),
      };
      // While a model tool call is open, an item is one of its executions.
      // With several calls open the owner is ambiguous, so it goes under the
      // agent instead of a guessed call.
      const openCalls = [...run.modelCalls.entries()];
      const nested = openCalls.length > 0 && !payload.agentId;
      const owner = openCalls.length === 1 ? openCalls[0] : undefined;
      const parent =
        (payload.agentId && run.subagents.get(payload.agentId)) || owner?.[1].span || run.span;
      // Subagent tools belong to the subagent, not to the parent's model output.
      // Once an adapter reports response boundaries, a tool starting with no
      // response open was listed by the response that already closed.
      if (
        !nested &&
        !payload.agentId &&
        !payload.parentToolUseId &&
        !(run.responseEvents && !run.output)
      ) {
        const output = this.currentOutput(run, at);
        output.parts.push(call);
      }
      const attributes = new Map<string, unknown>(
        Object.entries({
          "logfire.msg": `running tool: ${facts.name}`,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": facts.name,
          "gen_ai.tool.call.id": itemId,
          "gen_ai.tool.call.arguments":
            call.arguments === undefined ? undefined : JSON.stringify(call.arguments),
          "gen_ai.agent.name": run.agentName,
          "gen_ai.conversation.id": run.threadId,
          "t3.tool.item_type": payload.itemType,
          "t3.turn.id": run.turnId,
          "t3.subagent.id": payload.agentId,
          "t3.tool.nested_execution": nested,
          "t3.tool.parent_call_id": owner?.[0],
          "logfire.json_schema": JSON_SCHEMA_TOOL,
        }).filter(([, value]) => value !== undefined),
      );
      const newTool: ToolRun = {
        span: undefined,
        spanName: `execute_tool ${facts.name}`,
        nested,
        parent,
        attributes,
        itemId,
        name: facts.name,
        startMs: at,
        call,
        approvalWaitMs: 0,
        approvalOpenedAtMs: undefined,
      };
      run.tools.set(itemId, newTool);
      if (nested) run.toolExecutions += 1;
      else run.toolCalls += 1;
      // A call still streaming is not running yet. The response that lists
      // it opens its span; subagent responses are not reported, so their
      // tools open now.
      if (
        nested ||
        !run.identity.toolStartsWhileStreaming ||
        payload.agentId ||
        payload.parentToolUseId
      ) {
        this.openToolSpan(newTool, at);
      }
    }
    const tool = run.tools.get(itemId)!;
    if (facts.arguments !== undefined && this.options.captureContent) {
      const args = sanitizeArguments(facts.arguments);
      tool.call.arguments = args;
      setToolAttribute(tool, "gen_ai.tool.call.arguments", JSON.stringify(args));
    }
    if (event.type !== "item.completed") return;

    run.tools.delete(itemId);
    const status = payload.status ?? "completed";
    const failed = status === "failed" || facts.error !== undefined;
    const result =
      typeof facts.result === "string"
        ? truncateText(facts.result)
        : facts.result === undefined
          ? undefined
          : sanitizeStructured(facts.result);
    if (this.options.captureContent && result !== undefined) {
      setToolAttribute(tool, "gen_ai.tool.call.result", JSON.stringify(result));
    }
    setToolAttribute(tool, "t3.tool.status", status);
    if (facts.providerDurationMs !== undefined) {
      setToolAttribute(tool, "t3.tool.provider_duration_ms", facts.providerDurationMs);
    }
    if (tool.approvalWaitMs > 0) {
      setToolAttribute(tool, "t3.tool.approval_wait_ms", tool.approvalWaitMs);
    }
    if (failed) {
      // A failed call counts once, however many of its executions failed.
      const owner = tool.nested
        ? run.modelCalls.get(String(tool.attributes.get("t3.tool.parent_call_id")))
        : undefined;
      if (!tool.nested) run.failedToolCalls += 1;
      else if (owner) {
        if (owner.failedExecutions === 0) run.failedToolCalls += 1;
        owner.failedExecutions += 1;
      }
    }
    if (!tool.nested && !payload.agentId && !payload.parentToolUseId) {
      const response: Message = {
        role: "user",
        parts: this.options.captureContent
          ? [{ type: "tool_call_response", id: itemId, name: tool.name, result: result ?? null }]
          : [],
      };
      if (response.parts.length > 0) {
        run.transcript.push(response);
        run.newMessages.push(response);
      }
      if (!run.output && at > run.requestStartMs) {
        run.requestStartMs = at;
        run.requestStartSource = "tool_result";
      }
    }
    if (!tool.span && run.identity.toolStartsWhileStreaming && !tool.nested) {
      // It finished before its response ended, so it ran while the model was
      // still streaming. When it began after its call finished streaming is
      // unknown; the span starts at the call's first chunk, an upper bound.
      tool.attributes.set("t3.tool.duration_upper_bound", true);
    }
    this.openToolSpan(tool, tool.startMs).end(
      toNanos(Math.max(at, tool.startMs)),
      status === "declined"
        ? exitFailure("Tool call declined")
        : failed
          ? exitFailure(facts.error ?? `Tool ${status}`)
          : Exit.void,
    );
  }

  private codexItemText(event: { readonly payload: { readonly data?: unknown } }) {
    return asString(asRecord(asRecord(event.payload.data)?.item)?.text);
  }

  private onUsage(
    run: AgentRun,
    event: Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>,
    at: number,
  ): void {
    if (run.responseEvents) return;
    const usage = readRequestUsage(event);
    if (!usage) return;
    if (usage.codexTotalKey !== undefined) {
      // Codex repeats an unchanged snapshot at some boundaries.
      if (usage.codexTotalKey === run.lastCodexTotal) return;
      run.lastCodexTotal = usage.codexTotalKey;
    }
    this.closeRequest(run, at, usage);
  }

  private onResponse(
    run: AgentRun,
    event: Extract<ProviderRuntimeEvent, { type: "model.response.completed" }>,
    at: number,
  ): void {
    run.responseEvents = true;
    const payload = event.payload;
    const parse = (iso: string | undefined) => {
      const ms = iso === undefined ? Number.NaN : Date.parse(iso);
      return Number.isFinite(ms) ? ms : undefined;
    };
    const startMs = parse(payload.requestStartedAt);
    const usage = payload.usage;
    this.closeRequest(
      run,
      at,
      usage
        ? {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheRead: usage.cachedInputTokens,
            cacheWrite: usage.cacheCreationTokens,
            reasoning: usage.reasoningTokens,
            finishReason: payload.finishReason,
          }
        : undefined,
      startMs !== undefined && payload.requestStartSource
        ? {
            startMs,
            startSource: payload.requestStartSource,
            firstChunkMs: parse(payload.firstChunkAt),
            responseModel: payload.model,
            responseId: payload.responseId,
          }
        : undefined,
      { toolCalls: payload.toolCalls ?? [] },
    );
  }

  /** A model tool call the adapter reports apart from its execution items. */
  private startModelToolCall(
    run: AgentRun,
    event: Extract<ProviderRuntimeEvent, { type: "model.tool_call.started" }>,
    at: number,
  ): void {
    const { callId, name } = event.payload;
    if (run.modelCalls.has(callId)) return;
    const args =
      event.payload.arguments !== undefined && this.options.captureContent
        ? sanitizeArguments(event.payload.arguments)
        : undefined;
    const span = this.startSpan(`execute_tool ${name}`, run.span, at, {
      "logfire.msg": `running tool: ${name}`,
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
      "gen_ai.tool.call.id": callId,
      "gen_ai.agent.name": run.agentName,
      "gen_ai.conversation.id": run.threadId,
      "gen_ai.tool.call.arguments": args === undefined ? undefined : JSON.stringify(args),
      "t3.turn.id": run.turnId,
      "logfire.json_schema": JSON_SCHEMA_TOOL,
    });
    run.modelCalls.set(callId, { span, name, startMs: at, failedExecutions: 0 });
    run.toolCalls += 1;
    this.currentOutput(run, at).parts.push({
      type: "tool_call",
      id: callId,
      name,
      ...(args !== undefined ? { arguments: args } : {}),
    });
  }

  private finishModelToolCall(
    run: AgentRun,
    event: Extract<ProviderRuntimeEvent, { type: "model.tool_call.completed" }>,
    at: number,
  ): void {
    const toolResult = { id: event.payload.callId, output: event.payload.output };
    const call = run.modelCalls.get(toolResult.id);
    if (!call) return;
    run.modelCalls.delete(toolResult.id);
    const endMs = Math.max(at, call.startMs);
    // Codex can keep a command's process alive long after the call returned
    // its output (its shell sessions linger until reaped). The model moved on
    // here, so its executions end here too, marked as still running.
    for (const [itemId, tool] of run.tools) {
      if (!tool.nested || tool.attributes.get("t3.tool.parent_call_id") !== toolResult.id) continue;
      run.tools.delete(itemId);
      run.retiredItemIds.add(itemId);
      setToolAttribute(tool, "t3.tool.status", "running_when_call_returned");
      setToolAttribute(tool, "t3.tool.process_outlived_call", true);
      this.openToolSpan(tool, tool.startMs).end(toNanos(Math.max(endMs, tool.startMs)), Exit.void);
    }
    const result =
      toolResult.output === undefined
        ? undefined
        : typeof toolResult.output === "string"
          ? truncateText(toolResult.output)
          : sanitizeStructured(toolResult.output);
    if (this.options.captureContent && result !== undefined) {
      call.span.attribute("gen_ai.tool.call.result", JSON.stringify(result));
      const response: Message = {
        role: "user",
        parts: [{ type: "tool_call_response", id: toolResult.id, name: call.name, result }],
      };
      run.transcript.push(response);
      run.newMessages.push(response);
    }
    call.span.attribute("t3.tool.status", "completed");
    if (call.failedExecutions > 0) {
      call.span.attribute("t3.tool.failed_executions", call.failedExecutions);
    }
    call.span.end(toNanos(endMs), Exit.void);
    if (!run.output && at > run.requestStartMs) {
      run.requestStartMs = at;
      run.requestStartSource = "tool_result";
    }
  }

  /** Emits a `chat` span for the model response observed since the last one. */
  private closeRequest(
    run: AgentRun,
    at: number,
    usage: RequestUsage | undefined,
    timing?: ResponseTiming,
    tools?: ResponseToolFacts,
  ): void {
    const output = run.output ?? { role: "assistant" as const, parts: [] };
    for (const call of tools?.toolCalls ?? []) {
      const listed = run.tools.get(call.id);
      if (listed) {
        // An item for this call already streamed (Claude); it runs from now.
        if (!listed.span) {
          const streamingMs = Math.max(0, at - listed.startMs);
          listed.attributes.set("t3.tool.call_streaming_ms", streamingMs);
          this.openToolSpan(listed, Math.max(listed.startMs, at));
        }
        if (!output.parts.some((part) => part.type === "tool_call" && part.id === call.id)) {
          output.parts.push(listed.call);
        }
        continue;
      }
      // Already finished (Claude ran it while still streaming) or reported
      // as its own call event: keep the transcript entry, add no span.
      if (!output.parts.some((part) => part.type === "tool_call" && part.id === call.id)) {
        output.parts.push({ type: "tool_call", id: call.id, name: call.name });
      }
    }
    if (!run.output && output.parts.length > 0) run.transcript.push(output);
    const toolCallCount = output.parts.filter((part) => part.type === "tool_call").length;
    if (usage?.finishReason) output.finish_reason = usage.finishReason;
    const startMs = Math.min(timing?.startMs ?? run.requestStartMs, at);
    const model = run.model;
    const span = this.options.tracer.span({
      name: `chat ${model ?? "unknown"}`,
      parent: Option.some(run.span),
      annotations: Context.empty(),
      links: [],
      startTime: toNanos(startMs),
      kind: "client",
      root: false,
      sampled: true,
    });
    const attributes: Record<string, unknown> = {
      "logfire.msg": `chat ${model ?? "unknown"}`,
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": run.identity.genAiProvider,
      "gen_ai.system": run.identity.genAiProvider,
      "gen_ai.request.model": model,
      "gen_ai.agent.name": run.agentName,
      "gen_ai.conversation.id": run.threadId,
      "t3.turn.id": run.turnId,
      "t3.genai.chat.start_source": timing?.startSource ?? run.requestStartSource,
      "gen_ai.response.model": timing?.responseModel,
      "gen_ai.response.id": timing?.responseId,
      // Seconds, as Pydantic AI and Logfire's dashboards read it.
      "gen_ai.client.operation.time_to_first_chunk":
        timing?.firstChunkMs !== undefined
          ? Math.max(0, timing.firstChunkMs - timing.startMs) / 1000
          : undefined,
      "t3.genai.chat.output_tool_calls": toolCallCount,
      "t3.genai.input_messages_scope": "new_since_previous_response",
      "logfire.json_schema": JSON_SCHEMA_CHAT,
    };
    if (usage) {
      attributes["gen_ai.usage.input_tokens"] = usage.input;
      attributes["gen_ai.usage.output_tokens"] = usage.output;
      if (usage.cacheRead) attributes["gen_ai.usage.cache_read.input_tokens"] = usage.cacheRead;
      if (usage.cacheWrite) {
        attributes["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheWrite;
      }
      if (usage.reasoning) attributes["gen_ai.usage.details.reasoning_tokens"] = usage.reasoning;
      if (usage.finishReason) attributes["gen_ai.response.finish_reasons"] = [usage.finishReason];
      run.usage.input += usage.input;
      run.usage.output += usage.output;
      run.usage.cacheRead += usage.cacheRead ?? 0;
      run.usage.cacheWrite += usage.cacheWrite ?? 0;
    } else {
      attributes["t3.genai.usage_reported"] = false;
    }
    if (this.options.captureContent) {
      attributes["gen_ai.input.messages"] = JSON.stringify(run.newMessages);
      attributes["gen_ai.output.messages"] = JSON.stringify([output]);
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.attribute(key, value);
    }
    span.end(toNanos(at), Exit.void);

    run.modelRequests += 1;
    if (toolCallCount > 0) run.toolCallingRequests += 1;
    run.output = undefined;
    run.outputStartedMs = undefined;
    run.newMessages = [];
    run.requestStartMs = at;
    run.requestStartSource = "previous_response";
  }

  private onRequest(
    run: AgentRun,
    event: Extract<ProviderRuntimeEvent, { type: "request.opened" | "request.resolved" }>,
    at: number,
  ): void {
    const tool = event.itemId ? run.tools.get(event.itemId) : undefined;
    // An approval prompt means the call finished streaming and wants to run.
    const target = tool ? this.openToolSpan(tool, at) : run.span;
    if (event.type === "request.opened") {
      if (tool) tool.approvalOpenedAtMs = at;
      target.event("approval.requested", toNanos(at), {
        "t3.request.type": event.payload.requestType,
      });
      return;
    }
    if (tool?.approvalOpenedAtMs !== undefined) {
      tool.approvalWaitMs += at - tool.approvalOpenedAtMs;
      tool.approvalOpenedAtMs = undefined;
    }
    target.event("approval.resolved", toNanos(at), {
      "t3.request.type": event.payload.requestType,
      ...(event.payload.decision ? { "t3.request.decision": event.payload.decision } : {}),
    });
  }

  private onTaskStarted(
    run: AgentRun,
    event: Extract<ProviderRuntimeEvent, { type: "task.started" }>,
    at: number,
  ): void {
    const payload = event.payload;
    // `agentKind` is stamped later by ingestion, so classify here.
    const kind =
      payload.agentKind ??
      classifyTaskAgentKind({ taskType: payload.taskType, agentId: payload.agentId });
    if (kind === "background") return;
    const agentId = payload.taskId;
    if (run.subagents.has(agentId)) return;
    const parentTool = payload.toolUseId ? run.tools.get(payload.toolUseId) : undefined;
    const name = `${run.agentName} subagent`;
    // A subagent means its Task call finished streaming and is running.
    const parent = parentTool ? this.openToolSpan(parentTool, at) : run.span;
    const span = this.startSpan(`invoke_agent ${name}`, parent, at, {
      "logfire.msg": this.options.captureContent
        ? `${payload.title ?? payload.description ?? "subagent"} run`
        : "subagent run",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": name,
      "gen_ai.agent.call.id": agentId,
      "gen_ai.conversation.id": run.threadId,
      "gen_ai.provider.name": run.identity.genAiProvider,
      "gen_ai.request.model": payload.model,
      "t3.subagent.id": agentId,
      "t3.subagent.type": payload.taskType,
      "t3.subagent.role": payload.role,
      "t3.turn.id": run.turnId,
    });
    run.subagents.set(agentId, span);
  }

  private onTaskEnd(
    run: AgentRun | undefined,
    event: Extract<ProviderRuntimeEvent, { type: "task.completed" | "task.updated" }>,
    at: number,
  ): void {
    if (event.type === "task.completed") {
      this.endSubagent(run, event.payload.taskId, event.payload.status, at, {
        summary: event.payload.summary,
        usage: event.payload.typedUsage,
      });
      return;
    }
    // Codex can end a child agent with an update instead of a completion.
    // Claude sends a terminal update before its completion, which carries the
    // summary and usage, so Claude subagents wait for the completion.
    if (event.provider !== "codex") return;
    const status = event.payload.status;
    if (status === "completed" || status === "failed") {
      this.endSubagent(run, event.payload.taskId, status, at, { summary: event.payload.error });
    } else if (status === "cancelled" || status === "interrupted") {
      this.endSubagent(run, event.payload.taskId, "stopped", at, {});
    }
  }

  private endSubagent(
    run: AgentRun | undefined,
    taskId: string,
    status: "completed" | "failed" | "stopped",
    at: number,
    details: {
      readonly summary?: string | undefined;
      readonly usage?:
        | Extract<ProviderRuntimeEvent, { type: "task.completed" }>["payload"]["typedUsage"]
        | undefined;
    },
  ): void {
    const span = run?.subagents.get(taskId) ?? this.detachedSubagents.get(taskId)?.span;
    if (!span) return;
    run?.subagents.delete(taskId);
    this.detachedSubagents.delete(taskId);
    const usage = details.usage;
    if (usage) {
      if (usage.inputTokens !== undefined) {
        span.attribute("gen_ai.aggregated_usage.input_tokens", usage.inputTokens);
      }
      if (usage.outputTokens !== undefined) {
        span.attribute("gen_ai.aggregated_usage.output_tokens", usage.outputTokens);
      }
      span.attribute("t3.subagent.total_tokens", usage.totalTokens);
      if (usage.toolUses !== undefined) span.attribute("t3.subagent.tool_uses", usage.toolUses);
    }
    const summary =
      details.summary && this.options.captureContent ? truncateText(details.summary) : undefined;
    if (summary && status !== "failed") span.attribute("final_result", summary);
    span.end(
      toNanos(at),
      status === "failed"
        ? exitFailure(summary ?? "Subagent failed")
        : status === "stopped"
          ? exitInterrupted()
          : Exit.void,
    );
  }

  private finishRun(
    event: {
      readonly threadId: string;
      readonly turnId?: string | undefined;
      readonly createdAt: string;
    },
    state: string,
    details: FinishDetails,
  ): void {
    const run = event.turnId
      ? this.runs.get(`${event.threadId}:${event.turnId}`)
      : this.activeRun(event.threadId);
    if (!run) return;
    const atMs = this.eventMs(event);
    if (!run.promptRecorded && this.hasUnboundInput(run.threadId)) {
      const key = `${run.threadId}:${run.turnId}`;
      this.runs.delete(key);
      this.heldRuns.set(key, { run, state, details, atMs });
      return;
    }
    this.endRun(run, state, details, atMs);
  }

  private endRun(run: AgentRun, state: string, details: FinishDetails, at: number): void {
    this.runs.delete(`${run.threadId}:${run.turnId}`);
    const interrupted = state === "interrupted" || state === "cancelled";
    // Output after the last usage report still came from a model response.
    if (run.output && run.output.parts.length > 0 && run.identity.reportsRequestUsage) {
      this.closeRequest(run, at, undefined);
    }
    for (const tool of run.tools.values()) {
      setToolAttribute(tool, "t3.tool.status", "unfinished");
      this.openToolSpan(tool, tool.startMs).end(
        toNanos(Math.max(at, tool.startMs)),
        exitInterrupted(),
      );
    }
    // A subagent can outlive its turn (Claude background agents); it ends
    // with its own completion, or when the session exits.
    for (const [taskId, span] of run.subagents) {
      this.detachedSubagents.set(taskId, { span, threadId: run.threadId });
    }
    run.subagents.clear();
    for (const call of run.modelCalls.values()) {
      call.span.attribute("t3.tool.status", "unfinished");
      call.span.end(toNanos(Math.max(at, call.startMs)), exitInterrupted());
    }
    run.modelCalls.clear();

    const span = run.span;
    if (run.toolExecutions > 0) span.attribute("t3.agent.tool_executions", run.toolExecutions);
    span.attribute("t3.turn.state", state);
    if (details.stopReason) span.attribute("t3.turn.stop_reason", details.stopReason);
    span.attribute("t3.agent.tool_calls", run.toolCalls);
    span.attribute("t3.agent.failed_tool_calls", run.failedToolCalls);
    if (run.identity.reportsRequestUsage) {
      span.attribute("t3.agent.model_requests", run.modelRequests);
      span.attribute("t3.agent.tool_calling_requests", run.toolCallingRequests);
    }
    const turnUsage = details.tokenUsage;
    if (turnUsage && turnUsage.usageStatus !== "unavailable") {
      span.attribute("t3.usage.status", turnUsage.usageStatus);
      if (turnUsage.inputTokens !== undefined) {
        span.attribute("gen_ai.aggregated_usage.input_tokens", turnUsage.inputTokens);
      }
      if (turnUsage.outputTokens !== undefined) {
        span.attribute("gen_ai.aggregated_usage.output_tokens", turnUsage.outputTokens);
      }
      if (turnUsage.cachedInputTokens !== undefined) {
        span.attribute(
          "gen_ai.aggregated_usage.cache_read.input_tokens",
          turnUsage.cachedInputTokens,
        );
      }
      if (turnUsage.cacheCreationTokens !== undefined) {
        span.attribute(
          "gen_ai.aggregated_usage.cache_creation.input_tokens",
          turnUsage.cacheCreationTokens,
        );
      }
    } else if (run.modelRequests > 0) {
      span.attribute("t3.usage.status", "summed_from_responses");
      span.attribute("gen_ai.aggregated_usage.input_tokens", run.usage.input);
      span.attribute("gen_ai.aggregated_usage.output_tokens", run.usage.output);
    }
    if (details.totalCostUsd !== undefined) {
      span.attribute("t3.provider.reported_cost_usd", details.totalCostUsd);
    }
    const responseModels = details.modelUsage ? Object.keys(details.modelUsage) : [];
    if (responseModels.length > 0) span.attribute("gen_ai.response.model", responseModels[0]);
    if (this.options.captureContent) {
      // Logfire prefers gen_ai.input/output.messages when present. Those belong
      // on model spans; a first/last summary here hides the intervening conversation.
      span.attribute("pydantic_ai.all_messages", JSON.stringify(run.transcript));
      if (run.lastAssistantText)
        span.attribute("final_result", truncateText(run.lastAssistantText));
    }
    span.end(
      toNanos(Math.max(at, run.startMs)),
      interrupted
        ? exitInterrupted()
        : state === "failed"
          ? exitFailure(details.errorMessage ?? "Agent turn failed")
          : Exit.void,
    );
  }
}

/** Appends streamed text without holding more than the exported limit. */
function appendCapped(current: string | undefined, delta: string): string {
  if (current?.endsWith(STREAM_TRUNCATED_MARKER)) return current;
  const text = (current ?? "") + delta;
  return text.length > MAX_TEXT_CHARS
    ? text.slice(0, MAX_TEXT_CHARS) + STREAM_TRUNCATED_MARKER
    : text;
}

function setToolAttribute(tool: ToolRun, key: string, value: unknown): void {
  tool.attributes.set(key, value);
  tool.span?.attribute(key, value);
}

function isToolItem(itemType: string): boolean {
  return (
    itemType === "command_execution" ||
    itemType === "file_change" ||
    itemType === "mcp_tool_call" ||
    itemType === "dynamic_tool_call" ||
    itemType === "collab_agent_tool_call" ||
    itemType === "web_search" ||
    itemType === "image_view"
  );
}
