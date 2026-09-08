/**
 * CommandCodeAdapter — `ProviderAdapterShape` for the Command Code CLI.
 *
 * Command Code has no long-lived app-server session to talk JSON-RPC to:
 * headless mode is one `-p` subprocess per turn, resumable by session id.
 * Each `sendTurn` therefore spawns a fresh CLI, pipes the prompt over stdin,
 * parses the NDJSON event stream on stdout live, and folds it into canonical
 * `ProviderRuntimeEvent`s. A turn ends when the subprocess exits.
 *
 * Headless print mode cannot surface interactive approvals, so the adapter
 * never opens requests: it inherits the CLI's permission policy from the
 * instance's `permissionMode` setting (`--yolo` for auto-accept, nothing for
 * standard/read-only). `respondToRequest` / `respondToUserInput` report the
 * capability as unsupported.
 *
 * @module provider/Layers/CommandCodeAdapter
 */
import type {
  CommandCodeSettings,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  ChildProcess,
  type ChildProcessHandle,
  ChildProcessSpawner,
} from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { commandCodeTurnArgs } from "../commandCodeLaunchArgs.ts";

const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*m/g;

// ── NDJSON frame parsing ────────────────────────────────────────────

export interface CommandCodeEventFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type CommandCodeParsedLine =
  | { readonly kind: "frame"; readonly frame: CommandCodeEventFrame }
  | {
      readonly kind: "result";
      readonly result: {
        readonly subtype?: unknown;
        readonly sessionId?: unknown;
        readonly stopReason?: unknown;
        readonly usage?: unknown;
        readonly error?: unknown;
        readonly finalText?: unknown;
      };
    }
  | { readonly kind: "skip" };

/** Parse one NDJSON line from `command-code -p --output-format json`. */
export function parseCommandCodeNdjsonLine(line: string): CommandCodeParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { kind: "skip" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "skip" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "skip" };
  }
  const record = parsed as Record<string, unknown>;
  if (record["type"] === "event") {
    const event = record["event"];
    if (event !== null && typeof event === "object") {
      return { kind: "frame", frame: event as CommandCodeEventFrame };
    }
    return { kind: "skip" };
  }
  if (record["type"] === "result") {
    return {
      kind: "result",
      result: {
        subtype: record["subtype"],
        sessionId: record["sessionId"],
        stopReason: record["stopReason"],
        usage: record["usage"],
        error: record["error"],
        finalText: record["finalText"],
      },
    };
  }
  return { kind: "skip" };
}

// ── Payload helpers ─────────────────────────────────────────────────

interface UsageTotals {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

function readUsage(value: unknown): UsageTotals | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const numberOrUndefined = (key: string): number | undefined =>
    typeof record[key] === "number" ? (record[key] as number) : undefined;
  return {
    inputTokens: numberOrUndefined("inputTokens"),
    outputTokens: numberOrUndefined("outputTokens"),
    cacheReadTokens: numberOrUndefined("cacheReadTokens"),
    cacheWriteTokens: numberOrUndefined("cacheWriteTokens"),
  };
}

function toTurnTokenUsage(usage: UsageTotals): TurnTokenUsage {
  return {
    usageStatus: "complete",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.cacheReadTokens !== undefined ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cacheCreationTokens: usage.cacheWriteTokens }
      : {}),
    hasSubagents: false,
  };
}

function toThreadUsageSnapshot(usage: UsageTotals): ThreadTokenUsageSnapshot {
  const inputTokens = usage.inputTokens ?? 0;
  return {
    usedTokens: inputTokens,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
  };
}

function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 240) : undefined;
  }
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const filePath = typeof record["file_path"] === "string" ? record["file_path"] : undefined;
  const command = typeof record["command"] === "string" ? record["command"] : undefined;
  const value = filePath ?? command;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().slice(0, 240);
  }
  return undefined;
}

function itemTypeForTool(toolName: string): string {
  if (toolName === "shell_command" || toolName === "bash" || toolName === "powershell") {
    return "command_execution";
  }
  if (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "apply_patch" ||
    toolName === "multi_edit"
  ) {
    return "file_change";
  }
  if (toolName === "web_search" || toolName === "web_fetch") {
    return "web_search";
  }
  return "dynamic_tool_call";
}

// ── Adapter factory ─────────────────────────────────────────────────

interface CommandCodeAdapterOptions {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
}

interface CommandCodeSession {
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  /** Command Code headless session id; set after the first successful turn. */
  readonly commandCodeSessionId: string | undefined;
  readonly createdAt: string;
  updatedAt: string;
  lastError: string | undefined;
  /** Non-null while a turn subprocess is running for this thread. */
  activeRun: ActiveRun | null;
}

