import {
  type ChildProcess as ChildProcessHandle,
  spawn,
  spawnSync,
} from "node:child_process";

import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CURSOR_PROVIDER, resolveCursorBinaryPath } from "../cursorCli.ts";
import { CursorAdapter, type CursorAdapterShape } from "../Services/CursorAdapter.ts";

const PROVIDER = CURSOR_PROVIDER;

type CursorInteractionMode = ProviderSendTurnInput["interactionMode"];

export interface CursorAdapterLiveOptions {
  readonly spawnProcess?: typeof spawn;
}

interface ActiveTurnState {
  readonly child: ChildProcessHandle;
  readonly turnId: TurnId;
  readonly interactionMode: CursorInteractionMode;
  interrupted: boolean;
  assistantText: string;
  assistantTextEmitted: boolean;
  finalText?: string;
  inFlightToolItemIds: Set<string>;
}

interface CursorSessionState {
  readonly createdAt: string;
  binaryPath: string;
  status: ProviderSession["status"];
  runtimeMode: ProviderSession["runtimeMode"];
  threadId: ThreadId;
  cwd?: string | undefined;
  model?: string | undefined;
  resumeCursor?: string | undefined;
  updatedAt: string;
  lastError?: string | undefined;
  activeTurn?: ActiveTurnState | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function normalizeResumeCursor(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["sessionId", "session_id", "resumeCursor", "resume_cursor"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractText(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractText(entry))
      .filter((entry): entry is string => entry !== undefined);
    return parts.length > 0 ? parts.join("") : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of ["text", "content", "message", "delta", "result", "output"] as const) {
    const nested = extractText(record[key]);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function extractCursorSessionId(payload: Record<string, unknown>): string | undefined {
  return (
    asTrimmedString(payload.session_id) ??
    asTrimmedString(payload.sessionId) ??
    asTrimmedString(asRecord(payload.session)?.id)
  );
}

function toolItemType(name: string | undefined):
  | "command_execution"
  | "file_change"
  | "web_search"
  | "image_view"
  | "dynamic_tool_call" {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (
    normalized.includes("command") ||
    normalized.includes("terminal") ||
    normalized.includes("shell") ||
    normalized.includes("bash")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  if (normalized.includes("search") || normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function toolDetail(payload: Record<string, unknown>): string | undefined {
  const toolCall = asRecord(payload.toolCall) ?? asRecord(payload.tool_call);
  const args = asRecord(toolCall?.args) ?? asRecord(payload.args);
  const command =
    extractText(args?.command) ?? extractText(args?.cmd) ?? extractText(args?.argv) ?? undefined;
  if (command) {
    return command;
  }
  return (
    extractText(args?.path) ??
    extractText(args?.query) ??
    extractText(toolCall?.name) ??
    extractText(payload.name)
  );
}

function toolItemId(payload: Record<string, unknown>, fallbackTurnId: TurnId): string {
  return (
    asTrimmedString(payload.toolCallId) ??
    asTrimmedString(payload.tool_call_id) ??
    asTrimmedString(asRecord(payload.toolCall)?.id) ??
    asTrimmedString(payload.id) ??
    `cursor-tool:${fallbackTurnId}:${crypto.randomUUID()}`
  );
}

function buildCursorPrompt(input: string, interactionMode: CursorInteractionMode): string {
  if (interactionMode !== "plan") {
    return input;
  }
  return [
    "Plan mode: do not make changes or run write actions.",
    "Return a concise implementation plan in markdown only.",
    "",
    input,
  ].join("\n");
}

function buildCursorArgs(input: {
  readonly prompt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly model?: string;
  readonly resumeCursor?: string;
}): string[] {
  return [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    ...(input.model ? ["-m", input.model] : []),
    ...(input.resumeCursor ? ["--resume", input.resumeCursor] : []),
    ...(input.runtimeMode === "full-access" ? ["--force"] : []),
  ];
}

function killChild(child: ChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall back to direct kill.
    }
  }
  child.kill(signal);
}

function attachLineReader(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void) {
  if (!stream) {
    return;
  }
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    while (true) {
      const lineBreakIndex = buffer.indexOf("\n");
      if (lineBreakIndex < 0) {
        break;
      }
      const line = buffer.slice(0, lineBreakIndex).trim();
      buffer = buffer.slice(lineBreakIndex + 1);
      if (line.length > 0) {
        onLine(line);
      }
    }
  });
  stream.on("end", () => {
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      onLine(trailing);
    }
  });
}

function toProviderSession(session: CursorSessionState): ProviderSession {
  return {
    provider: PROVIDER,
    status: session.status,
    runtimeMode: session.runtimeMode,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.model ? { model: session.model } : {}),
    threadId: session.threadId,
    ...(session.resumeCursor ? { resumeCursor: session.resumeCursor } : {}),
    ...(session.activeTurn ? { activeTurnId: session.activeTurn.turnId } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

const makeCursorAdapter = (options?: CursorAdapterLiveOptions) =>
  Effect.gen(function* () {
    const spawnProcess = options?.spawnProcess ?? spawn;
    const services = yield* Effect.services<never>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, CursorSessionState>();

    const emit = (event: ProviderRuntimeEvent): void => {
      void Queue.offer(runtimeEventQueue, event)
        .pipe(Effect.asVoid, Effect.runPromiseWith(services))
        .catch(() => undefined);
    };

    const baseEvent = (threadId: ThreadId, turnId?: TurnId) => ({
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      provider: PROVIDER,
      threadId,
      createdAt: nowIso(),
      ...(turnId ? { turnId } : {}),
    });

    const requireSession = (threadId: ThreadId): CursorSessionState => {
      const session = sessions.get(threadId);
      if (!session) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return session;
    };

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      Effect.try({
        try: () => {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }

          const existing = sessions.get(input.threadId);
          const createdAt = existing?.createdAt ?? nowIso();
          const updatedAt = nowIso();
          const requestedBinaryPath = input.providerOptions?.cursor?.binaryPath;
          const normalizedResumeCursor = normalizeResumeCursor(input.resumeCursor);
          const next: CursorSessionState = {
            createdAt,
            binaryPath:
              requestedBinaryPath !== undefined
                ? resolveCursorBinaryPath(requestedBinaryPath)
                : (existing?.binaryPath ?? resolveCursorBinaryPath(undefined)),
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : existing?.cwd ? { cwd: existing.cwd } : {}),
            ...(input.model
              ? { model: input.model }
              : existing?.model
                ? { model: existing.model }
                : {}),
            ...(normalizedResumeCursor
              ? { resumeCursor: normalizedResumeCursor }
              : existing?.resumeCursor
                ? { resumeCursor: existing.resumeCursor }
                : {}),
            updatedAt,
            ...(existing?.lastError ? { lastError: existing.lastError } : {}),
          };
          sessions.set(input.threadId, next);
        emit({
          ...baseEvent(input.threadId),
          type: "session.started",
          payload: {
            ...(next.resumeCursor
              ? { resume: { sessionId: next.resumeCursor } }
              : undefined),
          },
        });
          emit({
            ...baseEvent(input.threadId),
            type: "session.state.changed",
            payload: {
              state: "ready",
            },
          });
          return toProviderSession(next);
        },
        catch: (cause) =>
          Schema.is(ProviderAdapterValidationError)(cause) ||
          Schema.is(ProviderAdapterSessionNotFoundError)(cause)
            ? cause
            : new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to start Cursor session."),
                cause,
              }),
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.try({
        try: (): ProviderTurnStartResult => {
          if ((input.attachments?.length ?? 0) > 0) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Cursor CLI image attachments are not supported yet.",
            });
          }

          const session = requireSession(input.threadId);
          if (session.activeTurn) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Thread '${input.threadId}' already has a running Cursor turn.`,
            });
          }

          const prompt = buildCursorPrompt(input.input ?? "", input.interactionMode);
          const model = input.model ?? session.model;
          const turnId = TurnId.makeUnsafe(`cursor-turn:${crypto.randomUUID()}`);
          const child = spawnProcess(
            session.binaryPath,
            buildCursorArgs({
              prompt,
              runtimeMode: session.runtimeMode,
              ...(model ? { model } : {}),
              ...(session.resumeCursor ? { resumeCursor: session.resumeCursor } : {}),
            }),
            {
              cwd: session.cwd,
              env: process.env,
              shell: process.platform === "win32",
              stdio: ["ignore", "pipe", "pipe"],
            },
          );

          const stderrLines: string[] = [];
          const activeTurn: ActiveTurnState = {
            child,
            turnId,
            interactionMode: input.interactionMode,
            interrupted: false,
            assistantText: "",
            assistantTextEmitted: false,
            inFlightToolItemIds: new Set<string>(),
          };

          session.status = "running";
          session.updatedAt = nowIso();
          session.lastError = undefined;
          session.activeTurn = activeTurn;
          if (model) {
            session.model = model;
          }
          sessions.set(input.threadId, session);

          emit({
            ...baseEvent(input.threadId, turnId),
            type: "turn.started",
            payload: {
              ...(model ? { model } : undefined),
            },
          });

          const handleJsonLine = (line: string) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              return;
            }

            const record = asRecord(parsed);
            if (!record) {
              return;
            }

            const sessionId = extractCursorSessionId(record);
            if (sessionId) {
              session.resumeCursor = sessionId;
              session.updatedAt = nowIso();
            }

            const type = asTrimmedString(record.type);
            const subtype = asTrimmedString(record.subtype);

            if (type === "assistant") {
              const delta = extractText(record.message) ?? extractText(record.content) ?? extractText(record.text);
              if (!delta) {
                return;
              }
              activeTurn.assistantText += delta;
              if (activeTurn.interactionMode !== "plan") {
                activeTurn.assistantTextEmitted = true;
                emit({
                  ...baseEvent(input.threadId, turnId),
                  type: "content.delta",
                  payload: {
                    streamKind: "assistant_text",
                    delta,
                  },
                });
              }
              return;
            }

            if (type === "tool_call") {
              const itemId = toolItemId(record, turnId);
              const name =
                asTrimmedString(asRecord(record.toolCall)?.name) ??
                asTrimmedString(asRecord(record.tool_call)?.name) ??
                asTrimmedString(record.name);
              const itemType = toolItemType(name);
              const detail = toolDetail(record);
              if (subtype === "completed" || subtype === "failed" || subtype === "error") {
                activeTurn.inFlightToolItemIds.delete(itemId);
                emit({
                  ...baseEvent(input.threadId, turnId),
                  itemId: RuntimeItemId.makeUnsafe(itemId),
                  type: "item.completed",
                  payload: {
                    itemType,
                    status: subtype === "completed" ? "completed" : "failed",
                    ...(name ? { title: name } : {}),
                    ...(detail ? { detail } : {}),
                    data: record,
                  },
                });
                return;
              }

              activeTurn.inFlightToolItemIds.add(itemId);
              emit({
                ...baseEvent(input.threadId, turnId),
                itemId: RuntimeItemId.makeUnsafe(itemId),
                type: "item.started",
                payload: {
                  itemType,
                  status: "inProgress",
                  ...(name ? { title: name } : {}),
                  ...(detail ? { detail } : {}),
                  data: record,
                },
              });
              return;
            }

            if (type === "result") {
              const finalText =
                extractText(record.result) ?? extractText(record.message) ?? extractText(record.output);
              if (finalText) {
                activeTurn.finalText = finalText;
              }
            }
          };

          attachLineReader(child.stdout, handleJsonLine);
          attachLineReader(child.stderr, (line) => {
            stderrLines.push(line);
          });

          child.once("error", (cause) => {
            const current = sessions.get(input.threadId);
            if (!current || current.activeTurn?.turnId !== turnId) {
              return;
            }
            current.activeTurn = undefined;
            current.status = "error";
            current.updatedAt = nowIso();
            current.lastError = toMessage(cause, "Cursor CLI failed to start.");
            sessions.set(input.threadId, current);
            emit({
              ...baseEvent(input.threadId, turnId),
              type: "runtime.error",
              payload: {
                message: current.lastError,
                class: "transport_error",
              },
            });
            emit({
              ...baseEvent(input.threadId, turnId),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: current.lastError,
              },
            });
          });

          child.once("close", (code, signal) => {
            const current = sessions.get(input.threadId);
            if (!current || current.activeTurn?.turnId !== turnId) {
              return;
            }

            for (const itemId of current.activeTurn.inFlightToolItemIds) {
              emit({
                ...baseEvent(input.threadId, turnId),
                itemId: RuntimeItemId.makeUnsafe(itemId),
                type: "item.completed",
                payload: {
                  itemType: "dynamic_tool_call",
                  status: current.activeTurn.interrupted ? "declined" : "failed",
                },
              });
            }

            const completionText =
              current.activeTurn.finalText ?? current.activeTurn.assistantText;
            const failureMessage = stderrLines.join("\n").trim();
            current.activeTurn = undefined;
            current.updatedAt = nowIso();

            if (current.status === "error") {
              sessions.set(input.threadId, current);
              return;
            }

            if (code === 0 && !current.lastError) {
              current.status = "ready";
              current.lastError = undefined;
              sessions.set(input.threadId, current);
              if (completionText) {
                if (input.interactionMode === "plan") {
                  emit({
                    ...baseEvent(input.threadId, turnId),
                    type: "turn.proposed.completed",
                    payload: {
                      planMarkdown: completionText,
                    },
                  });
                } else if (!activeTurn.assistantTextEmitted) {
                  emit({
                    ...baseEvent(input.threadId, turnId),
                    itemId: RuntimeItemId.makeUnsafe(`cursor-assistant:${turnId}`),
                    type: "item.completed",
                    payload: {
                      itemType: "assistant_message",
                      status: "completed",
                      detail: completionText,
                    },
                  });
                }
              }
              emit({
                ...baseEvent(input.threadId, turnId),
                type: "turn.completed",
                payload: {
                  state: activeTurn.interrupted ? "interrupted" : "completed",
                  ...(activeTurn.interrupted ? { stopReason: "interrupted" } : {}),
                },
              });
              return;
            }

            const message =
              failureMessage.length > 0
                ? failureMessage
                : `Cursor CLI exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`;
            current.status = activeTurn.interrupted ? "ready" : "error";
            current.lastError = activeTurn.interrupted ? undefined : message;
            sessions.set(input.threadId, current);
            if (!activeTurn.interrupted) {
              emit({
                ...baseEvent(input.threadId, turnId),
                type: "runtime.error",
                payload: {
                  message,
                  class: "provider_error",
                },
              });
            }
            emit({
              ...baseEvent(input.threadId, turnId),
              type: "turn.completed",
              payload: {
                state: activeTurn.interrupted ? "interrupted" : "failed",
                ...(activeTurn.interrupted
                  ? { stopReason: "interrupted" }
                  : { errorMessage: message }),
              },
            });
          });

          return {
            threadId: input.threadId,
            turnId,
            ...(session.resumeCursor ? { resumeCursor: session.resumeCursor } : {}),
          };
        },
        catch: (cause) =>
          Schema.is(ProviderAdapterValidationError)(cause) ||
          Schema.is(ProviderAdapterSessionNotFoundError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/start",
                detail: toMessage(cause, "Failed to start Cursor turn."),
                cause,
              }),
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.try({
        try: () => {
          const session = requireSession(threadId);
          if (!session.activeTurn) {
            return;
          }
          session.activeTurn.interrupted = true;
          killChild(session.activeTurn.child);
        },
        catch: (cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/interrupt",
                detail: toMessage(cause, "Failed to interrupt Cursor turn."),
                cause,
              }),
      });

    const unsupported = (operation: string, issue: string) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue,
        }),
      );

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      _threadId,
      _requestId,
      _decision,
    ) =>
      unsupported(
        "respondToRequest",
        "Cursor CLI does not expose interactive approval requests in this adapter.",
      );

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) =>
      unsupported(
        "respondToUserInput",
        "Cursor CLI does not expose structured user-input requests in this adapter.",
      );

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        const session = sessions.get(threadId);
        if (!session) {
          return;
        }
        if (session.activeTurn) {
          session.activeTurn.interrupted = true;
          killChild(session.activeTurn.child);
        }
        sessions.delete(threadId);
        emit({
          ...baseEvent(threadId),
          type: "session.exited",
          payload: {
            reason: "Session stopped",
            exitKind: "graceful",
          },
        });
      });

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (session) => toProviderSession(session)));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: CursorAdapterShape["readThread"] = (_threadId) =>
      unsupported("readThread", "Cursor CLI thread history reading is not implemented.");

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (_threadId, _numTurns) =>
      unsupported("rollbackThread", "Cursor CLI thread rollback is not implemented.");

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        for (const [threadId, session] of sessions) {
          if (session.activeTurn) {
            session.activeTurn.interrupted = true;
            killChild(session.activeTurn.child);
          }
          emit({
            ...baseEvent(threadId),
            type: "session.exited",
            payload: {
              reason: "All sessions stopped",
              exitKind: "graceful",
            },
          });
        }
        sessions.clear();
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CursorAdapterShape;
  });

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapter());

export function makeCursorAdapterLive(options?: CursorAdapterLiveOptions) {
  return Layer.effect(CursorAdapter, makeCursorAdapter(options));
}
