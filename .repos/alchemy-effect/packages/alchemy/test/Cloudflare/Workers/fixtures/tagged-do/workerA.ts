import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Counter, CounterLive } from "./object.ts";

// Tag
export class WorkerA extends Cloudflare.Worker<WorkerA, {}, Counter>()(
  "WorkerA",
) {}

// Layer
export default WorkerA.make(
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const counter = yield* Counter;

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

        if (request.method === "POST" && url.pathname === "/d1/increment") {
          const value = yield* stub.incrementD1(key);
          return yield* HttpServerResponse.json({ value });
        }

        if (request.method === "GET" && url.pathname === "/d1") {
          const value = yield* stub.getD1(key);
          return yield* HttpServerResponse.json({ value });
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
      // WorkerA needs to provide it
      CounterLive.pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding)),
    ),
  ),
);
