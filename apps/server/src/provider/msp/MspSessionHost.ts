/**
 * MSP session host — drives one `muse serve` child process as a plain
 * JSON-RPC 2.0 endpoint over NDJSON stdio.
 *
 * MSP is structurally close to ACP but uses standard JSON-RPC envelopes
 * (`{jsonrpc, id, method, params}` / `{jsonrpc, id, result|error}`), so this
 * is a leaner transport than the ACP client stack: one pending-request map,
 * one notification queue, one server-request dispatcher.
 *
 * Server-initiated requests (`approval/request`, `userInput/request`) only
 * need a presentation receipt back — the real decision travels later as a
 * command (`approval/decide`, `userInput/answer`). The transport answers the
 * receipt itself and forwards the params to the registered handler.
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

export class MspError extends Schema.TaggedError<MspError>()("MspError", {
  operation: Schema.String,
  detail: Schema.String,
  code: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `MSP ${this.operation} failed: ${this.detail}`;
  }
}

export interface MspSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface MspNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface MspServerRequest {
  readonly method: string;
  readonly params: unknown;
}

interface MspPendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, MspError>;
}

interface WireMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

const encoder = new TextEncoder();
const JsonFrame = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonFrame);
const decodeJson = Schema.decodeUnknownSync(JsonFrame);

export interface MspSessionHostService {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, MspError>;
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, MspError>;
  readonly notifications: Stream.Stream<MspNotification>;
  readonly serverRequests: Stream.Stream<MspServerRequest>;
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly close: Effect.Effect<void>;
}

export const makeMspSessionHost = Effect.fn("makeMspSessionHost")(function* (options: {
  readonly spawn: MspSpawnInput;
}): Effect.fn.Return<
  MspSessionHostService,
  MspError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostScope = yield* Scope.Scope;
  const pending = new Map<string, MspPendingRequest>();
  const notifications = yield* Queue.unbounded<MspNotification>();
  const serverRequests = yield* Queue.unbounded<MspServerRequest>();
  const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
  let nextRequestId = 1;
  let closed = false;

  const failAllPending = (error: MspError): Effect.Effect<void> =>
    Effect.forEach(pending.values(), (entry) => Deferred.fail(entry.deferred, error), {
      discard: true,
    }).pipe(Effect.tap(() => Effect.sync(() => pending.clear())));

  const spawnCommand = yield* resolveSpawnCommand(
    options.spawn.command,
    options.spawn.args,
    options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {},
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
        ...(options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {}),
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, hostScope),
      Effect.mapError(
        (cause) =>
          new MspError({
            operation: "spawn",
            detail: `Failed to spawn '${options.spawn.command}'.`,
            cause,
          }),
      ),
    );

  const terminate = (error: MspError): Effect.Effect<void> =>
    Effect.suspend(() =>
      closed
        ? Effect.void
        : Effect.gen(function* () {
            closed = true;
            yield* failAllPending(error);
            yield* Queue.shutdown(notifications);
            yield* Queue.shutdown(serverRequests);
          }),
    );

  const routeMessage = (message: WireMessage): Effect.Effect<void> => {
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(String(message.id));
      if (!entry) return Effect.void;
      pending.delete(String(message.id));
      if (message.error) {
        return Deferred.fail(
          entry.deferred,
          new MspError({
            operation: "request",
            detail: `${entry.method}: ${message.error.message ?? "request failed"}`,
            ...(message.error.code !== undefined ? { code: message.error.code } : {}),
            cause: message.error,
          }),
        ).pipe(Effect.asVoid);
      }
      return Deferred.succeed(entry.deferred, message.result).pipe(Effect.asVoid);
    }
    if (message.id !== undefined && message.method !== undefined) {
      // Server-initiated request. MSP answers carry only a presentation
      // receipt ({}); the decision travels as a later command.
      const respond =
        message.method === "approval/request" || message.method === "userInput/request"
          ? Queue.offer(outgoing, encodeJson({ jsonrpc: "2.0", id: message.id, result: {} }))
          : Queue.offer(
              outgoing,
              encodeJson({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: `Unsupported server request '${message.method}'` },
              }),
            );
      return respond.pipe(
        Effect.andThen(
          message.method === "approval/request" || message.method === "userInput/request"
            ? Queue.offer(serverRequests, { method: message.method, params: message.params })
            : Effect.void,
        ),
        Effect.asVoid,
      );
    }
    if (message.method !== undefined) {
      return Queue.offer(notifications, { method: message.method, params: message.params }).pipe(
        Effect.asVoid,
      );
    }
    return Effect.void;
  };

  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return Effect.void;
      return Effect.try({
        try: () => decodeJson(trimmed) as WireMessage,
        catch: () =>
          new MspError({
            operation: "decode",
            detail: "Failed to parse an MSP frame.",
            cause: trimmed,
          }),
      }).pipe(Effect.flatMap(routeMessage), Effect.ignore);
    }),
    Effect.matchEffect({
      onFailure: (cause) =>
        terminate(
          new MspError({ operation: "read-stdout", detail: "MSP stdout stream failed.", cause }),
        ),
      onSuccess: () =>
        terminate(
          new MspError({ operation: "read-stdout", detail: "MSP session host closed stdout." }),
        ),
    }),
    Effect.forkIn(hostScope),
  );

  // Drain stderr so a chatty child cannot fill the pipe and stall.
  yield* child.stderr.pipe(Stream.runDrain, Effect.forkIn(hostScope));

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.map((line) => encoder.encode(`${line}\n`)),
    Stream.run(child.stdin),
    Effect.matchEffect({
      onFailure: (cause) =>
        terminate(
          new MspError({ operation: "write-stdin", detail: "MSP stdin stream failed.", cause }),
        ),
      onSuccess: () => Effect.void,
    }),
    Effect.forkIn(hostScope),
  );

  const request = (method: string, params: unknown): Effect.Effect<unknown, MspError> =>
    closed
      ? Effect.fail(
          new MspError({ operation: "request", detail: `MSP session host is closed (${method}).` }),
        )
      : Effect.gen(function* () {
          const id = nextRequestId++;
          const deferred = yield* Deferred.make<unknown, MspError>();
          pending.set(String(id), { method, deferred });
          yield* Queue.offer(outgoing, encodeJson({ jsonrpc: "2.0", id, method, params })).pipe(
            Effect.mapError(
              () =>
                new MspError({
                  operation: "request",
                  detail: `Failed to send '${method}'.`,
                }),
            ),
          );
          return yield* Deferred.await(deferred).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                pending.delete(String(id));
              }),
            ),
          );
        });

  const notify = (method: string, params: unknown): Effect.Effect<void, MspError> =>
    Queue.offer(outgoing, encodeJson({ jsonrpc: "2.0", method, params })).pipe(
      Effect.mapError(
        () => new MspError({ operation: "notify", detail: `Failed to send '${method}'.` }),
      ),
      Effect.asVoid,
    );

  const close = child
    .kill({ killSignal: "SIGTERM" })
    .pipe(
      Effect.ignore,
      Effect.andThen(
        terminate(new MspError({ operation: "close", detail: "MSP session host closed." })),
      ),
    );

  yield* Effect.addFinalizer(() => close);

  return {
    request,
    notify,
    notifications: Stream.fromQueue(notifications),
    serverRequests: Stream.fromQueue(serverRequests),
    exitCode: child.exitCode,
    close,
  } satisfies MspSessionHostService;
});
