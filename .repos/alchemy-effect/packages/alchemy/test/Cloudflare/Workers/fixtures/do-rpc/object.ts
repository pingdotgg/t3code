import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const KV = Cloudflare.KVNamespace("DurableObjectWorkerEnvironmentKV", {
  title: "durable-object-worker-environment-kv",
});

export class WorkerEnvironmentKVObject extends Cloudflare.DurableObjectNamespace<WorkerEnvironmentKVObject>()(
  "WorkerEnvironmentKVObject",
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(KV);

    return Effect.gen(function* () {
      return {
        put: (key: string, value: string) => kv.put(key, value),
        get: (key: string) => kv.get(key),
        // Mirrors the `tick` example from the tutorial:
        // https://v2.alchemy.run/tutorial/cloudflare/durable-objects/
        // An RPC method that returns a Stream of sequential numbers.
        tick: (n: number) =>
          Stream.iterate(0, (i) => i + 1).pipe(
            Stream.take(n),
            Stream.schedule(Schedule.spaced("100 millis")),
          ),
      };
    });
  }).pipe(Effect.provide(Cloudflare.KVNamespaceBindingLive)),
) {}
