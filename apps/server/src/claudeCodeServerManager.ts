import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { Readable } from "node:stream";

import {
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";

interface ClaudeCodeProviderOptionsShape {
  readonly binaryPath?: string;
  readonly homePath?: string;
}

interface ClaudeToolUseState {
  readonly id: string;
  readonly name: string;
  readonly type: "tool_use" | "server_tool_use";
  partialJson: string;
  input?: unknown;
}

interface ClaudeTurnRuntimeState {
  readonly turnId: TurnId;
  readonly events: ProviderEvent[];
  readonly toolUsesById: Map<string, ClaudeToolUseState>;
  readonly toolUsesByIndex: Map<number, ClaudeToolUseState>;
  resultSeen: boolean;
  interrupted: boolean;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly binaryPath: string;
  readonly homePath?: string;
  useResumeOnNextTurn: boolean;
  activeChild: ClaudeCodeChildProcess | undefined;
  activeOutput: readline.Interface | undefined;
  activeTurn: ClaudeTurnRuntimeState | undefined;
  turns: ClaudeCodeThreadTurnSnapshot[];
}

type ClaudeCodeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface ClaudeCodeServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "claudeCode";
  readonly cwd?: string;
  readonly model?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly runtimeMode: RuntimeMode;
}

export interface ClaudeCodeServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ProviderSendTurnInput["attachments"];
  readonly model?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface ClaudeCodeThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ClaudeCodeThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ClaudeCodeThreadTurnSnapshot>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyTrimmed(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmptyString(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.length > 0 ? value : undefined;
}

function normalizeClaudeModelSlug(model: string | undefined | null): string | undefined {
  const normalized = normalizeModelSlug(model, "claudeCode");
  return normalized ?? nonEmptyTrimmed(model);
}

function readClaudeCodeProviderOptions(
  providerOptions: ProviderSessionStartInput["providerOptions"] | undefined,
): ClaudeCodeProviderOptionsShape {
  const candidate = asObject(asObject(providerOptions)?.claudeCode);
  const binaryPath = nonEmptyTrimmed(asString(candidate?.binaryPath));
  const homePath = nonEmptyTrimmed(asString(candidate?.homePath));
  return {
    ...(binaryPath ? { binaryPath } : {}),
    ...(homePath ? { homePath } : {}),
  };
}

export function toClaudePermissionMode(
  runtimeMode: RuntimeMode,
  interactionMode?: ProviderInteractionMode,
): ClaudePermissionMode {
  if (interactionMode === "plan") {
    return "plan";
  }
  return runtimeMode === "full-access" ? "bypassPermissions" : "default";
}

function parsePartialJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function toolInputSummary(input: unknown): string | undefined {
  const record = asObject(input);
  const command = nonEmptyTrimmed(asString(record?.command));
  if (command) {
    return command;
  }
  const description = nonEmptyTrimmed(asString(record?.description));
  if (description) {
    return description;
  }
  const prompt = nonEmptyTrimmed(asString(record?.prompt));
  if (prompt) {
    return prompt;
  }
  const question = nonEmptyTrimmed(asString(record?.question));
  if (question) {
    return question;
  }
  const query = nonEmptyTrimmed(asString(record?.query));
  if (query) {
    return query;
  }
  return undefined;
}

function resultSummary(result: unknown): string | undefined {
  const trimmed = nonEmptyTrimmed(asString(result));
  if (trimmed) {
    return trimmed;
  }
  const entries = asArray(result);
  if (entries && entries.length > 0) {
    const first = asObject(entries[0]);
    return (
      nonEmptyTrimmed(asString(first?.title)) ??
      nonEmptyTrimmed(asString(first?.url)) ??
      `Search returned ${entries.length} result${entries.length === 1 ? "" : "s"}`
    );
  }
  const record = asObject(result);
  return (
    nonEmptyTrimmed(asString(record?.error_code)) ??
    nonEmptyTrimmed(asString(record?.stdout)) ??
    nonEmptyTrimmed(asString(record?.stderr)) ??
    nonEmptyTrimmed(asString(record?.output)) ??
    undefined
  );
}

function isWebSearchToolResultError(result: unknown): boolean {
  const record = asObject(result);
  return asString(record?.type) === "web_search_tool_result_error";
}

export class ClaudeCodeServerManager extends EventEmitter {
  readonly #sessions = new Map<ThreadId, ClaudeSessionContext>();

  #emitEvent(context: ClaudeSessionContext, event: ProviderEvent): void {
    if (context.activeTurn && event.turnId === context.activeTurn.turnId) {
      context.activeTurn.events.push(event);
    }
    this.emit("event", event);
  }

  #makeEvent(input: {
    readonly threadId: ThreadId;
    readonly kind: ProviderEvent["kind"];
    readonly method: string;
    readonly message?: string;
    readonly payload?: unknown;
    readonly turnId?: TurnId;
    readonly itemId?: ProviderItemId;
  }): ProviderEvent {
    return {
      id: EventId.makeUnsafe(randomUUID()),
      kind: input.kind,
      provider: "claudeCode",
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      method: input.method,
      ...(input.message ? { message: input.message } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
    };
  }

  #getSessionContext(threadId: ThreadId): ClaudeSessionContext {
    const context = this.#sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown provider session: ${String(threadId)}`);
    }
    return context;
  }

  async startSession(input: ClaudeCodeServerStartSessionInput): Promise<ProviderSession> {
    const now = new Date().toISOString();
    const options = readClaudeCodeProviderOptions(input.providerOptions);
    const resumeCursor = nonEmptyTrimmed(asString(input.resumeCursor)) ?? randomUUID();
    const session: ProviderSession = {
      provider: "claudeCode",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(normalizeClaudeModelSlug(input.model) ? { model: normalizeClaudeModelSlug(input.model) } : {}),
      resumeCursor,
      createdAt: now,
      updatedAt: now,
    };

    const context: ClaudeSessionContext = {
      session,
      binaryPath: options.binaryPath ?? "claude",
      ...(options.homePath ? { homePath: options.homePath } : {}),
      useResumeOnNextTurn: nonEmptyTrimmed(asString(input.resumeCursor)) !== undefined,
      activeChild: undefined,
      activeOutput: undefined,
      activeTurn: undefined,
      turns: [],
    };
    this.#sessions.set(input.threadId, context);

    this.#emitEvent(
      context,
      this.#makeEvent({
        threadId: input.threadId,
        kind: "session",
        method: "session/started",
        payload: {
          resume: resumeCursor,
        },
      }),
    );
    this.#emitEvent(
      context,
      this.#makeEvent({
        threadId: input.threadId,
        kind: "session",
        method: "session/configured",
        payload: {
          config: {
            provider: "claudeCode",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(session.model ? { model: session.model } : {}),
            permissionMode: toClaudePermissionMode(input.runtimeMode),
            ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
            ...(options.homePath ? { homePath: options.homePath } : {}),
          },
        },
      }),
    );
    this.#emitEvent(
      context,
      this.#makeEvent({
        threadId: input.threadId,
        kind: "session",
        method: "thread/started",
        payload: {
          providerThreadId: resumeCursor,
        },
      }),
    );

    return session;
  }

  async sendTurn(input: ClaudeCodeServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.#getSessionContext(input.threadId);
    if (context.activeTurn || context.activeChild) {
      throw new Error(`Provider session is busy: ${String(input.threadId)}`);
    }
    if (input.attachments && input.attachments.length > 0) {
      throw new Error("Claude Code attachments are not supported by the server adapter yet.");
    }
    const prompt = nonEmptyTrimmed(input.input);
    if (!prompt) {
      throw new Error("Claude Code requires a non-empty turn input.");
    }

    const model = normalizeClaudeModelSlug(input.model) ?? context.session.model;
    const permissionMode = toClaudePermissionMode(context.session.runtimeMode, input.interactionMode);
    const turnId = TurnId.makeUnsafe(randomUUID());

    const { lastError: _lastError, ...readySession } = context.session;
    context.session = {
      ...readySession,
      status: "running",
      updatedAt: new Date().toISOString(),
      activeTurnId: turnId,
      ...(model ? { model } : {}),
    };
    context.activeTurn = {
      turnId,
      events: [],
      toolUsesById: new Map(),
      toolUsesByIndex: new Map(),
      resultSeen: false,
      interrupted: false,
    };

    this.#emitEvent(
      context,
      this.#makeEvent({
        threadId: input.threadId,
        kind: "session",
        method: "turn/started",
        turnId,
        payload: {
          turn: {
            ...(model ? { model } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
            permissionMode,
          },
        },
      }),
    );

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      permissionMode,
    ];
    if (model) {
      args.push("--model", model);
    }

    const resumeCursor = nonEmptyTrimmed(asString(context.session.resumeCursor));
    if (resumeCursor) {
      if (context.useResumeOnNextTurn) {
        args.push("--resume", resumeCursor);
      } else {
        args.push("--session-id", resumeCursor);
      }
    }
    args.push("--", prompt);

    const child: ClaudeCodeChildProcess = spawn(context.binaryPath, args, {
      cwd: context.session.cwd,
      env: {
        ...process.env,
        ...(context.homePath ? { CLAUDE_CONFIG_DIR: context.homePath } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    context.activeChild = child;
    context.activeOutput = readline.createInterface({ input: child.stdout });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    context.activeOutput.on("line", (line) => {
      this.#handleStreamJsonLine(context, line);
    });
    child.on("error", (error) => {
      this.#emitEvent(
        context,
        this.#makeEvent({
          threadId: context.session.threadId,
          kind: "error",
          method: "runtime/error",
          turnId,
          message: error.message,
          payload: { class: "process_error" },
        }),
      );
    });
    child.on("close", (code, signal) => {
      const activeTurn = context.activeTurn;
      if (!activeTurn || activeTurn.resultSeen) {
        context.activeChild = undefined;
        context.activeOutput = undefined;
        return;
      }

      const interrupted = activeTurn.interrupted || signal === "SIGINT";
      const errorMessage = interrupted
        ? "Claude Code turn interrupted"
        : resultSummary(stderr) ?? `Claude Code exited with code ${code ?? 1}.`;
      this.#emitTurnCompleted(context, {
        turnId,
        state: interrupted ? "interrupted" : "failed",
        ...(signal ? { stopReason: signal } : {}),
        errorMessage,
      });
    });

    return {
      threadId: input.threadId,
      turnId,
      ...(resumeCursor ? { resumeCursor } : {}),
    };
  }

  #emitTurnCompleted(
    context: ClaudeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly state: "completed" | "failed" | "interrupted" | "cancelled";
      readonly stopReason?: string;
      readonly usage?: unknown;
      readonly totalCostUsd?: number;
      readonly errorMessage?: string;
    },
  ): void {
    const activeTurn = context.activeTurn;
    if (!activeTurn) {
      return;
    }
    activeTurn.resultSeen = true;
    const snapshotEvents = activeTurn.events.slice();

    context.turns.push({
      id: input.turnId,
      items: snapshotEvents,
    });
    const { activeTurnId: _activeTurnId, lastError: _lastSessionError, ...restSession } =
      context.session;
    context.session = {
      ...restSession,
      status: input.state === "failed" ? "error" : "ready",
      updatedAt: new Date().toISOString(),
      ...(input.errorMessage ? { lastError: input.errorMessage } : {}),
    };
    context.useResumeOnNextTurn = true;
    context.activeTurn = undefined;
    context.activeOutput?.close();
    context.activeOutput = undefined;
    context.activeChild = undefined;

    this.#emitEvent(
      context,
      this.#makeEvent({
        threadId: context.session.threadId,
        kind: "session",
        method: "turn/completed",
        turnId: input.turnId,
        payload: {
          turn: {
            status: input.state,
            ...(input.stopReason ? { stopReason: input.stopReason } : {}),
            ...(input.usage !== undefined ? { usage: input.usage } : {}),
            ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
            ...(input.errorMessage ? { error: { message: input.errorMessage } } : {}),
          },
        },
      }),
    );
  }

  #handleSystemEvent(context: ClaudeSessionContext, line: Record<string, unknown>): void {
    const subtype = asString(line.subtype);
    const turnId = context.activeTurn?.turnId;

    if (subtype === "task_started") {
      const taskId = nonEmptyTrimmed(asString(line.task_id));
      if (!taskId) {
        return;
      }
      this.#emitEvent(
        context,
        this.#makeEvent({
          threadId: context.session.threadId,
          kind: "notification",
          method: "task/started",
          ...(turnId ? { turnId } : {}),
          payload: {
            taskId,
            ...(nonEmptyTrimmed(asString(line.description))
              ? { description: nonEmptyTrimmed(asString(line.description)) }
              : {}),
            ...(nonEmptyTrimmed(asString(line.task_type))
              ? { taskType: nonEmptyTrimmed(asString(line.task_type)) }
              : {}),
            ...(nonEmptyTrimmed(asString(line.tool_use_id))
              ? { toolUseId: nonEmptyTrimmed(asString(line.tool_use_id)) }
              : {}),
          },
        }),
      );
      return;
    }

    if (subtype === "task_notification") {
      const taskId = nonEmptyTrimmed(asString(line.task_id));
      if (!taskId) {
        return;
      }
      const status = nonEmptyTrimmed(asString(line.status));
      if (status === "completed" || status === "failed" || status === "stopped") {
        this.#emitEvent(
          context,
          this.#makeEvent({
            threadId: context.session.threadId,
            kind: "notification",
            method: "task/completed",
            ...(turnId ? { turnId } : {}),
            payload: {
              taskId,
              status,
              ...(nonEmptyTrimmed(asString(line.summary))
                ? { summary: nonEmptyTrimmed(asString(line.summary)) }
                : {}),
              ...(line.usage !== undefined ? { usage: line.usage } : {}),
            },
          }),
        );
        return;
      }

      this.#emitEvent(
        context,
        this.#makeEvent({
          threadId: context.session.threadId,
          kind: "notification",
          method: "task/progress",
          ...(turnId ? { turnId } : {}),
          payload: {
            taskId,
            description: nonEmptyTrimmed(asString(line.summary)) ?? status ?? "Task update",
            ...(line.usage !== undefined ? { usage: line.usage } : {}),
          },
        }),
      );
      return;
    }

    if (subtype === "hook_started") {
      const hookId = nonEmptyTrimmed(asString(line.hook_id));
      const hookName = nonEmptyTrimmed(asString(line.hook_name));
      const hookEvent = nonEmptyTrimmed(asString(line.hook_event));
      if (!hookId || !hookName || !hookEvent) {
        return;
      }
      this.#emitEvent(
        context,
        this.#makeEvent({
          threadId: context.session.threadId,
          kind: "notification",
          method: "hook/started",
          ...(turnId ? { turnId } : {}),
          payload: {
            hookId,
            hookName,
            hookEvent,
          },
        }),
      );
      return;
    }

    if (subtype === "hook_response") {
      const hookId = nonEmptyTrimmed(asString(line.hook_id));
      if (!hookId) {
        return;
      }
      this.#emitEvent(
        context,
        this.#makeEvent({
          threadId: context.session.threadId,
          kind: "notification",
          method: "hook/completed",
          ...(turnId ? { turnId } : {}),
          payload: {
            hookId,
            outcome: nonEmptyTrimmed(asString(line.outcome)) ?? "success",
            ...(line.output !== undefined ? { output: line.output } : {}),
            ...(line.stdout !== undefined ? { stdout: line.stdout } : {}),
            ...(line.stderr !== undefined ? { stderr: line.stderr } : {}),
            ...(asNumber(line.exit_code) !== undefined ? { exitCode: asNumber(line.exit_code) } : {}),
          },
        }),
      );
    }
  }

  #handleStreamEvent(context: ClaudeSessionContext, line: Record<string, unknown>): void {
    const turn = context.activeTurn;
    if (!turn) {
      return;
    }
    const event = asObject(line.event);
    const type = asString(event?.type);
    if (!type) {
      return;
    }

    switch (type) {
      case "message_start":
      case "message_delta":
      case "message_stop":
      case "ping":
        return;
      case "error": {
        const nativeError = asObject(event?.error);
        const message = nonEmptyTrimmed(
          asString(nativeError?.message) ?? asString(event?.message),
        );
        if (!message) {
          return;
        }
        this.#emitEvent(
          context,
          this.#makeEvent({
            threadId: context.session.threadId,
            kind: "error",
            method: "runtime/error",
            turnId: turn.turnId,
            message,
            payload: {
              class: "provider_error",
              ...(asString(nativeError?.type) ? { nativeType: asString(nativeError?.type) } : {}),
              ...(nativeError ? { error: nativeError } : { error: event }),
            },
          }),
        );
        return;
      }
      case "content_block_start": {
        const contentBlock = asObject(event?.content_block);
        const contentBlockType = asString(contentBlock?.type);
        if (contentBlockType === "web_search_tool_result") {
          const toolUseId = nonEmptyTrimmed(asString(contentBlock?.tool_use_id));
          if (!toolUseId) {
            return;
          }
          const toolState = turn.toolUsesById.get(toolUseId);
          const result = contentBlock?.content;
          this.#emitEvent(
            context,
            this.#makeEvent({
              threadId: context.session.threadId,
              kind: "notification",
              method: "item/tool/completed",
              turnId: turn.turnId,
              itemId: ProviderItemId.makeUnsafe(toolUseId),
              payload: {
                item: {
                  type: "web_search_tool_result",
                  toolName: toolState?.name ?? "web_search",
                  status: isWebSearchToolResultError(result) ? "failed" : "completed",
                  input: toolState?.input,
                  result,
                  summary: resultSummary(result),
                },
              },
            }),
          );
          return;
        }

        if (contentBlockType !== "tool_use" && contentBlockType !== "server_tool_use") {
          return;
        }
        const toolUseId = nonEmptyTrimmed(asString(contentBlock?.id));
        const toolName = nonEmptyTrimmed(asString(contentBlock?.name));
        const contentIndex = asNumber(event?.index);
        if (!toolUseId || !toolName || contentIndex === undefined) {
          return;
        }
        const toolState = {
          id: toolUseId,
          name: toolName,
          type: contentBlockType,
          partialJson: "",
          ...(contentBlock?.input !== undefined ? { input: contentBlock.input } : {}),
        } satisfies ClaudeToolUseState;
        turn.toolUsesById.set(toolUseId, toolState);
        turn.toolUsesByIndex.set(contentIndex, toolState);
        return;
      }
      case "content_block_delta": {
        const delta = asObject(event?.delta);
        const deltaType = asString(delta?.type);
        if (deltaType === "text_delta" || deltaType === "thinking_delta") {
          const text = nonEmptyString(asString(delta?.text) ?? asString(delta?.thinking));
          if (!text) {
            return;
          }
          this.#emitEvent(
            context,
            this.#makeEvent({
              threadId: context.session.threadId,
              kind: "notification",
              method: "turn/content-delta",
              turnId: turn.turnId,
              payload: {
                streamKind: deltaType === "thinking_delta" ? "reasoning_text" : "assistant_text",
                delta: text,
              },
            }),
          );
          return;
        }

        if (deltaType === "signature_delta") {
          return;
        }

        if (deltaType !== "input_json_delta") {
          return;
        }

        const contentIndex = asNumber(event?.index);
        if (contentIndex === undefined) {
          return;
        }
        const toolState = turn.toolUsesByIndex.get(contentIndex);
        if (!toolState) {
          return;
        }
        toolState.partialJson += asString(delta?.partial_json) ?? "";
        return;
      }
      case "content_block_stop": {
        const contentIndex = asNumber(event?.index);
        if (contentIndex === undefined) {
          return;
        }
        const toolState = turn.toolUsesByIndex.get(contentIndex);
        if (!toolState) {
          return;
        }
        toolState.input =
          toolState.partialJson.length > 0 ? parsePartialJson(toolState.partialJson) : toolState.input;
        const itemId = ProviderItemId.makeUnsafe(toolState.id);
        this.#emitEvent(
          context,
          this.#makeEvent({
            threadId: context.session.threadId,
            kind: "notification",
            method: toolState.type === "server_tool_use" ? "item/tool/updated" : "item/tool/started",
            turnId: turn.turnId,
            itemId,
            payload: {
              item: {
                type: toolState.type,
                toolName: toolState.name,
                input: toolState.input,
                summary: toolInputSummary(toolState.input),
              },
            },
          }),
        );
        return;
      }
      default:
        return;
    }
  }

  #handleUserEvent(context: ClaudeSessionContext, line: Record<string, unknown>): void {
    const turn = context.activeTurn;
    if (!turn) {
      return;
    }
    const message = asObject(line.message);
    const content = asArray(message?.content) ?? [];
    for (const entry of content) {
      const toolResult = asObject(entry);
      if (asString(toolResult?.type) !== "tool_result") {
        continue;
      }
      const toolUseId = nonEmptyTrimmed(asString(toolResult?.tool_use_id));
      if (!toolUseId) {
        continue;
      }
      const itemId = ProviderItemId.makeUnsafe(toolUseId);
      const toolState = turn.toolUsesById.get(toolUseId);
      this.#emitEvent(
        context,
        this.#makeEvent({
          threadId: context.session.threadId,
          kind: "notification",
          method: "item/tool/completed",
          turnId: turn.turnId,
          itemId,
          payload: {
            item: {
              type: "tool_use",
              toolName: toolState?.name,
              status: toolResult?.is_error === true ? "failed" : "completed",
              input: toolState?.input,
              result: line.tool_use_result ?? toolResult?.content,
              summary: resultSummary(line.tool_use_result ?? toolResult?.content),
            },
          },
        }),
      );
    }
  }

  #handleResultEvent(context: ClaudeSessionContext, line: Record<string, unknown>): void {
    const turn = context.activeTurn;
    if (!turn) {
      return;
    }
    const sessionId = nonEmptyTrimmed(asString(line.session_id));
    if (sessionId) {
      context.session = {
        ...context.session,
        resumeCursor: sessionId,
      };
    }
    const subtype = nonEmptyTrimmed(asString(line.subtype));
    const isError = line.is_error === true || subtype === "error";
    const totalCostUsd = asNumber(line.total_cost_usd);
    this.#emitTurnCompleted(context, {
      turnId: turn.turnId,
      state: turn.interrupted ? "interrupted" : isError ? "failed" : "completed",
      ...(subtype ? { stopReason: subtype } : {}),
      ...(line.usage !== undefined ? { usage: line.usage } : {}),
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      ...(isError ? { errorMessage: resultSummary(line.result) ?? "Claude Code turn failed." } : {}),
    });
  }

  #handleStreamJsonLine(context: ClaudeSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      this.#emitEvent(
        context,
        this.#makeEvent({
          threadId: context.session.threadId,
          kind: "error",
          method: "runtime/error",
          ...(context.activeTurn?.turnId ? { turnId: context.activeTurn.turnId } : {}),
          message: cause instanceof Error ? cause.message : "Failed to parse Claude Code JSON line",
          payload: {
            class: "invalid_native_event",
            line,
          },
        }),
      );
      return;
    }

    const record = asObject(parsed);
    const type = asString(record?.type);
    if (!record || !type) {
      return;
    }

    switch (type) {
      case "system":
        this.#handleSystemEvent(context, record);
        return;
      case "stream_event":
        this.#handleStreamEvent(context, record);
        return;
      case "user":
        this.#handleUserEvent(context, record);
        return;
      case "result":
        this.#handleResultEvent(context, record);
        return;
      default:
        return;
    }
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.#getSessionContext(threadId);
    const activeTurn = context.activeTurn;
    if (!activeTurn || !context.activeChild) {
      return;
    }
    if (turnId && activeTurn.turnId !== turnId) {
      return;
    }
    activeTurn.interrupted = true;
    context.activeChild.kill("SIGINT");
  }

  async respondToRequest(
    _threadId: ThreadId,
    _requestId: string,
    _decision: ProviderApprovalDecision,
  ): Promise<void> {
    throw new Error("Claude Code approval request responses are not wired in the server adapter yet.");
  }

  async respondToUserInput(
    _threadId: ThreadId,
    _requestId: string,
    _answers: ProviderUserInputAnswers,
  ): Promise<void> {
    throw new Error("Claude Code user-input responses are not wired in the server adapter yet.");
  }

  stopSession(threadId: ThreadId): void {
    const context = this.#sessions.get(threadId);
    if (!context) {
      return;
    }
    if (context.activeTurn) {
      context.activeTurn.interrupted = true;
    }
    context.activeChild?.kill("SIGINT");
    context.activeOutput?.close();
    this.#sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.#sessions.values(), ({ session }) => session);
  }

  hasSession(threadId: ThreadId): boolean {
    return this.#sessions.has(threadId);
  }

  async readThread(threadId: ThreadId): Promise<ClaudeCodeThreadSnapshot> {
    const context = this.#getSessionContext(threadId);
    return {
      threadId,
      turns: context.turns,
    };
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<ClaudeCodeThreadSnapshot> {
    const context = this.#getSessionContext(threadId);
    if (numTurns <= 0) {
      return { threadId, turns: context.turns };
    }
    if (numTurns < context.turns.length) {
      throw new Error("Claude Code rollback currently supports full-thread reset only.");
    }
    context.turns = [];
    context.useResumeOnNextTurn = false;
    const { activeTurnId: _clearedActiveTurnId, lastError: _clearedLastError, ...rollbackSession } =
      context.session;
    context.session = {
      ...rollbackSession,
      resumeCursor: randomUUID(),
      updatedAt: new Date().toISOString(),
      status: "ready",
    };
    return {
      threadId,
      turns: context.turns,
    };
  }

  stopAll(): void {
    for (const threadId of Array.from(this.#sessions.keys())) {
      this.stopSession(threadId);
    }
  }
}