/**
 * PiAgentSessionRuntime — one `pi --mode rpc` child process plus the pi
 * JSONL-over-stdio protocol.
 *
 * The runtime owns the process and translates raw pi records into the
 * provider-neutral `ProviderEvent` records the adapter consumes. RPC
 * commands that carry a correlation `id` (we attach one to every command)
 * are awaited by `Deferred` and resolved when pi answers with a matching
 * `response` record.
 *
 * Framing: pi writes one JSON record per line. Records are split on `\n`
 * only and a single trailing `\r` is stripped. Node's `readline` is NOT
 * compliant here because it also splits on U+2028/U+2029, which are legal
 * inside JSON string values, so we use a StringDecoder-based splitter
 * (see `makePiRecordSplitter` below).
 *
 * @module provider/Layers/PiAgentSessionRuntime
 */
import { StringDecoder } from "node:string_decoder";

import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  type ProviderEvent,
  type ProviderInstanceId,
  type ProviderSession,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../../pathExpansion.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");

/** Versioned resume cursor shared with the adapter (`{schemaVersion: 1, sessionId}`). */
export const PI_RESUME_SCHEMA_VERSION = 1 as const;

/** How long to wait for a pi RPC response before failing the operation. */
const PI_RPC_TIMEOUT = "30 seconds" as const;
/** Startup RPCs (get_state, set_model, …) can be slower on first launch. */
const PI_START_RPC_TIMEOUT = "45 seconds" as const;

export class PiSessionRuntimeError extends Schema.TaggedErrorClass<PiSessionRuntimeError>()(
  "PiSessionRuntimeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi session runtime failed in ${this.operation}: ${this.detail}`;
  }
}

export interface PiAgentSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  /** `PI_CODING_AGENT_DIR` override — pi's home/session dir. */
  readonly homePath?: string;
  /** Extra CLI args appended to `pi --mode rpc …` (from settings.launchArgs). */
  readonly launchArgs?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  /** Model pattern passed to `--model` at spawn (T3 slug or bare id). */
  readonly model?: string;
  /** Thinking level passed to `--thinking` at spawn. */
  readonly thinkingLevel?: string;
  /** Resume a previous pi session (from the versioned resume cursor). */
  readonly resumeSessionId?: string;
  readonly clientName: string;
}

export interface PiAvailableModel {
  readonly id: string;
  readonly name: string | undefined;
  readonly provider: string | undefined;
  readonly api: string | undefined;
}

export interface PiSessionStats {
  readonly tokens: unknown;
  readonly cost: unknown;
  readonly contextUsage: unknown;
}

