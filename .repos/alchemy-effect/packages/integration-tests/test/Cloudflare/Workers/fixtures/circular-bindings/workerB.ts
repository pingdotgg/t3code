import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Counter, CounterLive } from "./counter.ts";
import { WorkerA } from "./workerA.ts";

// Tag — hosts `Counter`, so WorkerA can bind it with `Counter.from(WorkerB)`.
export class WorkerB extends Cloudflare.Worker<WorkerB, {}, Counter>()("WorkerB") {}

// Layer — hosts `Counter` and binds WorkerA, closing the cycle.
//
// GET /?key=k   →  this Worker's `Counter` instance `k`, read directly.
// GET /worker-a →  WorkerA's `name()` over the service binding.
export default WorkerB.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    const workerA = yield* Cloudflare.Workers.bindWorker(WorkerA);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/worker-a") {
          return HttpServerResponse.text(yield* workerA.name());
        }
        const key = url.searchParams.get("key") ?? "default";
        const value = yield* counters.getByName(key).get();
        return yield* HttpServerResponse.json({ value });
      }),
    };
  }).pipe(Effect.provide(CounterLive)),
);
