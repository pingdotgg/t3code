import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type { ProviderSessionUsage, ProviderUsageResult } from "@t3tools/contracts";
import type { ProviderThreadSnapshot } from "./provider/Services/ProviderAdapter.ts";
import { createLogger } from "./logger.ts";

// ── Constants ───────────────────────────────────────────────────────

const PROVIDER = "amp" as const;

// ── Module-level usage tracking ──────────────────────────────────────

interface AmpUsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  turnCount: number;
}

let _ampUsageAccumulator: AmpUsageAccumulator = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  turnCount: 0,
};

export function fetchAmpUsage(): ProviderUsageResult {
  const acc = _ampUsageAccumulator;
  let sessionUsage: ProviderSessionUsage | undefined;
  if (acc.turnCount > 0) {
    sessionUsage = {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      ...(acc.cachedTokens > 0 ? { cachedTokens: acc.cachedTokens } : {}),
      totalTokens: acc.inputTokens + acc.outputTokens,
      turnCount: acc.turnCount,
    };
  }
  return {
    provider: PROVIDER,
    ...(sessionUsage ? { sessionUsage } : {}),
  };
}

// ── Types ───────────────────────────────────────────────────────────

type AmpProviderOptions = {
  readonly binaryPath?: string;
};

interface AmpSession {
  readonly threadId: ThreadId;
  readonly process: ChildProcessWithoutNullStreams;
  readonly rl: readline.Interface;
  model: string | undefined;
  cwd: string;
  runtimeMode: string;
  status: "ready" | "running" | "closed";
  activeTurnId: TurnId | undefined;
  /** Stable itemId reused across content.delta events within a single assistant message. */
  activeAssistantItemId: RuntimeItemId | undefined;
  /** Maps parent_tool_use_id → RuntimeTaskId for tracking subagent tasks. */
  readonly subagentTasks: Map<string, string>;
  /** Maps tool_use_id → classified item type for consistent start/completion typing. */
  readonly toolItemTypes: Map<string, ReturnType<typeof classifyToolName>>;
  /** Set to true when stopSession is called so close/error handlers know to delete the session. */
  closing: boolean;
  readonly createdAt: string;
  updatedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function defaultBinaryPath(): string {
  return "amp";
}

function classifyToolName(
  name: string,
): "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call" {
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("command") || lower.includes("shell"))
    return "command_execution";
  if (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("file") ||
    lower.includes("patch")
  )
    return "file_change";
  if (lower.includes("mcp")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

// ── AMP JSONL content-block shapes ──────────────────────────────────

interface AmpTextContentBlock {
  type: "text";
  text: string;
}

interface AmpThinkingContentBlock {
  type: "thinking";
  thinking: string;
}

interface AmpToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AmpToolResultContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

type AmpContentBlock =
  | AmpTextContentBlock
  | AmpThinkingContentBlock
  | AmpToolUseContentBlock
  | AmpToolResultContentBlock;

interface AmpJsonlMessageInner {
  content?: AmpContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  stop_reason?: string;
}

interface AmpJsonlMessage {
  type: "system" | "user" | "assistant" | "result";
  /** Inner message envelope — assistant/user content, usage, and stop_reason live here. */
  message?: AmpJsonlMessageInner;
  parent_tool_use_id?: string | null;
  session_id?: string;
  tools?: unknown[];
  mcp_servers?: Array<{ name: string; status?: string }>;
  is_error?: boolean;
  error?: string;
  result?: string;
}

// ── Manager ─────────────────────────────────────────────────────────

export class AmpServerManager extends EventEmitter<{
  event: [ProviderRuntimeEvent];
}> {
  private readonly sessions = new Map<ThreadId, AmpSession>();
  private readonly logger = createLogger("amp");

  // ── Session lifecycle ───────────────────────────────────────────

  startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const existing = this.sessions.get(threadId);
    if (existing) {
      if (existing.status === "closed") {
        this.sessions.delete(threadId);
      } else {
        throw new Error(`AMP session already exists for thread ${threadId}`);
      }
    }

    const ampOpts = input.providerOptions?.amp as AmpProviderOptions | undefined;
    const binaryPath = ampOpts?.binaryPath ?? defaultBinaryPath();
    const cwd = input.cwd ?? process.cwd();
    const model = input.model;
    const now = new Date().toISOString();

    const args = ["--execute", "--stream-json", "--stream-json-thinking", "--stream-json-input"];
    // AMP uses --mode for smart/rush/deep/free (default is smart)
    if (model && model !== "smart") {
      args.push("--mode", model);
    }
    // Allow all tool executions without confirmation when in full-access mode
    if (input.runtimeMode === "full-access") {
      args.push("--dangerously-allow-all");
    }

    const child = spawn(binaryPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const rl = readline.createInterface({ input: child.stdout });

    const session: AmpSession = {
      threadId,
      process: child,
      rl,
      model,
      cwd,
      runtimeMode: input.runtimeMode,
      status: "ready",
      activeTurnId: undefined,
      activeAssistantItemId: undefined,
      subagentTasks: new Map(),
      toolItemTypes: new Map(),
      closing: false,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(threadId, session);

    rl.on("line", (line) => {
      this.handleOutputLine(threadId, line);
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        this.emitEvent(threadId, session.activeTurnId, {
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: text,
          },
        });
      }
    });

    child.on("close", (code) => {
      const s = this.sessions.get(threadId);
      if (s) {
        if (s.activeTurnId) {
          this.closeAllSubagentTasks(threadId, s);
          this.drainToolItems(threadId, s);
          this.emitEvent(threadId, s.activeTurnId, {
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: `AMP process exited with code ${code}`,
            },
          });
          s.activeTurnId = undefined;
          s.activeAssistantItemId = undefined;
        }
        s.status = "closed";
        s.updatedAt = new Date().toISOString();
        this.emitEvent(threadId, s.activeTurnId, {
          type: "session.exited",
          payload: {
            reason: `Process exited with code ${code}`,
            exitKind: code === 0 ? "graceful" : "error",
          },
        });
        this.sessions.delete(threadId);
      }
    });

    child.on("error", (error) => {
      const s = this.sessions.get(threadId);
      if (s) {
        if (s.activeTurnId) {
          this.closeAllSubagentTasks(threadId, s);
          this.drainToolItems(threadId, s);
          this.emitEvent(threadId, s.activeTurnId, {
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: `AMP process error: ${error.message}`,
            },
          });
          s.activeTurnId = undefined;
          s.activeAssistantItemId = undefined;
        }
        s.status = "closed";
        s.updatedAt = new Date().toISOString();
      }
      this.emitEvent(threadId, s?.activeTurnId, {
        type: "runtime.error",
        payload: { message: error.message, class: "transport_error" },
      });
      if (s) {
        this.sessions.delete(threadId);
      }
    });

