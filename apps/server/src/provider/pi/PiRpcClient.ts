import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  isPiRpcResponse,
  PiRpcAvailableModels,
  PiRpcCommands,
  type PiRpcEvent,
  PiRpcModel,
  type PiRpcRawEvent,
  type PiRpcResponse,
  PiRpcSessionStats,
  PiRpcState,
  type PiThinkingLevel,
} from "./PiRpcSchema.ts";

export class PiRpcProtocolError extends Schema.TaggedErrorClass<PiRpcProtocolError>()(
  "PiRpcProtocolError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class PiRpcRequestTimeoutError extends Schema.TaggedErrorClass<PiRpcRequestTimeoutError>()(
  "PiRpcRequestTimeoutError",
  { command: Schema.String, requestId: Schema.String, timeoutMs: Schema.Number },
) {}

export class PiRpcCommandError extends Schema.TaggedErrorClass<PiRpcCommandError>()(
  "PiRpcCommandError",
  { command: Schema.String, requestId: Schema.String, detail: Schema.String },
) {}

export class PiRpcProcessExitedError extends Schema.TaggedErrorClass<PiRpcProcessExitedError>()(
  "PiRpcProcessExitedError",
  {
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type PiRpcError =
  | PiRpcProtocolError
  | PiRpcRequestTimeoutError
  | PiRpcCommandError
  | PiRpcProcessExitedError;

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownEffect(UnknownFromJsonString);
const decodePiRpcState = Schema.decodeUnknownEffect(PiRpcState);
const decodePiRpcAvailableModels = Schema.decodeUnknownEffect(PiRpcAvailableModels);
const decodePiRpcCommands = Schema.decodeUnknownEffect(PiRpcCommands);
const decodePiRpcSessionStats = Schema.decodeUnknownEffect(PiRpcSessionStats);
const decodePiRpcModel = Schema.decodeUnknownEffect(PiRpcModel);

export interface PiRpcTransportIo {
  readonly stdout: Stream.Stream<Uint8Array, PiRpcProtocolError>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, PiRpcProtocolError>;
  readonly stderr?: Stream.Stream<Uint8Array, PiRpcProtocolError>;
}

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type PiExtensionUiResponse =
  | { readonly id: string; readonly value: string }
  | { readonly id: string; readonly confirmed: boolean }
  | { readonly id: string; readonly cancelled: true };

export interface PiRpcClient {
  readonly events: Stream.Stream<PiRpcEvent>;
  readonly getState: () => Effect.Effect<PiRpcState, PiRpcError>;
  readonly getAvailableModels: () => Effect.Effect<PiRpcAvailableModels, PiRpcError>;
  readonly getCommands: () => Effect.Effect<PiRpcCommands, PiRpcError>;
  readonly getSessionStats: () => Effect.Effect<PiRpcSessionStats, PiRpcError>;
  readonly setModel: (provider: string, modelId: string) => Effect.Effect<PiRpcModel, PiRpcError>;
  readonly setThinkingLevel: (level: PiThinkingLevel) => Effect.Effect<void, PiRpcError>;
  readonly prompt: (
    message: string,
    images?: ReadonlyArray<PiRpcImage>,
    streamingBehavior?: "steer" | "followUp",
  ) => Effect.Effect<void, PiRpcError>;
  readonly abort: () => Effect.Effect<void, PiRpcError>;
  readonly respondToExtensionUi: (
    response: PiExtensionUiResponse,
  ) => Effect.Effect<void, PiRpcError>;
  readonly close: () => Effect.Effect<void>;
}

export interface PiRpcTransportOptions {
  readonly requestTimeoutMs?: number;
  readonly maxLineLength?: number;
  readonly close?: Effect.Effect<void>;
}

const encoder = new TextEncoder();

export const makePiRpcTransport = Effect.fn("PiRpcClient.makeTransport")(function* (
  io: PiRpcTransportIo,
  options: PiRpcTransportOptions = {},
): Effect.fn.Return<PiRpcClient, never, Scope.Scope> {
  const timeoutMs = options.requestTimeoutMs ?? 120_000;
  const maxLineLength = options.maxLineLength;
  const pending = yield* Ref.make(new Map<string, Deferred.Deferred<PiRpcResponse, PiRpcError>>());
  const nextId = yield* Ref.make(1);
  const events = yield* Queue.unbounded<PiRpcEvent>();
  const writeLock = yield* Semaphore.make(1);
  const closed = yield* Ref.make(false);
  const scope = yield* Scope.Scope;
  const decodeState = (data: unknown) =>
    decodePiRpcState(data).pipe(
      Effect.mapError(
        (cause) => new PiRpcProtocolError({ detail: "invalid get_state response data", cause }),
      ),
    );
  const decodeModels = (data: unknown) =>
    decodePiRpcAvailableModels(data).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcProtocolError({ detail: "invalid get_available_models response data", cause }),
      ),
    );
  const decodeCommands = (data: unknown) =>
    decodePiRpcCommands(data).pipe(
      Effect.mapError(
        (cause) => new PiRpcProtocolError({ detail: "invalid get_commands response data", cause }),
      ),
    );
  const decodeSessionStats = (data: unknown) =>
    decodePiRpcSessionStats(data).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcProtocolError({ detail: "invalid get_session_stats response data", cause }),
      ),
    );
  const decodeModel = (data: unknown) =>
    decodePiRpcModel(data).pipe(
      Effect.mapError(
        (cause) => new PiRpcProtocolError({ detail: "invalid set_model response data", cause }),
      ),
    );

  const remove = (id: string) =>
    Ref.update(pending, (current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });

  const end = (error: PiRpcProcessExitedError) =>
    Ref.set(closed, true).pipe(
      Effect.andThen(
        Ref.modify(pending, (current) => [Array.from(current.values()), new Map()] as const),
      ),
      Effect.flatMap((waiters) =>
        Effect.forEach(waiters, (waiter) => Deferred.fail(waiter, error), { discard: true }),
      ),
      Effect.andThen(Queue.shutdown(events)),
    );

  const parseLine = (lineWithCr: string) => {
    const line = lineWithCr.endsWith("\r") ? lineWithCr.slice(0, -1) : lineWithCr;
    if (line.length === 0) return Effect.void;
    if (maxLineLength !== undefined && line.length > maxLineLength) {
      return Queue.offer(events, {
        _tag: "PiRpcProtocolFailureEvent",
        reason: "LineTooLong",
        detail: `Pi RPC line exceeded ${String(maxLineLength)} characters`,
      }).pipe(Effect.asVoid);
    }
    return decodeJson(line).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          // RPC messages are JSON objects. Extensions commonly prefix plain logs
          // with tags such as "[pi-cliproxyapi]", so only object-looking parse
          // failures are protocol errors. Successfully parsed arrays still fail
          // the object check below.
          line.trimStart().startsWith("{")
            ? Queue.offer(events, {
                _tag: "PiRpcProtocolFailureEvent",
                reason: "MalformedJson",
                line,
                detail: String(cause),
              }).pipe(Effect.asVoid)
            : Queue.offer(events, { _tag: "PiRpcOutputLineEvent", line }).pipe(Effect.asVoid),
        onSuccess: (message) => {
          if (isPiRpcResponse(message) && message.id !== undefined) {
            return Ref.modify(pending, (current) => {
              const waiter = current.get(message.id!);
              if (!waiter) return [Effect.void, current] as const;
              const next = new Map(current);
              next.delete(message.id!);
              return [Deferred.succeed(waiter, message), next] as const;
            }).pipe(Effect.flatten);
          }
          if (typeof message === "object" && message !== null && !Array.isArray(message)) {
            return Queue.offer(events, message as PiRpcRawEvent).pipe(Effect.asVoid);
          }
          return Queue.offer(events, {
            _tag: "PiRpcProtocolFailureEvent",
            reason: "MalformedJson",
            line,
            detail: "Pi RPC JSONL value was not an object",
          }).pipe(Effect.asVoid);
        },
      }),
    );
  };

  let remainder = "";
  let discardingOversizedLine = false;
  yield* io.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => {
      let input = remainder + chunk;
      remainder = "";
      if (discardingOversizedLine) {
        const newline = input.indexOf("\n");
        if (newline < 0) return Effect.void;
        discardingOversizedLine = false;
        input = input.slice(newline + 1);
      }
      const lines = input.split("\n");
      remainder = lines.pop() ?? "";
      const effects: Array<Effect.Effect<void>> = lines.map(parseLine);
      if (maxLineLength !== undefined && remainder.length > maxLineLength) {
        remainder = "";
        discardingOversizedLine = true;
        effects.push(
          Queue.offer(events, {
            _tag: "PiRpcProtocolFailureEvent",
            reason: "LineTooLong",
            detail: `Pi RPC remainder exceeded ${String(maxLineLength)} characters`,
          }).pipe(Effect.asVoid),
        );
      }
      return Effect.forEach(effects, (effect) => effect, { discard: true });
    }),
    Effect.matchEffect({
      onFailure: (cause) =>
        end(new PiRpcProcessExitedError({ detail: "Pi RPC stdout failed", cause })),
      onSuccess: () =>
        (remainder.length > 0 ? parseLine(remainder) : Effect.void).pipe(
          Effect.andThen(end(new PiRpcProcessExitedError({ detail: "Pi RPC stdout ended" }))),
        ),
    }),
    Effect.forkScoped,
  );
  if (io.stderr) yield* Stream.runDrain(io.stderr).pipe(Effect.ignore, Effect.forkScoped);

  const write = (value: unknown) =>
    writeLock.withPermits(1)(
      encodeJson(value).pipe(
        Effect.mapError(
          (cause) => new PiRpcProtocolError({ detail: "failed to encode Pi RPC command", cause }),
        ),
        Effect.flatMap((json) =>
          Stream.fromIterable([encoder.encode(`${json}\n`)]).pipe(Stream.run(io.stdin)),
        ),
      ),
    );

  const request = <A>(
    command: string,
    payload: object,
    decode: (data: unknown) => Effect.Effect<A, PiRpcError>,
  ) =>
    Effect.gen(function* () {
      if (yield* Ref.get(closed)) {
        return yield* new PiRpcProcessExitedError({ detail: "Pi RPC client is closed" });
      }
      const id = yield* Ref.getAndUpdate(nextId, (value) => value + 1).pipe(
        Effect.map((value) => `t3-pi-${String(value)}`),
      );
      const waiter = yield* Deferred.make<PiRpcResponse, PiRpcError>();
      yield* Ref.update(pending, (current) => new Map(current).set(id, waiter));
      if (yield* Ref.get(closed)) {
        yield* remove(id);
        return yield* new PiRpcProcessExitedError({ detail: "Pi RPC client is closed" });
      }
      yield* write({ ...payload, type: command, id }).pipe(Effect.onError(() => remove(id)));
      if (yield* Ref.get(closed)) {
        yield* remove(id);
        return yield* new PiRpcProcessExitedError({ detail: "Pi RPC client is closed" });
      }
      const response = yield* Effect.raceFirst(
        Deferred.await(waiter),
        Effect.sleep(Duration.millis(timeoutMs)).pipe(
          Effect.andThen(
            Effect.fail(new PiRpcRequestTimeoutError({ command, requestId: id, timeoutMs })),
          ),
        ),
      ).pipe(Effect.ensuring(remove(id)));
      if (!response.success) {
        return yield* new PiRpcCommandError({
          command,
          requestId: id,
          detail: response.error ?? "Pi RPC command failed",
        });
      }
      return yield* decode(response.data);
    });

  const close = Ref.getAndSet(closed, true).pipe(
    Effect.flatMap((wasClosed) =>
      wasClosed
        ? Effect.void
        : end(new PiRpcProcessExitedError({ detail: "Pi RPC client closed" })).pipe(
            Effect.andThen(options.close ?? Effect.void),
          ),
    ),
    Effect.ignore,
  );
  yield* Scope.addFinalizer(scope, close);

  return {
    events: Stream.fromQueue(events),
    getState: () => request("get_state", {}, decodeState),
    getAvailableModels: () => request("get_available_models", {}, decodeModels),
    getCommands: () => request("get_commands", {}, decodeCommands),
    getSessionStats: () => request("get_session_stats", {}, decodeSessionStats),
    setModel: (provider, modelId) => request("set_model", { provider, modelId }, decodeModel),
    setThinkingLevel: (level) => request("set_thinking_level", { level }, () => Effect.void),
    prompt: (message, images, streamingBehavior) =>
      request(
        "prompt",
        {
          message,
          ...(images && images.length > 0 ? { images } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
        },
        () => Effect.void,
      ),
    abort: () => request("abort", {}, () => Effect.void),
    respondToExtensionUi: (response) => write({ type: "extension_ui_response", ...response }),
    close: () => close,
  };
});