export interface PiSessionRuntimeShape {
  /** Spawn pi, query session state, apply model/thinking, emit session/ready. */
  readonly start: () => Effect.Effect<ProviderSession, PiSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendPrompt: (input: {
    readonly message?: string;
    readonly images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
    readonly streamingBehavior: "steer" | "followUp";
  }) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly abort: () => Effect.Effect<void, PiSessionRuntimeError>;
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly setThinkingLevel: (level: string) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly getAvailableModels: () => Effect.Effect<
    ReadonlyArray<PiAvailableModel>,
    PiSessionRuntimeError
  >;
  readonly getSessionStats: () => Effect.Effect<PiSessionStats, PiSessionRuntimeError>;
  readonly readMessages: () => Effect.Effect<ReadonlyArray<unknown>, PiSessionRuntimeError>;
  readonly respondToExtensionUi: (input: {
    readonly requestId: string;
    readonly value?: unknown;
    readonly confirmed?: boolean;
    readonly cancelled?: boolean;
  }) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

interface PiRpcResponse {
  readonly command: string;
  readonly success: boolean;
  readonly data: unknown;
  readonly error: unknown;
}

interface PendingRpc {
  readonly command: string;
  readonly deferred: Deferred.Deferred<PiRpcResponse, PiSessionRuntimeError>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPiResponseRecord(value: unknown): value is Record<string, unknown> & {
  readonly type: "response";
  readonly command: string;
} {
  return isRecord(value) && value.type === "response" && typeof value.command === "string";
}

/**
 * Record framing for pi's JSONL protocol. Splits on `\n` only and strips a
 * single trailing `\r`; `StringDecoder` handles UTF-8 multi-byte sequences
 * that span chunk boundaries.
 */
export function makePiRecordSplitter(): {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<string>;
  readonly flush: () => ReadonlyArray<string>;
} {
  const decoder = new StringDecoder("utf8");
  let remainder = "";
  const flushRecords = (): ReadonlyArray<string> => {
    if (!remainder.includes("\n")) {
      return [];
    }
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  };
  return {
    push: (chunk) => {
      remainder += decoder.write(chunk);
      return flushRecords();
    },
    flush: () => {
      remainder += decoder.end();
      return flushRecords();
    },
  };
}

export function parsePiResumeCursor(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== PI_RESUME_SCHEMA_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export const makePiAgentSessionRuntime = Effect.fn("makePiAgentSessionRuntime")(function* (
  options: PiAgentSessionRuntimeOptions,
): Effect.fn.Return<
  PiSessionRuntimeShape,
  PiSessionRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeScope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const events = yield* Queue.unbounded<ProviderEvent>();
  const pendingRpcRef = yield* Ref.make(new Map<string, PendingRpc>());
  const closedRef = yield* Ref.make(false);
  const stdinMutex = yield* Semaphore.make(1);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = (purpose: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new PiSessionRuntimeError({
            operation: "randomUUID",
            detail: `Failed to generate ${purpose}.`,
            cause,
          }),
      ),
    );

  const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
  const env = {
    ...options.environment,
    ...(resolvedHomePath ? { PI_CODING_AGENT_DIR: resolvedHomePath } : {}),
  };
  const spawnCommand = yield* resolveSpawnCommand(
    options.binaryPath,
    [
      "--mode",
      "rpc",
      "--name",
      options.clientName,
      ...(options.resumeSessionId ? ["--session", options.resumeSessionId] : []),
      ...(options.model ? ["--model", options.model] : []),
      ...(options.thinkingLevel ? ["--thinking", options.thinkingLevel] : []),
      ...tokenizeCliArgs(options.launchArgs),
    ],
    { env },
  );

  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        env,
        // endOnDone must stay false: each writeLine is a separate
        // Stream.run over the stdin sink, and ending on done would close
        // the pipe after the first command.
        stdin: { stream: "pipe", endOnDone: false },
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "2 seconds",
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
      Effect.mapError(
        (cause) =>
          new PiSessionRuntimeError({
            operation: "spawn",
            detail: `Failed to spawn '${options.binaryPath} --mode rpc': ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );

  const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

  const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
    Effect.gen(function* () {
      const id = yield* randomUUIDv4("provider-event");
      return yield* offerEvent({
        id: EventId.make(id),
        provider: PROVIDER,
        ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
        createdAt: yield* nowIso,
        ...event,
      });
    });

  const emitSessionEvent = (method: string, message: string) =>
    emitEvent({ kind: "session", threadId: options.threadId, method, message });

  /** Write one JSON record to the pi process stdin, serialized by a mutex. */
  const writeLine = (record: unknown) =>
    stdinMutex.withPermits(1)(
      Effect.gen(function* () {
        const encoded = `${JSON.stringify(record)}\n`;
        yield* Stream.run(Stream.encodeText(Stream.make(encoded)), child.stdin).pipe(
          Effect.mapError(
            (cause) =>
              new PiSessionRuntimeError({
                operation: "write",
                detail: `Failed to write to pi process: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );
      }),
    );

  const failAllPendingRpcs = (detail: string) =>
    Ref.get(pendingRpcRef).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(
          Array.from(pending.values()),
          (entry) =>
            Deferred.fail(
              entry.deferred,
              new PiSessionRuntimeError({ operation: entry.command, detail }),
            ).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
      Effect.andThen(Ref.set(pendingRpcRef, new Map())),
    );

