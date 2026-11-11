import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Counter } from "./counter.ts";
import { WorkerB } from "./workerB.ts";

// Tag — WorkerB binds this Worker with `bindWorker(WorkerA)`.
export class WorkerA extends Cloudflare.Worker<WorkerA, { name: () => Effect.Effect<string> }>()(
  "WorkerA",
) {}

// Layer — binds the `Counter` hosted by WorkerB, closing the cycle.
//
// GET /?key=k  →  WorkerB's `Counter` instance `k`, incremented.
export default WorkerA.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter.from(WorkerB);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.url, "http://x").searchParams.get("key") ?? "default";
        const value = yield* counters.getByName(key).increment();
        return yield* HttpServerResponse.json({ value });
      }),
      name: () => Effect.succeed("WorkerA"),
    };
  }),
);
