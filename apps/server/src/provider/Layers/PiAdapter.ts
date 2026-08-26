import {
  type PiSettings,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type CanonicalItemType,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Semaphore from "effect/Semaphore";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import type { ChildProcess as NodeChildProcess } from "node:child_process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_RAW_SOURCE = "acp.pi.extension" as const;

interface PiRpcCommand {
  readonly id?: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.CloseableScope;
  child: NodeChildProcess | undefined;
  activeTurnId: TurnId | undefined;
  pendingCommands: Map<
    string,
    Deferred.Deferred<{ success: boolean; data?: unknown; error?: string }, ProviderAdapterRequestError>
  >;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCanonicalItemType(toolName: string): CanonicalItemType {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "command_execution" || name.includes("command")) return "command_execution";
  if (name === "read" || name === "edit" || name === "write" || name === "file_change" || name.includes("file")) return "file_change";
  if (name === "mcp_tool_call" || name.startsWith("mcp_")) return "mcp_tool_call";
  if (name === "web_search") return "web_search";
  return "dynamic_tool_call";
}

function asRuntimeRequestId(value: string): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

function piLaunchArgs(launchArgs?: string): ReadonlyArray<string> {
  return tokenizeCliArgs(launchArgs?.trim() ?? "");
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((sem) => {
            const next = new Map(current);
            next.set(threadId, sem);
            return [sem, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (sem) => sem.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
      }
      return Effect.succeed(ctx);
    };

    const markSessionReady = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const { activeTurnId: _a, ...ready } = ctx.session as unknown as Record<string, unknown>;
        ctx.session = { ...(ready as unknown as ProviderSession), status: "ready", updatedAt } as ProviderSession;
        ctx.activeTurnId = undefined;
      });

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.child) {
          try {
            ctx.child.kill();
          } catch {}
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Effect.void as any));
        sessions.delete(ctx.threadId);
        for (const deferred of ctx.pendingCommands.values()) {
          yield* Deferred.fail(
            deferred,
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session",
              detail: "Session stopped",
            }),
          ).pipe(Effect.ignore);
        }
        ctx.pendingCommands.clear();
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const writeRpcCommand = (
      ctx: PiSessionContext,
      command: PiRpcCommand,
    ): Effect.Effect<{ success: boolean; data?: unknown; error?: string }, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        if (!ctx.child || !ctx.child.stdin || ctx.stopped) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: command.type,
            detail: "Pi session is not running.",
          });
        }
        const id = (command.id ?? (yield* randomUUIDv4)) as string;
        const payload = { ...command, id };
        const deferred = yield* Deferred.make<
          { success: boolean; data?: unknown; error?: string },
          ProviderAdapterRequestError
        >();
        ctx.pendingCommands.set(id, deferred);
        const line = JSON.stringify(payload) + "\n";
        const stdin = ctx.child.stdin as NodeJS.WritableStream;
        yield* Effect.async<void, ProviderAdapterRequestError>((resume) => {
          stdin.write(line, (err: unknown) => {
            if (err) {
              resume(
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: command.type,
                    detail: "Failed to write to Pi RPC stdin.",
                    cause: err,
                  }),
                ),
              );
            } else {
              resume(Effect.void);
            }
          });
        });
        const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(30_000));
        if (result._tag === "None") {
          ctx.pendingCommands.delete(id);
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: command.type,
            detail: "Timed out waiting for Pi RPC response.",
          });
        }
        return result.value;
      });

    const handlePiEvent = (ctx: PiSessionContext, raw: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!isRecord(raw)) return;
        const type = typeof raw.type === "string" ? raw.type : "";

        if (type === "response") {
          const id = typeof raw.id === "string" ? raw.id : undefined;
          if (id && ctx.pendingCommands.has(id)) {
            const deferred = ctx.pendingCommands.get(id)!;
            ctx.pendingCommands.delete(id);
            const success = raw.success === true;
            yield* Deferred.succeed(deferred, {
              success,
              data: (raw as Record<string, unknown>).data,
              error:
                typeof (raw as Record<string, unknown>).error === "string"
                  ? ((raw as Record<string, unknown>).error as string)
                  : undefined,
            }).pipe(Effect.ignore);
          }
          return;
        }

        const turnId = ctx.activeTurnId;
        const stamp = yield* makeEventStamp();

        switch (type) {
          case "message_update": {
            const delta = (raw as Record<string, unknown>).assistantMessageEvent as
              | Record<string, unknown>
              | undefined;
            if (delta && turnId) {
              const deltaType = delta.type as string;
              if (deltaType === "text_delta" && typeof delta.delta === "string") {
                yield* offerRuntimeEvent({
                  type: "content.delta",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  payload: { kind: "assistant_text", delta: delta.delta as string },
                  raw: { source: PI_RAW_SOURCE, payload: raw },
                });
              } else if (deltaType === "thinking_delta" && typeof delta.delta === "string") {
                yield* offerRuntimeEvent({
                  type: "content.delta",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  payload: { kind: "reasoning_text", delta: delta.delta as string },
                  raw: { source: PI_RAW_SOURCE, payload: raw },
                });
              } else if (deltaType === "toolcall_start") {
                const toolName = typeof delta.toolName === "string" ? (delta.toolName as string) : "tool";
                yield* offerRuntimeEvent({
                  type: "item.started",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  payload: { kind: toCanonicalItemType(toolName), status: "inProgress" },
                  raw: { source: PI_RAW_SOURCE, payload: raw },
                });
              }
            }
            break;
          }
          case "message_end": {
            if (turnId) {
              yield* offerRuntimeEvent({
                type: "item.completed",
                ...stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: { kind: "assistant_message", status: "completed" },
                raw: { source: PI_RAW_SOURCE, payload: raw },
              });
            }
            break;
          }
          case "tool_execution_start": {
            if (turnId) {
              yield* offerRuntimeEvent({
                type: "tool.progress",
                ...stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: {
                  tool: ((raw as Record<string, unknown>).toolName as string) ?? "bash",
                  status: "running",
                  message: `Running ${((raw as Record<string, unknown>).toolName as string) ?? "tool"}`,
                },
                raw: { source: PI_RAW_SOURCE, payload: raw },
              });
            }
            break;
          }
          case "tool_execution_end": {
            if (turnId) {
              yield* offerRuntimeEvent({
                type: "tool.progress",
                ...stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: {
                  tool: ((raw as Record<string, unknown>).toolName as string) ?? "bash",
                  status: (raw as Record<string, unknown>).isError ? "failed" : "completed",
                },
                raw: { source: PI_RAW_SOURCE, payload: raw },
              });
            }
            break;
          }
          case "extension_ui_request": {
            const requestId =
              typeof (raw as Record<string, unknown>).id === "string"
                ? ((raw as Record<string, unknown>).id as string)
                : yield* randomUUIDv4;
            const title =
              typeof (raw as Record<string, unknown>).title === "string"
                ? ((raw as Record<string, unknown>).title as string)
                : typeof (raw as Record<string, unknown>).method === "string"
                  ? ((raw as Record<string, unknown>).method as string)
                  : "Pi request";
            const optionsRaw = (raw as Record<string, unknown>).options as unknown;
            const options = Array.isArray(optionsRaw)
              ? (optionsRaw as Array<string>).map((o) => ({ id: String(o), label: String(o) }))
              : [];
            yield* offerRuntimeEvent({
              type: "request.opened",
              ...stamp,
              provider: PROVIDER,
              threadId: ctx.threadId,
              ...(turnId ? { turnId } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { kind: "tool_user_input" as never, prompt: title, options },
              raw: { source: PI_RAW_SOURCE, payload: raw },
            });
            break;
          }
          default:
            break;
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Failed to handle Pi event", { cause })));

    const startSession: ProviderAdapterShape<never>["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const scope = yield* Scope.make();
          let scopeTransferred = false;
          yield* Effect.addFinalizer(() => (scopeTransferred ? Effect.void : Scope.close(scope, Effect.void as never)));

          const launchArgs = piLaunchArgs(piSettings.launchArgs);
          const binaryPath = piSettings.binaryPath || "pi";
          const args = ["--mode", "rpc", ...launchArgs];
          const env = { ...process.env, ...(options?.environment ?? {}) } as NodeJS.ProcessEnv;

          const nodeChild: NodeChildProcess = yield* Effect.tryPromise({
            try: async () => {
              const { spawn } = await import("node:child_process");
              return spawn(binaryPath, args, {
                cwd: input.cwd,
                env,
                stdio: ["pipe", "pipe", "pipe"],
              });
            },
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `Failed to spawn Pi: ${String(cause)}`,
                cause,
              }),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: input.cwd,
            threadId: input.threadId,
            resumeCursor: null,
            createdAt: now,
            updatedAt: now,
          };

          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session,
            scope,
            child: nodeChild,
            activeTurnId: undefined,
            pendingCommands: new Map(),
            stopped: false,
          };

          const stderr = nodeChild.stderr as NodeJS.ReadableStream | null | undefined;
          if (stderr) {
            stderr.on("data", (chunk: Buffer) => {
              Effect.runSync(
                Effect.logWarning("Pi stderr", {
                  threadId: input.threadId,
                  chunk: chunk.toString().slice(0, 500),
                }),
              );
            });
          }

          const stdout = nodeChild.stdout as NodeJS.ReadableStream | null | undefined;
          if (stdout) {
            const stdoutEffect = Effect.promise(async () => {
              let buffer = "";
              for await (const chunk of stdout as unknown as AsyncIterable<Buffer | string>) {
                const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8");
                buffer += text;
                let nl: number;
                while ((nl = buffer.indexOf("\n")) !== -1) {
                  let line = buffer.slice(0, nl);
                  buffer = buffer.slice(nl + 1);
                  if (line.endsWith("\r")) line = line.slice(0, -1);
                  if (!line.trim()) continue;
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(line);
                  } catch {
                    await Effect.runPromise(Effect.logWarning("Pi RPC parse error", { line: line.slice(0, 500) }));
                    continue;
                  }
                  await Effect.runPromise(handlePiEvent(ctx, parsed));
                }
              }
            }).pipe(Effect.catchCause((cause) => Effect.logWarning("Pi stdout loop failed", { cause })));
            yield* stdoutEffect.pipe(Effect.forkIn(scope));
          }

          yield* Effect.async<void, never>((resume) => {
            const onExit = (code: number | null, signal: string | null) => {
              ctx.stopped = true;
              sessions.delete(ctx.threadId);
              for (const deferred of ctx.pendingCommands.values()) {
                Effect.runSync(
                  Deferred.fail(
                    deferred,
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session",
                      detail: `Pi process exited with code ${code} signal ${signal}`,
                    }),
                  ).pipe(Effect.ignore),
                );
              }
              ctx.pendingCommands.clear();
              Effect.runPromise(
                Effect.gen(function* () {
                  yield* offerRuntimeEvent({
                    type: "session.exited",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    payload: {
                      exitKind: code === 0 ? "graceful" : "error",
                      reason: `exit code ${code} signal ${signal}`,
                    },
                  });
                }),
              ).finally(() => resume(Effect.void));
            };
            nodeChild.on("exit", onExit);
            nodeChild.on("error", () => resume(Effect.void));
          }).pipe(Effect.forkIn(scope));

          sessions.set(input.threadId, ctx);
          scopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {},
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Pi RPC session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: input.threadId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ProviderAdapterShape<never>["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const text = input.input?.trim() ?? "";
          const turnId = TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
          for (const attachment of input.attachments ?? []) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }

          if (!text && images.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {},
          });

          const promptPayload: PiRpcCommand = {
            type: "prompt",
            message: text || "(attached files)",
            ...(images.length > 0 ? { images } : {}),
          };

          const rpcResult = yield* writeRpcCommand(ctx, promptPayload).pipe(
            Effect.catchAll((cause) =>
              Effect.gen(function* () {
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: { state: "failed", errorMessage: cause.message ?? String(cause) },
                });
                yield* markSessionReady(ctx);
                return yield* Effect.fail(cause);
              }),
            ),
          );

          if (!rpcResult.success) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { state: "failed", errorMessage: rpcResult.error ?? "Pi prompt rejected" },
            });
            yield* markSessionReady(ctx);
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: rpcResult.error ?? "Pi prompt rejected",
            });
          }

          yield* Effect.forkScoped(
            Effect.gen(function* () {
              const ownedTurnId = turnId;
              for (let attempt = 0; attempt < 600; attempt++) {
                yield* Effect.sleep(1000);
                if (ctx.stopped) break;
                if (ctx.activeTurnId !== ownedTurnId) break;
                const stateRes = yield* writeRpcCommand(ctx, { type: "get_state" }).pipe(
                  Effect.orElseSucceed(() => ({ success: false as const })),
                );
                if (!stateRes.success) continue;
                const data = (stateRes.data ?? {}) as Record<string, unknown>;
                if (data.isStreaming === false) {
                  if (ctx.activeTurnId !== ownedTurnId) break;
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ownedTurnId,
                    payload: { state: "completed", stopReason: "stop" },
                  });
                  if (ctx.activeTurnId === ownedTurnId) {
                    yield* markSessionReady(ctx);
                  }
                  break;
                }
              }
            }),
          ).pipe(Effect.ignore);

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );

    const interruptTurn: ProviderAdapterShape<never>["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) return;
        // Cancel poller by clearing activeTurnId first so polling loop exits
        const targetTurnId = turnId ?? ctx.activeTurnId;
        ctx.activeTurnId = undefined;
        yield* writeRpcCommand(ctx, { type: "abort" }).pipe(Effect.ignore);
        if (targetTurnId) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: targetTurnId,
            payload: { state: "cancelled", stopReason: "cancelled" },
          });
        }
        yield* markSessionReady(ctx);
      });

    const respondToRequest: ProviderAdapterShape<never>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const response: PiRpcCommand =
          decision === "cancel"
            ? { type: "extension_ui_response", id: requestId as string, cancelled: true }
            : {
                type: "extension_ui_response",
                id: requestId as string,
                value: decision === "accept" || decision === "acceptForSession" ? "Allow" : "Block",
              };
        yield* writeRpcCommand(ctx, response);
        yield* offerRuntimeEvent({
          type: "request.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          requestId: asRuntimeRequestId(requestId as string),
          payload: { decision } as never,
        });
      });

    const respondToUserInput: ProviderAdapterShape<never>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const firstAnswer = Object.values(answers)[0] ?? "";
        yield* writeRpcCommand(ctx, {
          type: "extension_ui_response",
          id: requestId as string,
          value: String(firstAnswer),
        });
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          requestId: asRuntimeRequestId(requestId as string),
          payload: { answers },
        });
      });

    const stopSession: ProviderAdapterShape<never>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: ProviderAdapterShape<never>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map((c) => c.session));

    const hasSession: ProviderAdapterShape<never>["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped);

    const readThread: ProviderAdapterShape<never>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const res = yield* writeRpcCommand(ctx, { type: "get_messages" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "readThread",
                detail: cause.message,
                cause,
              }),
          ),
        );
        const messages = ((res.data ?? {}) as Record<string, unknown>).messages as unknown[] | undefined;
        return {
          threadId,
          turns: [
            {
              id: ctx.activeTurnId ?? TurnId.make("turn-pi-read"),
              items: messages ?? [],
            },
          ],
        };
      });

    const rollbackThread: ProviderAdapterShape<never>["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const result = yield* writeRpcCommand(ctx, {
          type: "rollback",
          numTurns,
        }).pipe(Effect.either);
        if (result._tag === "Right" && result.right.success) {
          return yield* readThread(threadId);
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Pi does not support rollback; use checkpoint restore instead",
        });
      });

    const stopAll: ProviderAdapterShape<never>["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
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
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<never>;
  });
}
