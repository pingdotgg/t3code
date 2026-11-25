import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { OMP_RPC_PROVIDER } from "../settings.ts";
import { encodeOmpRequest, makeOmpFrameDecoder, type OmpFrame as Frame } from "./frames.ts";

export function ompProtocolError(detail: string, payload?: unknown) {
  return new ProviderAdapterProtocolError({ driver: OMP_RPC_PROVIDER, detail, payload });
}

export function record(value: unknown): Record<string, unknown> {
  return Predicate.isObject(value) && !Array.isArray(value) ? value : {};
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

export const openOmpRpc = Effect.fn("OmpRpc.open")(function* (input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const toError = (cause: unknown) => ompProtocolError("Oh My Pi RPC transport closed.", cause);
  const resolved = yield* resolveSpawnCommand(input.binaryPath, [...input.args], {
    env: input.environment,
  }).pipe(Effect.mapError(toError));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: input.cwd,
        env: input.environment,
        extendEnv: false,
        shell: resolved.shell,
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(Effect.mapError(toError));
  const outgoing = yield* Queue.bounded<Uint8Array, ProviderAdapterProtocolError>(64);
  const events = yield* Queue.unbounded<Frame, ProviderAdapterProtocolError>();
  const pending = new Map<string, Deferred.Deferred<unknown, ProviderAdapterProtocolError>>();
  let nextId = 0;
  const fail = Effect.fnUntraced(function* (error: ProviderAdapterProtocolError) {
    yield* Queue.fail(outgoing, error);
    yield* Queue.fail(events, error);
    for (const waiter of pending.values()) yield* Deferred.fail(waiter, error);
    pending.clear();
  });
  const decode = makeOmpFrameDecoder();
  const send = (frame: Frame) =>
    Effect.suspend(() => {
      const line = encodeOmpRequest(frame);
      return line
        ? Queue.offer(outgoing, line).pipe(Effect.asVoid)
        : Effect.fail(ompProtocolError("Oh My Pi RPC request exceeded the transport limit."));
    });

  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(
      Effect.fnUntraced(function* (line) {
        const frame = yield* Effect.try({ try: () => decode(line), catch: toError });
        if (frame === undefined) return;
        const id = string(frame.id);
        if (frame.type === "response" && id !== undefined) {
          const waiter = pending.get(id);
          if (waiter !== undefined) {
            if (frame.success === true) {
              if (frame.command === "prompt" && record(frame.data).agentInvoked === false) {
                yield* Queue.offer(events, frame);
              }
              yield* Deferred.succeed(waiter, frame.data);
            } else
              yield* Deferred.fail(
                waiter,
                ompProtocolError(
                  string(frame.error)?.slice(0, 500) ?? "Oh My Pi rejected the RPC command.",
                ),
              );
          } else if (
            frame.success === false &&
            (frame.command === "resume" || frame.command === "prompt")
          ) {
            yield* Queue.offer(events, frame);
          }
        } else if (typeof frame.type === "string") {
          yield* Queue.offer(events, frame);
        }
      }),
    ),
    Effect.matchCauseEffect({
      onFailure: (cause) => fail(toError(cause)),
      onSuccess: () => fail(ompProtocolError("Oh My Pi closed its RPC output.")),
    }),
    Effect.forkScoped,
  );
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) => fail(toError(cause))),
    Effect.forkScoped,
  );
  const request = Effect.fn("OmpRpc.request")(function* (command: Frame, requestId?: string) {
    const id = requestId ?? `t3-${++nextId}`;
    const waiter = yield* Deferred.make<unknown, ProviderAdapterProtocolError>();
    pending.set(id, waiter);
    return yield* send({ ...command, id }).pipe(
      Effect.andThen(Deferred.await(waiter)),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => ompProtocolError(`Oh My Pi timed out handling ${String(command.type)}.`),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );
  });
  // v2 chunks replies, but OMP still accepts requests as single JSON lines.
  yield* request({ type: "negotiate_protocol", protocolVersion: 2 }).pipe(Effect.ignore);
  return { request, send, events: Stream.fromQueue(events) };
});
