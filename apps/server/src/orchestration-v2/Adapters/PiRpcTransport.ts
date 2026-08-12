import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const PiRpcRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodePiRpcRecord = Schema.decodeUnknownEffect(PiRpcRecord);
const encodePiRpcRecord = Schema.encodeUnknownEffect(Schema.fromJsonString(PiRpcRecord));

export type PiRpcRecord = typeof PiRpcRecord.Type;

export interface PiRpcResponse extends PiRpcRecord {
  readonly type: "response";
  readonly id?: string;
}

export interface PiRpcExtensionUiRequest extends PiRpcRecord {
  readonly type: "extension_ui_request";
  readonly id: string;
}

export type PiRpcInboundMessage =
  | { readonly _tag: "response"; readonly response: PiRpcResponse }
  | { readonly _tag: "extension-ui"; readonly request: PiRpcExtensionUiRequest }
  | { readonly _tag: "event"; readonly event: PiRpcRecord };

export class PiRpcTransportError extends Schema.TaggedErrorClass<PiRpcTransportError>()(
  "PiRpcTransportError",
  {
    operation: Schema.Literals(["spawn", "encode", "write", "read", "decode"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC transport failed during ${this.operation}.`;
  }
}

export class PiRpcProtocolError extends Schema.TaggedErrorClass<PiRpcProtocolError>()(
  "PiRpcProtocolError",
  {
    detail: Schema.String,
    payload: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC protocol error: ${this.detail}.`;
  }
}

export type PiRpcStreamError = PiRpcTransportError | PiRpcProtocolError;
const isPiRpcProtocolError = Schema.is(PiRpcProtocolError);

export function classifyPiRpcRecord(
  record: PiRpcRecord,
): Effect.Effect<PiRpcInboundMessage, PiRpcProtocolError> {
  const type = record["type"];
  if (!Predicate.isString(type) || type.length === 0) {
    return Effect.fail(
      new PiRpcProtocolError({
        detail: "stdout frame has no non-empty type discriminator",
        payload: record,
      }),
    );
  }
  if (type === "response") {
    return Effect.succeed({
      _tag: "response",
      response: record as PiRpcResponse,
    });
  }
  if (type === "extension_ui_request") {
    const id = record["id"];
    if (!Predicate.isString(id) || id.length === 0) {
      return Effect.fail(
        new PiRpcProtocolError({
          detail: "extension UI request has no non-empty id",
          payload: record,
        }),
      );
    }
    return Effect.succeed({
      _tag: "extension-ui",
      request: record as PiRpcExtensionUiRequest,
    });
  }
  return Effect.succeed({ _tag: "event", event: record });
}

/**
 * Decodes Pi's strict LF-delimited JSONL stream. The NDJSON decoder deliberately
 * leaves U+2028 and U+2029 inside JSON strings instead of treating them as line
 * boundaries, matching Pi's RPC framing contract.
 */
export function decodePiRpcStdout(
  input: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<PiRpcInboundMessage, PiRpcStreamError> {
  return input.pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.mapEffect((value) =>
      decodePiRpcRecord(value).pipe(
        Effect.mapError(
          (cause) =>
            new PiRpcProtocolError({
              detail: "stdout frame is not a JSON object",
              payload: value,
              cause,
            }),
        ),
        Effect.flatMap(classifyPiRpcRecord),
      ),
    ),
    Stream.mapError((cause) =>
      isPiRpcProtocolError(cause) ? cause : new PiRpcTransportError({ operation: "decode", cause }),
    ),
  );
}

export interface PiRpcTransport {
  readonly send: (command: PiRpcRecord) => Effect.Effect<void, PiRpcTransportError>;
  readonly request: (
    command: PiRpcRecord,
    timeoutMs: number,
  ) => Effect.Effect<PiRpcResponse | undefined, PiRpcTransportError>;
  readonly messages: Queue.Dequeue<PiRpcInboundMessage, PiRpcStreamError | Cause.Done<void>>;
  readonly isClosed: Effect.Effect<boolean>;
  readonly close: Effect.Effect<void>;
}

export interface MakePiRpcTransportOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export const makePiRpcTransport = Effect.fn("PiRpcTransport.make")(function* (
  options: MakePiRpcTransportOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolved = yield* resolveSpawnCommand(options.command, options.args, {
    env: options.env,
  }).pipe(Effect.mapError((cause) => new PiRpcTransportError({ operation: "spawn", cause })));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: options.cwd,
        env: options.env,
        forceKillAfter: 5_000,
        shell: resolved.shell,
        stderr: "pipe",
        stdout: "pipe",
      }),
    )
    .pipe(Effect.mapError((cause) => new PiRpcTransportError({ operation: "spawn", cause })));

  const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const messages = yield* Queue.unbounded<
    PiRpcInboundMessage,
    PiRpcStreamError | Cause.Done<void>
  >();
  const closed = yield* Deferred.make<void>();
  const pendingRequests = new Map<string, Deferred.Deferred<PiRpcResponse>>();
  let nextRequestId = 0;

  const markClosed = Effect.fn("PiRpcTransport.markClosed")(function* () {
    yield* Deferred.succeed(closed, undefined);
    yield* Queue.end(outgoing);
    yield* Queue.end(messages);
    pendingRequests.clear();
  });

  const offerRecord = Effect.fn("PiRpcTransport.offerRecord")(function* (record: PiRpcRecord) {
    const line = yield* encodePiRpcRecord(record).pipe(
      Effect.mapError((cause) => new PiRpcTransportError({ operation: "encode", cause })),
    );
    const offered = yield* Queue.offer(outgoing, new TextEncoder().encode(`${line}\n`));
    if (!offered) {
      return yield* new PiRpcTransportError({ operation: "write", cause: "process closed" });
    }
  });

  const routeMessage = Effect.fn("PiRpcTransport.routeMessage")(function* (
    message: PiRpcInboundMessage,
  ) {
    if (message._tag === "response") {
      const id = message.response.id;
      if (id !== undefined) {
        const pending = pendingRequests.get(id);
        if (pending !== undefined) {
          pendingRequests.delete(id);
          yield* Deferred.succeed(pending, message.response);
          return;
        }
      }
    }
    yield* Queue.offer(messages, message);
  });

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.mapError((cause) => new PiRpcTransportError({ operation: "write", cause })),
    Effect.catch((error) => Queue.fail(messages, error)),
    Effect.forkScoped,
  );

  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

  yield* decodePiRpcStdout(child.stdout).pipe(
    Stream.runForEach(routeMessage),
    Effect.catch((error) => Queue.fail(messages, error)),
    Effect.ensuring(markClosed()),
    Effect.forkScoped,
  );

  const request = Effect.fn("PiRpcTransport.request")(function* (
    command: PiRpcRecord,
    timeoutMs: number,
  ) {
    const id = `t3-pi-${++nextRequestId}`;
    const deferred = yield* Deferred.make<PiRpcResponse>();
    pendingRequests.set(id, deferred);
    yield* offerRecord({ ...command, id }).pipe(
      Effect.tapError(() => Effect.sync(() => pendingRequests.delete(id))),
    );
    const outcome = yield* Deferred.await(deferred).pipe(
      Effect.map(Option.some),
      Effect.race(Deferred.await(closed).pipe(Effect.as(Option.none<PiRpcResponse>()))),
      Effect.timeoutOption(timeoutMs),
    );
    pendingRequests.delete(id);
    return Option.isNone(outcome) ? undefined : Option.getOrUndefined(outcome.value);
  });

  return {
    send: offerRecord,
    request,
    messages,
    isClosed: Deferred.isDone(closed),
    close: child.kill().pipe(Effect.ignore),
  } satisfies PiRpcTransport;
});
