import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

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
        // Egress colo is diagnostic, not a placement guarantee.
        colo: () =>
          Effect.promise(async () => {
            const response = await fetch(
              "https://cloudflare.com/cdn-cgi/trace",
            );
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
      };
    });
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