  const sendCommand = Effect.fn("sendCommand")(function* (
    command: string,
    payload: Record<string, unknown> = {},
    options?: { readonly timeout?: Duration.Input },
  ) {
    const id = yield* randomUUIDv4(`rpc-id-${command}`);
    const deferred = yield* Deferred.make<PiRpcResponse, PiSessionRuntimeError>();
    yield* Ref.update(pendingRpcRef, (current) => {
      const next = new Map(current);
      next.set(id, { command, deferred });
      return next;
    });
    yield* writeLine({ type: command, id, ...payload });
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: options?.timeout ?? PI_RPC_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new PiSessionRuntimeError({
              operation: command,
              detail: `pi did not answer '${command}' within ${options?.timeout ?? PI_RPC_TIMEOUT}.`,
            }),
          ),
      }),
      Effect.ensuring(
        Ref.update(pendingRpcRef, (current) => {
          if (!current.has(id)) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
      ),
    );
  });

  const rpcSuccess = Effect.fn("rpcSuccess")(function* (
    command: string,
    payload: Record<string, unknown> = {},
    options?: { readonly timeout?: Duration.Input },
  ): Effect.fn.Return<unknown, PiSessionRuntimeError> {
    const response = yield* sendCommand(command, payload, options);
    if (response.success) {
      return response.data;
    }
    const errorDetail =
      isRecord(response.error) && typeof response.error.message === "string"
        ? response.error.message
        : typeof response.error === "string"
          ? response.error
          : undefined;
    return yield* new PiSessionRuntimeError({
      operation: command,
      detail: errorDetail
        ? `pi rejected '${command}': ${errorDetail}`
        : `pi rejected '${command}'.`,
    });
  });

  const handleRawRecord = (raw: unknown) =>
    Effect.gen(function* () {
      if (isPiResponseRecord(raw)) {
        const id = typeof raw.id === "string" ? raw.id : undefined;
        if (id === undefined) {
          yield* Effect.logDebug("pi response without correlation id", {
            command: raw.command,
          });
          return;
        }
        const pending = (yield* Ref.get(pendingRpcRef)).get(id);
        if (!pending) {
          yield* Effect.logDebug("pi response for unknown correlation id", {
            id,
            command: raw.command,
          });
          return;
        }
        yield* Ref.update(pendingRpcRef, (current) => {
          if (!current.has(id)) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        yield* Deferred.succeed(pending.deferred, {
          command: raw.command,
          success: raw.success === true,
          data: raw.data,
          error: raw.error,
        }).pipe(Effect.ignore);
        return;
      }

      if (!isRecord(raw)) {
        yield* Effect.logDebug("ignoring non-record pi output", { raw });
        return;
      }

      if (raw.type === "extension_ui_request" && typeof raw.id === "string") {
        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "extension_ui_request",
          requestId: ApprovalRequestId.make(raw.id),
          payload: raw,
        });
        return;
      }

      if (typeof raw.type === "string") {
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: raw.type,
          payload: raw,
        });
        return;
      }

      yield* Effect.logDebug("ignoring unrecognized pi output", { raw });
    });

  const recordSplitter = makePiRecordSplitter();
  yield* child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        for (const line of recordSplitter.push(chunk)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            yield* Effect.logWarning("pi stdout carried a non-JSON record", {
              threadId: options.threadId,
            });
            continue;
          }
          yield* handleRawRecord(parsed);
        }
      }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("pi stdout stream ended or failed.", {
        threadId: options.threadId,
        cause,
      }),
    ),
    Effect.forkIn(runtimeScope),
  );

  // Stderr is a diagnostics channel; surface each non-empty line as a
  // warning event so the adapter can render it without failing the turn.
  const stderrRemainderRef = yield* Ref.make("");
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.modify(stderrRemainderRef, (current) => {
        const combined = current + chunk;
        const lines = combined.split("\n");
        const remainder = lines.pop() ?? "";
        return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
      }).pipe(
        Effect.flatMap((lines) =>
          Effect.forEach(
            lines,
            (line) => {
              const trimmed = line.trim();
              if (!trimmed) {
                return Effect.void;
              }
              return emitEvent({
                kind: "notification",
                threadId: options.threadId,
                method: "process/stderr",
                message: trimmed,
              });
            },
            { discard: true },
          ),
        ),
      ),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("pi stderr stream ended or failed.", {
        threadId: options.threadId,
        cause,
      }),
    ),
    Effect.forkIn(runtimeScope),
  );

  const sessionCreatedAt = yield* nowIso;
  const initialSession: ProviderSession = {
    provider: PROVIDER,
    ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
    status: "connecting",
    runtimeMode: options.runtimeMode,
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    threadId: options.threadId,
    createdAt: sessionCreatedAt,
    updatedAt: sessionCreatedAt,
  };
  const sessionRef = yield* Ref.make<ProviderSession>(initialSession);

  yield* child.exitCode.pipe(
    Effect.flatMap((exitCode) =>
      Ref.get(closedRef).pipe(
        Effect.flatMap((closed) => {
          if (closed) {
            return Effect.void;
          }
          const message =
            exitCode === 0 ? "Pi process exited." : `Pi process exited with code ${exitCode}.`;
          return Ref.update(sessionRef, (session) => ({
            ...session,
            status: exitCode === 0 ? ("closed" as const) : ("error" as const),
            activeTurnId: undefined,
          })).pipe(
            Effect.andThen(failAllPendingRpcs(message)),
            Effect.andThen(
              emitSessionEvent("session/exited", message).pipe(
                Effect.catch((cause) =>
                  Effect.logError("Failed to emit pi session exited event.", { cause }),
                ),
              ),
            ),
          );
        }),
      ),
    ),
    Effect.forkIn(runtimeScope),
  );

  const readCurrentState = Effect.fn("readCurrentState")(function* () {
    const data = yield* rpcSuccess("get_state", {}, { timeout: PI_START_RPC_TIMEOUT });
    if (!isRecord(data)) {
      return yield* new PiSessionRuntimeError({
        operation: "get_state",
        detail: "pi get_state returned no data object.",
      });
    }
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
    if (!sessionId) {
      return yield* new PiSessionRuntimeError({
        operation: "get_state",
        detail: "pi get_state returned no sessionId.",
      });
    }
    return { sessionId };
  });

  const start = Effect.fn("PiSessionRuntime.start")(function* () {
    yield* emitSessionEvent("session/connecting", "Starting Pi session.");
    const state = yield* readCurrentState();

    const resumeCursor = {
      schemaVersion: PI_RESUME_SCHEMA_VERSION,
      sessionId: state.sessionId,
    };
    const updatedAt = yield* nowIso;
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      status: "ready" as const,
      resumeCursor,
      updatedAt,
    }));

    yield* emitSessionEvent("session/ready", "Pi session ready.");
    return yield* Ref.get(sessionRef);
  });

  const close = Effect.gen(function* () {
    const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
    if (alreadyClosed) {
      return;
    }
    yield* failAllPendingRpcs("Pi session closed.");
    const updatedAt = yield* nowIso;
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      status: "closed" as const,
      activeTurnId: undefined,
      updatedAt,
    }));
    yield* emitSessionEvent("session/exited", "Session stopped").pipe(
      Effect.catch((cause) =>
        Effect.logError("Failed to emit pi session exited event.", { cause }),
      ),
    );
    yield* Scope.close(runtimeScope, Exit.void);
    yield* Queue.shutdown(events);
  });

  return {
    start,
    getSession: Ref.get(sessionRef),
    sendPrompt: (input) =>
      Effect.gen(function* () {
        const payload: Record<string, unknown> = {
          message: input.message ?? "",
          streamingBehavior: input.streamingBehavior,
        };
        if (input.images && input.images.length > 0) {
          payload.images = input.images;
        }
        yield* rpcSuccess("prompt", payload);
      }),
    abort: () =>
      Effect.gen(function* () {
        yield* writeLine({ type: "abort" });
      }),
    setModel: (provider, modelId) =>
      Effect.gen(function* () {
        yield* rpcSuccess("set_model", { provider, modelId });
      }),
    setThinkingLevel: (level) =>
      Effect.gen(function* () {
        yield* rpcSuccess("set_thinking_level", { level });
      }),
    getAvailableModels: () =>
      Effect.gen(function* () {
        const data = yield* rpcSuccess("get_available_models");
        if (!isRecord(data) || !Array.isArray(data.models)) {
          return [] as ReadonlyArray<PiAvailableModel>;
        }
        return data.models
          .filter(isRecord)
          .map((model) => ({
            id: typeof model.id === "string" ? model.id : "",
            name: typeof model.name === "string" ? model.name : undefined,
            provider: typeof model.provider === "string" ? model.provider : undefined,
            api: typeof model.api === "string" ? model.api : undefined,
          }))
          .filter((model) => model.id.length > 0);
      }),
    getSessionStats: () =>
      Effect.gen(function* () {
        const data = yield* rpcSuccess("get_session_stats");
        return isRecord(data)
          ? { tokens: data.tokens, cost: data.cost, contextUsage: data.contextUsage }
          : { tokens: undefined, cost: undefined, contextUsage: undefined };
      }),
    readMessages: () =>
      Effect.gen(function* () {
        const data = yield* rpcSuccess("get_messages");
        return isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
      }),
    respondToExtensionUi: (input) =>
      Effect.gen(function* () {
        // Pi treats extension_ui_response as fire-and-forget (no ack), and
        // the payload's `id` is the extension request id, not a correlation
        // id — so write it directly instead of awaiting an RPC response.
        const payload: Record<string, unknown> = { id: input.requestId };
        if (input.value !== undefined) payload.value = input.value;
        if (input.confirmed !== undefined) payload.confirmed = input.confirmed;
        if (input.cancelled !== undefined) payload.cancelled = input.cancelled;
        yield* writeLine({ type: "extension_ui_response", ...payload });
      }),
    events: Stream.fromQueue(events),
    close,
  } satisfies PiSessionRuntimeShape;
});
