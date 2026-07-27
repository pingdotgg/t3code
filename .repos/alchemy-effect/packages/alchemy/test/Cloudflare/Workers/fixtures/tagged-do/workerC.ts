import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Counter, CounterLive } from "./object.ts";

// Tag — WorkerC also hosts its OWN Counter (declared in its public contract).
// Because each Worker hosts its own DO namespace, the instances under
// WorkerC are isolated from the instances under WorkerA/B.
export class WorkerC extends Cloudflare.Worker<WorkerC, {}, Counter>()(
  "WorkerC",
) {}

// Layer — uses `Counter.from(WorkerC)` (self-reference) instead of
// `yield* Counter`. The two forms are equivalent inside the host; the
// `.from(Self)` form is the recommended style for code that may be
// extracted into a reusable Layer.
export default WorkerC.make(
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const counter = yield* Counter.from(WorkerC);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = request.headers["x-counter-key"] ?? "default";
        const stub = counter.getByName(key);
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/reset") {
          yield* stub.reset(key);
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && url.pathname === "/do/increment") {
          const value = yield* stub.incrementDO();
          return yield* HttpServerResponse.json({ value });
        }

        if (request.method === "GET" && url.pathname === "/do") {
          const value = yield* stub.getDO();
          return yield* HttpServerResponse.json({ value });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      CounterLive.pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding)),
    ),
  ),
);