    const providerSession: ProviderSession = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId,
      cwd,
      model: input.model,
      createdAt: now,
      updatedAt: now,
    };

    return Promise.resolve(providerSession);
  }

  // ── Turn handling ─────────────────────────────────────────────────

  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`Unknown AMP session: ${input.threadId}`);
    }
    if (session.status === "closed") {
      throw new Error(`AMP session is closed: ${input.threadId}`);
    }
    if (session.status === "running" || session.activeTurnId) {
      throw new Error(
        `AMP session ${input.threadId} already has a turn in progress (turn ${session.activeTurnId})`,
      );
    }
    if (input.attachments && input.attachments.length > 0) {
      throw new Error("Attachments are not supported by AMP");
    }

    const turnId = TurnId.makeUnsafe(randomUUID());
    const prompt = input.input ?? "";

    // Write a JSONL user message to stdin for the persistent AMP process.
    // AMP expects { type: "user", message: { role: "user", content: [...] } }
    const userMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    });

    try {
      session.process.stdin.write(userMessage + "\n");
    } catch (err) {
      throw new Error(
        `Failed to write to AMP stdin for session ${input.threadId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Mutations happen only after successful write.
    session.activeTurnId = turnId;
    session.status = "running";
    session.updatedAt = new Date().toISOString();

    this.emitEvent(input.threadId, turnId, {
      type: "turn.started",
      payload: {},
    });

    return Promise.resolve({
      threadId: input.threadId,
      turnId,
    });
  }

  // ── Interruption ──────────────────────────────────────────────────

  interruptTurn(threadId: ThreadId): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`Unknown AMP session: ${threadId}`);
    }
    if (session.status === "running") {
      session.process.kill("SIGINT");
    }
    return Promise.resolve();
  }

  // ── Approval / user-input stubs ───────────────────────────────────

  respondToRequest(
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ): Promise<void> {
    return Promise.resolve();
  }

  respondToUserInput(
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return Promise.resolve();
  }

  // ── Session teardown ──────────────────────────────────────────────

  stopSession(threadId: ThreadId): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.closing = true;
    try {
      session.process.kill();
    } catch {
      // Process may already be dead — clean up immediately since handlers won't fire.
      session.status = "closed";
      this.sessions.delete(threadId);
    }
  }

  // ── Listing / introspection ───────────────────────────────────────

  listSessions(): ProviderSession[] {
    const sessions: ProviderSession[] = [];
    for (const session of this.sessions.values()) {
      sessions.push({
        provider: PROVIDER,
        status: session.status === "closed" ? "closed" : "ready",
        runtimeMode: session.runtimeMode as ProviderSession["runtimeMode"],
        threadId: session.threadId,
        cwd: session.cwd,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }
    return sessions;
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  readThread(_threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    throw new Error("readThread is not supported for AMP provider");
  }

  rollbackThread(_threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    throw new Error("rollbackThread is not supported for AMP provider");
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  // ── JSONL output parsing ──────────────────────────────────────────

  private handleOutputLine(threadId: ThreadId, line: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: AmpJsonlMessage;
    try {
      msg = JSON.parse(trimmed) as AmpJsonlMessage;
    } catch {
      // Non-JSON output — treat as raw assistant text.
      this.logger.warn("Failed to parse JSONL line", { length: trimmed.length });
      this.emitEvent(threadId, session.activeTurnId, {
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: trimmed + "\n",
        },
      });
      return;
    }

    switch (msg.type) {
      case "system":
        this.handleSystemMessage(threadId, session, msg);
        break;
      case "assistant":
        this.handleAssistantMessage(threadId, session, msg);
        break;
      case "user":
        this.handleUserMessage(threadId, session, msg);
        break;
      case "result":
        this.handleResultMessage(threadId, session, msg);
        break;
      default:
        // Unknown message type — emit as raw text delta.
        this.emitEvent(threadId, session.activeTurnId, {
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: trimmed + "\n",
          },
        });
    }
  }

  // ── type: "system" ────────────────────────────────────────────────

  private handleSystemMessage(
    threadId: ThreadId,
    session: AmpSession,
    msg: AmpJsonlMessage,
  ): void {
    // Emit session.configured with the tools list from the init payload.
    const config: Record<string, unknown> = {};
    if (msg.tools) {
      config.tools = msg.tools;
    }
    this.emitEvent(threadId, session.activeTurnId, {
      type: "session.configured",
      payload: { config },
    });

    // Emit mcp.status.updated for each MCP server listed in the system message.
    if (msg.mcp_servers && Array.isArray(msg.mcp_servers)) {
      for (const server of msg.mcp_servers) {
        this.emitEvent(threadId, session.activeTurnId, {
          type: "mcp.status.updated",
          payload: {
            status: {
              name: server.name,
              status: server.status ?? "connected",
            },
          },
        });
      }
    }
  }

  // ── type: "assistant" ─────────────────────────────────────────────

  private handleAssistantMessage(
    threadId: ThreadId,
    session: AmpSession,
    msg: AmpJsonlMessage,
  ): void {
    // Track subagent tasks via parent_tool_use_id (top-level field).
    if (msg.parent_tool_use_id) {
      this.trackSubagentTask(threadId, session, msg.parent_tool_use_id);
    }

    // Content, usage, and stop_reason live inside msg.message (the inner envelope).
    const inner = msg.message;

    // Process content blocks.
    if (inner?.content && Array.isArray(inner.content)) {
      for (const block of inner.content) {
        this.handleAssistantContentBlock(threadId, session, block);
      }
    }

    // Emit token usage if present.
    if (inner?.usage) {
      // Accumulate session-level usage
      if (typeof inner.usage.input_tokens === "number")
        _ampUsageAccumulator.inputTokens += inner.usage.input_tokens;
      if (typeof inner.usage.output_tokens === "number")
        _ampUsageAccumulator.outputTokens += inner.usage.output_tokens;
      const cached =
        (typeof inner.usage.cache_read_input_tokens === "number"
          ? inner.usage.cache_read_input_tokens
          : 0) +
        (typeof inner.usage.cache_creation_input_tokens === "number"
          ? inner.usage.cache_creation_input_tokens
          : 0);
      if (cached > 0) _ampUsageAccumulator.cachedTokens += cached;

      this.emitEvent(threadId, session.activeTurnId, {
        type: "thread.token-usage.updated",
        payload: { usage: inner.usage },
      });
    }

    // For persistent sessions, a turn completes when stop_reason is "end_turn".
    // Guard against duplicate turn.completed (handleResultMessage may also emit one).
    if (inner?.stop_reason === "end_turn" && session.activeTurnId && session.status !== "ready") {
      _ampUsageAccumulator.turnCount++;
      this.closeAllSubagentTasks(threadId, session);
      this.emitEvent(threadId, session.activeTurnId, {
        type: "turn.completed",
        payload: { state: "completed", stopReason: "end_turn" },
      });
      session.status = "ready";
      session.activeTurnId = undefined;
      session.activeAssistantItemId = undefined;
      session.updatedAt = new Date().toISOString();
    }
  }

  private handleAssistantContentBlock(
    threadId: ThreadId,
    session: AmpSession,
    block: AmpContentBlock,
  ): void {
    switch (block.type) {
      case "text": {
        if (!session.activeAssistantItemId) {
          session.activeAssistantItemId = RuntimeItemId.makeUnsafe(randomUUID());
        }
        this.emitEvent(
          threadId,
          session.activeTurnId,
          {
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: block.text,
            },
          },
          session.activeAssistantItemId,
        );
        break;
      }

      case "thinking": {
        if (!session.activeAssistantItemId) {
          session.activeAssistantItemId = RuntimeItemId.makeUnsafe(randomUUID());
        }
        this.emitEvent(
          threadId,
          session.activeTurnId,
          {
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: block.thinking,
            },
          },
          session.activeAssistantItemId,
        );
        break;
      }

      case "tool_use": {
        // A tool use starts a new assistant message segment — clear the active item.
        session.activeAssistantItemId = undefined;
        const itemType = classifyToolName(block.name);
        session.toolItemTypes.set(block.id, itemType);
        const itemId = RuntimeItemId.makeUnsafe(block.id);
        this.emitEvent(
          threadId,
          session.activeTurnId,
          {
            type: "item.started",
            payload: {
              itemType,
              status: "inProgress",
              title: block.name,
              data: block.input,
            },
          },
          itemId,
        );
        break;
      }

      // tool_result blocks are handled in handleUserMessage, but they can also
      // appear inside assistant content in some edge cases — ignore here.
      default:
        break;
    }
  }

  // ── Subagent task tracking ────────────────────────────────────────

  private trackSubagentTask(
    threadId: ThreadId,
    session: AmpSession,
    parentToolUseId: string,
  ): void {
    const existing = session.subagentTasks.get(parentToolUseId);
    if (!existing) {
      // First occurrence — emit task.started.
      const taskId = RuntimeTaskId.makeUnsafe(randomUUID());
      session.subagentTasks.set(parentToolUseId, taskId);
      this.emitEvent(threadId, session.activeTurnId, {
        type: "task.started",
        payload: {
          taskId,
          description: `Subagent for tool ${parentToolUseId}`,
          taskType: "subagent",
        },
      });
    } else {
      // Subsequent occurrence — emit task.progress.
      this.emitEvent(threadId, session.activeTurnId, {
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(existing),
          description: `Subagent progress for tool ${parentToolUseId}`,
        },
      });
    }
  }

  private closeAllSubagentTasks(threadId: ThreadId, session: AmpSession): void {
    for (const [parentToolUseId, taskId] of session.subagentTasks) {
      this.emitEvent(threadId, session.activeTurnId, {
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(taskId),
          status: "completed",
          summary: `Subagent for tool ${parentToolUseId} completed`,
        },
      });
    }
    session.subagentTasks.clear();
  }

  /** Emit item.completed for every remaining open tool item and clear the map. */
  private drainToolItems(threadId: ThreadId, session: AmpSession): void {
    for (const [toolUseId, itemType] of session.toolItemTypes) {
      this.emitEvent(
        threadId,
        session.activeTurnId,
        {
          type: "item.completed",
          payload: {
            itemType,
            status: "failed",
            data: null,
          },
        },
        RuntimeItemId.makeUnsafe(toolUseId),
      );
    }
    session.toolItemTypes.clear();
  }

  // ── type: "user" ──────────────────────────────────────────────────

  private handleUserMessage(
    threadId: ThreadId,
    session: AmpSession,
    msg: AmpJsonlMessage,
  ): void {
    // User messages with tool_result content → emit item.completed for the matching tool.
    const content = msg.message?.content;
    if (content && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const resultBlock = block as AmpToolResultContentBlock;
          const itemId = RuntimeItemId.makeUnsafe(resultBlock.tool_use_id);
          const itemType =
            session.toolItemTypes.get(resultBlock.tool_use_id) ?? "dynamic_tool_call";
          session.toolItemTypes.delete(resultBlock.tool_use_id);
          this.emitEvent(
            threadId,
            session.activeTurnId,
            {
              type: "item.completed",
              payload: {
                itemType,
                status: resultBlock.is_error ? "failed" : "completed",
                data: resultBlock.content,
              },
            },
            itemId,
          );
        }
      }
    }
  }

  // ── type: "result" ────────────────────────────────────────────────

  private handleResultMessage(
    threadId: ThreadId,
    session: AmpSession,
    msg: AmpJsonlMessage,
  ): void {
    // Guard: only complete the turn if one is still active (handleAssistantMessage
    // may have already completed it via stop_reason === "end_turn").
    if (!session.activeTurnId || session.status === "ready") return;

    // Close all open subagent tasks before completing the turn.
    this.closeAllSubagentTasks(threadId, session);

    if (msg.is_error || msg.error) {
      // Error result.
      const errorMessage = msg.error ?? msg.result ?? "Unknown AMP error";
      this.emitEvent(threadId, session.activeTurnId, {
        type: "runtime.error",
        payload: {
          message: errorMessage,
          class: "provider_error",
        },
      });
      this.emitEvent(threadId, session.activeTurnId, {
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage,
        },
      });
    } else {
      // Success result.
      this.emitEvent(threadId, session.activeTurnId, {
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: msg.message?.stop_reason ?? null,
        },
      });
    }

    session.status = "ready";
    session.activeTurnId = undefined;
    session.activeAssistantItemId = undefined;
    session.updatedAt = new Date().toISOString();
  }

  // ── Event emission ────────────────────────────────────────────────

  private emitEvent(
    threadId: ThreadId,
    turnId: TurnId | undefined,
    partial: {
      type: string;
      payload: unknown;
    },
    itemId?: RuntimeItemId,
  ): void {
    const event = {
      type: partial.type,
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      createdAt: new Date().toISOString(),
      threadId,
      ...(turnId ? { turnId } : {}),
      ...(itemId
        ? { itemId }
        : partial.type === "content.delta"
          ? { itemId: RuntimeItemId.makeUnsafe(randomUUID()) }
          : {}),
      payload: partial.payload,
    } as unknown as ProviderRuntimeEvent;

    this.emit("event", event);
  }
}