interface ActiveRun {
  readonly turnId: TurnId;
  readonly interrupted: Ref.Ref<boolean>;
  readonly child: ChildProcessHandle;
}

export function makeCommandCodeAdapter(
  config: CommandCodeSettings,
  options: CommandCodeAdapterOptions,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const driverKind = options.driverKind;
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderRuntimeEvent>(),
      PubSub.shutdown,
    );
    const sessions = yield* Ref.make<Map<ThreadId, CommandCodeSession>>(new Map());
    const eventCounter = yield* Ref.make(0);

    const nowIso = () => new Date().toISOString();

    const stampEventId = (): Effect.Effect<string> =>
      Ref.updateAndGet(eventCounter, (count) => count + 1).pipe(
        Effect.map((count) => `cc-${count}`),
      );

    const offer = (input: {
      readonly type: ProviderRuntimeEvent["type"];
      readonly payload: Record<string, unknown>;
      readonly threadId: ThreadId;
      readonly turnId?: TurnId;
      readonly itemId?: string;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const eventId = yield* stampEventId();
        const event = {
          eventId,
          provider: driverKind,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          createdAt: nowIso(),
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
          type: input.type,
          payload: input.payload,
        };
        yield* PubSub.publish(pubsub, event as unknown as ProviderRuntimeEvent);
      });

    const getSession = (threadId: ThreadId): Effect.Effect<CommandCodeSession> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((map) => {
          const session = map.get(threadId);
          return session === undefined
            ? Effect.fail(
                new ProviderAdapterSessionNotFoundError({
                  provider: driverKind,
                  threadId,
                }),
              )
            : Effect.succeed(session);
        }),
      );

    const updateSession = (
      threadId: ThreadId,
      patch: (session: CommandCodeSession) => CommandCodeSession,
    ): Effect.Effect<void> =>
      Ref.update(sessions, (map) => {
        const session = map.get(threadId);
        return session === undefined
          ? map
          : new Map(map).set(threadId, { ...patch(session), updatedAt: nowIso() });
      });

    const runTurn = Effect.fn("commandCodeTurn")(function* (
      threadId: ThreadId,
      turnId: TurnId,
      prompt: string,
      model: string | undefined,
    ) {
      const session = yield* getSession(threadId);
      const interrupted = yield* Ref.make(false);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      yield* offer({
        type: "turn.started",
        threadId,
        turnId,
        payload: model === undefined ? {} : { model },
      });

      const args = commandCodeTurnArgs({
        permissionMode: config.permissionMode,
        model,
        resumeSessionId: session.commandCodeSessionId,
        launchArgs: config.launchArgs,
      });
      const resolved = yield* resolveSpawnCommand(config.binaryPath || "command-code", [...args], {
        env: options.environment,
        extendEnv: true,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
          env: options.environment,
          extendEnv: true,
          shell: resolved.shell,
          forceKillAfter: "2 seconds",
        }),
      );

      yield* updateSession(threadId, (current) => ({
        ...current,
        activeRun: { turnId, interrupted, child },
      }));

      // Stream the prompt over stdin; Command Code auto-detects piped input.
      yield* Stream.run(Stream.encodeText(Stream.make(prompt)), child.stdin).pipe(Effect.ignore);

      let buffer = "";
      let stderrTail = "";
      let lastUsage: UsageTotals | undefined;
      let sessionIdFromRun: string | undefined;
      let resultSubtype: string | undefined;
      let resultStopReason: string | undefined;
      let messageIndex = 0;
      let reasoningIndex = 0;
      let activeItemId: string | undefined;

      const handleLine = (line: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const parsed = parseCommandCodeNdjsonLine(line);
          if (parsed.kind === "result") {
            resultSubtype =
              typeof parsed.result.subtype === "string" ? parsed.result.subtype : undefined;
            resultStopReason =
              typeof parsed.result.stopReason === "string" ? parsed.result.stopReason : undefined;
            if (typeof parsed.result.sessionId === "string") {
              sessionIdFromRun = parsed.result.sessionId;
            }
            const usage = readUsage(parsed.result.usage);
            if (usage !== undefined) lastUsage = usage;
            return;
          }
          if (parsed.kind !== "frame") {
            return;
          }
          const frame = parsed.frame;
          switch (frame["type"]) {
            case "run_start": {
              if (typeof frame["sessionId"] === "string") {
                sessionIdFromRun = frame["sessionId"];
              }
              return;
            }
            case "message_start": {
              messageIndex += 1;
              activeItemId = `assistant-${messageIndex}`;
              yield* offer({
                type: "item.started",
                threadId,
                turnId,
                itemId: activeItemId,
                payload: { itemType: "assistant_message", status: "inProgress" },
              });
              return;
            }
            case "text_delta": {
              if (typeof frame["delta"] !== "string") return;
              yield* offer({
                type: "content.delta",
                threadId,
                turnId,
                itemId: activeItemId ?? `assistant-${messageIndex + 1}`,
                payload: { streamKind: "assistant_text", delta: frame["delta"] },
              });
              return;
            }
            case "thinking_start": {
              reasoningIndex += 1;
              yield* offer({
                type: "item.started",
                threadId,
                turnId,
                itemId: `reasoning-${reasoningIndex}`,
                payload: { itemType: "reasoning", status: "inProgress" },
              });
              return;
            }
            case "thinking_delta": {
              if (typeof frame["delta"] !== "string") return;
              yield* offer({
                type: "content.delta",
                threadId,
                turnId,
                itemId: `reasoning-${reasoningIndex}`,
                payload: { streamKind: "reasoning_text", delta: frame["delta"] },
              });
              return;
            }
            case "thinking_end": {
              yield* offer({
                type: "item.completed",
                threadId,
                turnId,
                itemId: `reasoning-${reasoningIndex}`,
                payload: { itemType: "reasoning", status: "completed" },
              });
              return;
            }
            case "message_end": {
              if (activeItemId !== undefined) {
                yield* offer({
                  type: "item.completed",
                  threadId,
                  turnId,
                  itemId: activeItemId,
                  payload: { itemType: "assistant_message", status: "completed" },
                });
                activeItemId = undefined;
              }
              return;
            }
            case "tool_queued": {
              const toolCallId =
                typeof frame["toolCallId"] === "string" ? frame["toolCallId"] : undefined;
              const toolName = typeof frame["toolName"] === "string" ? frame["toolName"] : "tool";
              if (toolCallId === undefined) return;
              const itemId = `tool-${toolCallId}`;
              const detail = summarizeToolInput(frame["input"]);
              yield* offer({
                type: "item.started",
                threadId,
                turnId,
                itemId,
                payload: {
                  itemType: itemTypeForTool(toolName),
                  status: "inProgress",
                  title: toolName,
                  ...(detail !== undefined ? { detail } : {}),
                },
              });
              return;
            }
            case "tool_running":
            case "tool_update": {
              const toolCallId =
                typeof frame["toolCallId"] === "string" ? frame["toolCallId"] : undefined;
              const toolName = typeof frame["toolName"] === "string" ? frame["toolName"] : "tool";
              if (toolCallId === undefined) return;
              const description =
                typeof frame["description"] === "string" ? frame["description"] : undefined;
              yield* offer({
                type: "tool.progress",
                threadId,
                turnId,
                payload: {
                  ...(description !== undefined && description.length > 0
                    ? { summary: description }
                    : {}),
                  toolUseId: toolCallId,
                  toolName,
                },
              });
              return;
            }
            case "tool_denied":
            case "tool_hook_blocked": {
              const toolCallId =
                typeof frame["toolCallId"] === "string" ? frame["toolCallId"] : undefined;
              const toolName = typeof frame["toolName"] === "string" ? frame["toolName"] : "tool";
              if (toolCallId === undefined) return;
              const reason =
                typeof frame["hookOutput"] === "string"
                  ? frame["hookOutput"]
                  : typeof frame["reason"] === "string"
                    ? frame["reason"]
                    : undefined;
              yield* offer({
                type: "tool.denied",
                threadId,
                turnId,
                payload: {
                  toolName,
                  toolUseId: toolCallId,
                  ...(reason !== undefined ? { reason } : {}),
                },
              });
              yield* offer({
                type: "item.completed",
                threadId,
                turnId,
                itemId: `tool-${toolCallId}`,
                payload: { itemType: itemTypeForTool(toolName), status: "declined" },
              });
              return;
            }
            case "tool_completed": {
              const toolCallId =
                typeof frame["toolCallId"] === "string" ? frame["toolCallId"] : undefined;
              const toolName = typeof frame["toolName"] === "string" ? frame["toolName"] : "tool";
              if (toolCallId === undefined) return;
              yield* offer({
                type: "item.completed",
                threadId,
                turnId,
                itemId: `tool-${toolCallId}`,
                payload: { itemType: itemTypeForTool(toolName), status: "completed" },
              });
              return;
            }
            case "model_request_end": {
              const usage = readUsage(frame["usage"]);
              if (usage !== undefined) lastUsage = usage;
              return;
            }
            default:
              return; // Forward-compatible: unknown frame types are ignored.
          }
        });

      const interruptSignal = Ref.get(interrupted);

      const stdoutLoop = child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk: string) =>
          Effect.gen(function* () {
            buffer += chunk;
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);
              yield* handleLine(line);
            }
          }),
        ),
      );

      const stderrLoop = child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk: string) =>
          Effect.sync(() => {
            const next = (stderrTail + chunk).replace(ANSI_ESCAPE_REGEX, "");
            stderrTail = next.length > 8_000 ? next.slice(next.length - 8_000) : next;
          }),
        ),
      );

      yield* Effect.fork(stdoutLoop);
      yield* Effect.fork(stderrLoop);

      const exitCode = yield* child.exitCode.pipe(
        Effect.map((code) => (typeof code === "number" ? code : Number(code))),
      );

      // Drain anything left after the last newline.
      if (buffer.trim().length > 0) {
        yield* handleLine(buffer);
        buffer = "";
      }

      const wasInterrupted = yield* interruptSignal;
      const usage = lastUsage;

      // Adopt the Command Code session id reported by the run so the next
      // turn resumes this conversation (and T3 persists it as the cursor).
      if (sessionIdFromRun !== undefined && sessionIdFromRun !== session.commandCodeSessionId) {
        yield* updateSession(threadId, (current) => ({
          ...current,
          commandCodeSessionId: sessionIdFromRun,
        }));
      }

      if (wasInterrupted) {
        yield* offer({
          type: "turn.aborted",
          threadId,
          turnId,
          payload: {
            reason: "interrupted",
            ...(usage !== undefined ? { tokenUsage: toTurnTokenUsage(usage) } : {}),
          },
        });
        return "interrupted" as const;
      }

      if (resultSubtype !== "error" && (resultSubtype === "success" || exitCode === 0)) {
        yield* offer({
          type: "turn.completed",
          threadId,
          turnId,
          payload: {
            state: "completed",
            ...(resultStopReason !== undefined ? { stopReason: resultStopReason } : {}),
            ...(usage !== undefined ? { tokenUsage: toTurnTokenUsage(usage), usage } : {}),
          },
        });
        if (usage !== undefined) {
          yield* offer({
            type: "thread.token-usage.updated",
            threadId,
            payload: { usage: toThreadUsageSnapshot(usage) },
          });
        }
        return "completed" as const;
      }

      // Failure path. Prefer a structured message from stderr; exit codes map
      // to the canonical error classes.
      const stderrMessage = stderrTail.trim().split(/\r?\n/).slice(-3).join("\n").trim();
      const detail =
        resultSubtype === "error"
          ? `Command Code turn failed${exitCode !== 0 ? ` (exit ${exitCode})` : ""}`
          : `Command Code exited with code ${exitCode}`;
      const message = (
        typeof stderrMessage === "string" && stderrMessage.length > 0
          ? `${detail}: ${stderrMessage}`
          : detail
      ).slice(0, 2_000);
      const errorClass =
        exitCode === 3 || exitCode === 4
          ? ("permission_error" as const)
          : exitCode === 10
            ? ("provider_error" as const)
            : exitCode === 1
              ? ("validation_error" as const)
              : ("provider_error" as const);

      yield* offer({
        type: "runtime.error",
        threadId,
        turnId,
        payload: { message, class: errorClass },
      });
      yield* offer({
        type: "turn.completed",
        threadId,
        turnId,
        payload: { state: "failed", errorMessage: message },
      });
      return "failed" as const;
    });

    const closeSessionState = (threadId: ThreadId) =>
      updateSession(threadId, (current) => ({ ...current, activeRun: null }));

    return {
      provider: driverKind,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      },
      startSession: (input: ProviderSessionStartInput) =>
        Effect.gen(function* () {
          const now = nowIso();
          const resumeCursor = input.resumeCursor;
          const commandCodeSessionId =
            resumeCursor !== null &&
            typeof resumeCursor === "object" &&
            typeof (resumeCursor as { sessionId?: unknown }).sessionId === "string"
              ? (resumeCursor as { sessionId: string }).sessionId
              : undefined;
          const model = input.modelSelection?.model;
          const session: CommandCodeSession = {
            threadId: input.threadId,
            cwd: input.cwd,
            model,
            commandCodeSessionId,
            createdAt: now,
            updatedAt: now,
            lastError: undefined,
            activeRun: null,
          };
          yield* Ref.update(sessions, (map) => new Map(map).set(input.threadId, session));
          const providerSession: ProviderSession = {
            provider: driverKind,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: "full-access",
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(model !== undefined ? { model } : {}),
            threadId: input.threadId,
            ...(commandCodeSessionId !== undefined
              ? { resumeCursor: { sessionId: commandCodeSessionId } }
              : {}),
            createdAt: now,
            updatedAt: now,
          };
          return providerSession;
        }),
      sendTurn: (input: ProviderSendTurnInput) =>
        Effect.gen(function* () {
          const session = yield* getSession(input.threadId);
          if (session.activeRun !== null) {
            return yield* new ProviderAdapterRequestError({
              provider: driverKind,
              method: "sendTurn",
              detail: "a turn is already running for this thread",
            });
          }
          const prompt = input.input ?? (input.continuation === true ? "Continue." : "");
          if (prompt.trim().length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: driverKind,
              operation: "sendTurn",
              issue: "a turn needs non-empty text input",
            });
          }
          const model = input.modelSelection?.model ?? session.model;
          const turnId =
            `cc-turn-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}` as TurnId;
          yield* updateSession(input.threadId, (current) => ({
            ...current,
            activeRun: current.activeRun,
          }));
          const outcome = yield* runTurn(input.threadId, turnId, prompt, model).pipe(
            Effect.tapError((error) =>
              Effect.logError(`commandCode turn failed for thread ${input.threadId}`, error),
            ),
          );
          yield* closeSessionState(input.threadId);
          if (outcome === "interrupted") {
            return yield* new ProviderAdapterRequestError({
              provider: driverKind,
              method: "sendTurn",
              detail: "turn interrupted",
            });
          }
          const updated = yield* getSession(input.threadId);
          const providerResult: ProviderTurnStartResult = {
            threadId: input.threadId,
            turnId,
            ...(updated.commandCodeSessionId !== undefined
              ? { resumeCursor: { sessionId: updated.commandCodeSessionId } }
              : {}),
          };
          return providerResult;
        }),
      compaction: undefined,
      interruptTurn: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const session = yield* getSession(threadId);
          const activeRun = session.activeRun;
          if (activeRun === null) {
            return yield* new ProviderAdapterValidationError({
              provider: driverKind,
              operation: "interruptTurn",
              issue: "no turn is running for this thread",
            });
          }
          yield* Ref.set(activeRun.interrupted, true);
          yield* activeRun.child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
        }),
      respondToRequest: (
        _threadId: ThreadId,
        _requestId: string,
        _decision: ProviderApprovalDecision,
      ) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: driverKind,
            operation: "respondToRequest",
            issue: "Command Code headless turns do not surface approval requests",
          }),
        ),
      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: string,
        _answers: ProviderUserInputAnswers,
      ) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: driverKind,
            operation: "respondToUserInput",
            issue: "Command Code headless turns do not surface user-input requests",
          }),
        ),
      stopSession: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const session = yield* getSession(threadId);
          if (session.activeRun !== null) {
            yield* session.activeRun.child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
          }
          yield* Ref.update(sessions, (map) => {
            const next = new Map(map);
            next.delete(threadId);
            return next;
          });
        }),
      listSessions: () =>
        Ref.get(sessions).pipe(
          Effect.map((map) =>
            [...map.values()].map((session): ProviderSession => ({
              provider: driverKind,
              providerInstanceId: options.instanceId,
              status: session.activeRun === null ? "ready" : "running",
              runtimeMode: "full-access",
              ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
              ...(session.model !== undefined ? { model: session.model } : {}),
              threadId: session.threadId,
              ...(session.commandCodeSessionId !== undefined
                ? { resumeCursor: { sessionId: session.commandCodeSessionId } }
                : {}),
              ...(session.activeRun !== null ? { activeTurnId: session.activeRun.turnId } : {}),
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
            })),
          ),
        ),
      hasSession: (threadId: ThreadId) =>
        Ref.get(sessions).pipe(Effect.map((map) => map.has(threadId))),
      readThread: (threadId: ThreadId) =>
        Effect.gen(function* () {
          yield* getSession(threadId);
          return { threadId, turns: [] };
        }),
      rollbackThread: () =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: driverKind,
            operation: "rollbackThread",
            issue: "Command Code sessions cannot be rewound headlessly",
          }),
        ),
      stopAll: () =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions);
          for (const session of current.values()) {
            if (session.activeRun !== null) {
              yield* session.activeRun.child
                .kill({ forceKillAfter: "1 second" })
                .pipe(Effect.ignore);
            }
          }
          yield* Ref.set(sessions, new Map());
        }),
      get streamEvents() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