export interface PiRpcSpawnOptions extends PiRpcTransportOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const makePiRpcClient = Effect.fn("PiRpcClient.make")(function* (
  options: PiRpcSpawnOptions,
): Effect.fn.Return<
  PiRpcClient,
  PiRpcProtocolError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const child = yield* spawner
    .spawn(
      ChildProcess.make(options.command, ["--mode", "rpc", ...(options.args ?? [])], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) => new PiRpcProtocolError({ detail: "failed to spawn Pi RPC", cause }),
      ),
    );
  const gracefulThenForced = child.kill({ killSignal: "SIGTERM", forceKillAfter: "2 seconds" });
  const mapProcessError = (cause: unknown) =>
    new PiRpcProtocolError({ detail: "Pi RPC process transport failed", cause });
  const client = yield* makePiRpcTransport(
    {
      stdout: child.stdout.pipe(Stream.mapError(mapProcessError)),
      stdin: child.stdin.pipe(Sink.mapError(mapProcessError)),
      stderr: child.stderr.pipe(Stream.mapError(mapProcessError)),
    },
    { ...options, close: gracefulThenForced.pipe(Effect.ignore) },
  );
  yield* child.exitCode.pipe(
    Effect.flatMap((code) => client.close().pipe(Effect.as(code))),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  return client;
});
