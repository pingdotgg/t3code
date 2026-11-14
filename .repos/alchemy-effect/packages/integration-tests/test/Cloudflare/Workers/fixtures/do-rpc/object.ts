import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export const streamScenarios = [
  "complete",
  "cancel",
  "empty",
  "head-failure",
  "tail-failure",
] as const;

class RpcStreamFixtureError extends Data.TaggedError("RpcStreamFixtureError")<{
  readonly phase: "head" | "tail";
}> {}

interface RpcStreamSnapshot {
  part: "head" | "tail";
  eventClosed: number;
  sourceClosed: number;
}

type RpcStreamValue = RpcStreamSnapshot | Uint8Array;

const KV = Cloudflare.KV.Namespace("DurableObjectWorkerEnvironmentKV", {
  title: "durable-object-worker-environment-kv",
});

export class WorkerEnvironmentKVObject extends Cloudflare.DurableObject<WorkerEnvironmentKVObject>()(
  "WorkerEnvironmentKVObject",
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(KV);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        identity: () => Effect.sync(() => state.id.toString()),
        put: (key: string, value: string) => kv.put(key, value),
        get: (key: string) => kv.get(key),
        scopedStreamReady: () => Effect.succeed("rpc-stream-scopes"),
        scopedStream: (
          bytes: boolean,
          scenario: (typeof streamScenarios)[number],
        ): Effect.Effect<
          Stream.Stream<RpcStreamValue, RpcStreamFixtureError>,
          never,
          Scope.Scope
        > =>
          Effect.gen(function* () {
            let eventClosed = 0;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                eventClosed++;
              }),
            );

            return Stream.unwrap(
              Effect.gen(function* () {
                let sourceClosed = 0;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    sourceClosed++;
                  }),
                );
                const value = (part: "head" | "tail"): RpcStreamValue => {
                  const snapshot = { part, eventClosed, sourceClosed };
                  return bytes
                    ? new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`)
                    : snapshot;
                };
                if (scenario === "empty") return Stream.empty;
                if (scenario === "head-failure") {
                  return Stream.fail(new RpcStreamFixtureError({ phase: "head" }));
                }
                return Stream.concat(
                  Stream.succeed(value("head")),
                  Stream.fromEffect(
                    scenario === "cancel"
                      ? Effect.never
                      : Effect.gen(function* () {
                          // Keep the tail in a later pull so both scope lifetimes
                          // are observed after the native RPC method has returned.
                          yield* Effect.sleep("50 millis");
                          if (scenario === "tail-failure") {
                            return yield* Effect.fail(new RpcStreamFixtureError({ phase: "tail" }));
                          }
                          return value("tail");
                        }),
                  ),
                );
              }),
            );
          }),
        // Egress colo is diagnostic, not a placement guarantee.
        colo: () =>
          Effect.promise(async () => {
            const response = await fetch("https://cloudflare.com/cdn-cgi/trace");
            const trace = await response.text();
            return trace.match(/^colo=(.*)$/m)?.[1] ?? "unknown";
          }),
        // Mirrors the `tick` example from the tutorial:
        // https://alchemy.run/cloudflare/compute/durable-objects
        // An RPC method that returns a Stream of sequential numbers.
        tick: (n: number) =>
          Stream.iterate(0, (i) => i + 1).pipe(
            Stream.take(n),
            Stream.schedule(Schedule.spaced("100 millis")),
          ),
        // Pushed sources: values arrive after the RPC method has returned,
        // so the stream's source scope must outlive the call (#2273).
        pubsub: (n: number) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const pubsub = yield* PubSub.unbounded<number>();
              yield* Effect.forkDetach(
                Effect.gen(function* () {
                  for (let i = 0; i < n; i++) {
                    yield* Effect.sleep("100 millis");
                    yield* PubSub.publish(pubsub, i);
                  }
                }),
              );
              return Stream.fromPubSub(pubsub).pipe(Stream.take(n));
            }),
          ),
        callback: (n: number) =>
          Stream.callback<number>((queue) =>
            Effect.gen(function* () {
              for (let i = 0; i < n; i++) {
                yield* Effect.sleep("100 millis");
                yield* Queue.offer(queue, i);
              }
              yield* Queue.end(queue);
            }).pipe(Effect.forkScoped),
          ),
      };
    });
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
