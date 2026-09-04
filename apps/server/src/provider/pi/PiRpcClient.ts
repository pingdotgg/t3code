import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  encodePiRpcCommand,
  isPiRpcResponse,
  makePiJsonlDecoder,
  type PiRpcCommand,
  type PiRpcEnvelope,
  type PiRpcResponse,
} from "./PiRpcProtocol.ts";

export class PiRpcClientError extends Schema.TaggedErrorClass<PiRpcClientError>()(
  "PiRpcClientError",
  {
    operation: Schema.Literals(["spawn", "write", "protocol", "request", "process-exit", "closed"]),
    detail: Schema.String,
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC client ${this.operation} failed: ${this.detail}`;
  }
}
const isPiRpcClientError = Schema.is(PiRpcClientError);

export type PiRpcRequestCommand = Exclude<PiRpcCommand, { readonly type: "extension_ui_response" }>;

export interface PiRpcClient {
  readonly request: (
    command: PiRpcRequestCommand,
  ) => Effect.Effect<PiRpcResponse, PiRpcClientError>;
  readonly send: (command: PiRpcCommand) => Effect.Effect<void, PiRpcClientError>;
  readonly events: Stream.Stream<PiRpcEnvelope, PiRpcClientError>;
  readonly awaitFailure: Effect.Effect<never, PiRpcClientError>;
  readonly close: Effect.Effect<void>;
}

export interface PiRpcClientOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly maxLineBytes?: number;
  readonly maxStderrChunkChars?: number;
  readonly onStderr?: (chunk: string) => Effect.Effect<void>;
}

type PendingResponse = Deferred.Deferred<PiRpcResponse, PiRpcClientError>;

export const makePiRpcClient = Effect.fn("makePiRpcClient")(function* (
  options: PiRpcClientOptions,
): Effect.fn.Return<
  PiRpcClient,
  PiRpcClientError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, options.args, {
    ...(options.env ? { env: options.env } : {}),
    extendEnv: true,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}),
        extendEnv: true,
        shell: spawnCommand.shell,
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcClientError({
            operation: "spawn",
            detail: `Could not start ${options.binaryPath}.`,
            cause,
          }),
      ),
    );

  const eventQueue = yield* Queue.bounded<PiRpcEnvelope>(1_024);
  const failure = yield* Deferred.make<never, PiRpcClientError>();
  const failureRef = yield* Ref.make<Option.Option<PiRpcClientError>>(Option.none());
  const pendingRef = yield* Ref.make(new Map<string, PendingResponse>());
  const nextRequestIdRef = yield* Ref.make(1);
  const stoppingRef = yield* Ref.make(false);
  const writeLock = yield* Semaphore.make(1);
  const textEncoder = new TextEncoder();

  const failPending = Effect.fn("PiRpcClient.failPending")(function* (error: PiRpcClientError) {
    const pending = yield* Ref.getAndSet(pendingRef, new Map());
    yield* Effect.forEach(pending.values(), (deferred) => Deferred.fail(deferred, error), {
      discard: true,
    });
  });

  const recordFailure = Effect.fn("PiRpcClient.recordFailure")(function* (error: PiRpcClientError) {
    const isFirst = yield* Ref.modify(failureRef, (current) =>
      Option.isSome(current) ? ([false, current] as const) : ([true, Option.some(error)] as const),
    );
    if (!isFirst) return;
    yield* failPending(error);
    yield* Deferred.fail(failure, error);
  });

  const ensureConnected = Effect.fn("PiRpcClient.ensureConnected")(function* () {
    const existing = yield* Ref.get(failureRef);
    if (Option.isSome(existing)) {
      return yield* existing.value;
    }
    if (yield* Ref.get(stoppingRef)) {
      return yield* new PiRpcClientError({
        operation: "closed",
        detail: "The Pi RPC client is closed.",
      });
    }
  });

  const write = (command: PiRpcCommand): Effect.Effect<void, PiRpcClientError> =>
    writeLock.withPermit(
      ensureConnected().pipe(
        Effect.andThen(
          Stream.run(Stream.make(textEncoder.encode(encodePiRpcCommand(command))), child.stdin),
        ),
        Effect.mapError((cause) =>
          isPiRpcClientError(cause)
            ? cause
            : new PiRpcClientError({
                operation: "write",
                detail: `Could not send ${command.type}.`,
                cause,
              }),
        ),
      ),
    );

  const handleMessage = Effect.fn("PiRpcClient.handleMessage")(function* (message: PiRpcEnvelope) {
    if (!isPiRpcResponse(message) || message.id === undefined) {
      yield* Queue.offer(eventQueue, message);
      return;
    }
    const pending = yield* Ref.modify(pendingRef, (current) => {
      const deferred = current.get(message.id!);
      if (deferred === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(message.id!);
      return [deferred, next] as const;
    });
    if (pending === undefined) return;
    if (!message.success) {
      yield* Deferred.fail(
        pending,
        new PiRpcClientError({
          operation: "request",
          detail: message.error ?? `${message.command} was rejected by Pi.`,
        }),
      );
      return;
    }
    yield* Deferred.succeed(pending, message);
  });

  const jsonl = makePiJsonlDecoder(
    options.maxLineBytes === undefined ? undefined : { maxLineBytes: options.maxLineBytes },
  );
  yield* child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.try({
        try: () => jsonl.push(chunk),
        catch: (cause) =>
          new PiRpcClientError({
            operation: "protocol",
            detail: "Pi emitted an invalid RPC record.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((messages) => Effect.forEach(messages, handleMessage, { discard: true })),
      ),
    ),
    Effect.flatMap(() =>
      Effect.try({
        try: () => jsonl.end(),
        catch: (cause) =>
          new PiRpcClientError({
            operation: "protocol",
            detail: "Pi ended with an invalid RPC record.",
            cause,
          }),
      }),
    ),
    Effect.flatMap((messages) => Effect.forEach(messages, handleMessage, { discard: true })),
    Effect.mapError((cause) =>
      isPiRpcClientError(cause)
        ? cause
        : new PiRpcClientError({
            operation: "protocol",
            detail: "Could not read Pi RPC output.",
            cause,
          }),
    ),
    Effect.catch((error) => recordFailure(error)),
    Effect.forkIn(scope),
  );

  const maxStderrChunkChars = options.maxStderrChunkChars ?? 4_096;
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      options.onStderr ? options.onStderr(chunk.slice(-maxStderrChunkChars)) : Effect.void,
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* child.exitCode.pipe(
    Effect.flatMap((exitCode) =>
      Ref.get(stoppingRef).pipe(
        Effect.flatMap((stopping) =>
          stopping
            ? Effect.void
            : recordFailure(
                new PiRpcClientError({
                  operation: "process-exit",
                  detail: `Pi exited with code ${Number(exitCode)}.`,
                  exitCode: Number(exitCode),
                }),
              ),
        ),
      ),
    ),
    Effect.catch((cause) =>
      recordFailure(
        new PiRpcClientError({
          operation: "process-exit",
          detail: "Pi exited without a status code.",
          cause,
        }),
      ),
    ),
    Effect.forkIn(scope),
  );

  const closeError = new PiRpcClientError({
    operation: "closed",
    detail: "The Pi RPC client was closed.",
  });
  const close = Ref.getAndSet(stoppingRef, true).pipe(
    Effect.flatMap((wasStopping) =>
      wasStopping
        ? Effect.void
        : failPending(closeError).pipe(
            Effect.andThen(child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore)),
          ),
    ),
  );
  yield* Scope.addFinalizer(scope, close);
  yield* Scope.addFinalizer(scope, Queue.shutdown(eventQueue));

  const request = Effect.fn("PiRpcClient.request")(function* (command: PiRpcRequestCommand) {
    yield* ensureConnected();
    const requestId = yield* Ref.getAndUpdate(nextRequestIdRef, (current) => current + 1);
    const id = `t3-pi-${requestId}`;
    const deferred = yield* Deferred.make<PiRpcResponse, PiRpcClientError>();
    yield* Ref.update(pendingRef, (current) => {
      const next = new Map(current);
      next.set(id, deferred);
      return next;
    });
    const correlated = { ...command, id } as PiRpcCommand;
    return yield* write(correlated).pipe(
      Effect.andThen(Deferred.await(deferred)),
      Effect.ensuring(
        Ref.update(pendingRef, (current) => {
          if (current.get(id) !== deferred) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
      ),
    );
  });

  return {
    request,
    send: write,
    events: Stream.merge(Stream.fromQueue(eventQueue), Stream.fromEffect(Deferred.await(failure))),
    awaitFailure: Deferred.await(failure),
    close,
  } satisfies PiRpcClient;
});
