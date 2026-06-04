import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { Counter } from "./object.ts";
import { WorkerA } from "./workerA.ts";

// Consumer worker — binds to WorkerA's hosted `Counter` rpc DO via
// `Counter.from(WorkerA)` (cross-script DO binding). Plain
// `Cloudflare.Worker` so we can drive the test through HTTP routes
// without needing an RpcClient setup for this end.
export default class WorkerB extends Cloudflare.Worker<WorkerB>()(
  "WorkerB",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const counter = yield* Counter.from(WorkerA);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = request.headers["x-counter-key"] ?? "default";
        const stub = yield* counter.getByName(key);
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/reset") {
          yield* stub.reset({ key }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && url.pathname === "/d1/increment") {
          const { value } = yield* stub.incrementD1({ key }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }

        if (request.method === "GET" && url.pathname === "/d1") {
          const { value } = yield* stub.getD1({ key }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }

        if (request.method === "POST" && url.pathname === "/do/increment") {
          const { value } = yield* stub.incrementDO({ key }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }

        if (request.method === "GET" && url.pathname === "/do") {
          const { value } = yield* stub.getDO({ key }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(Effect.scoped),
    };
  }),
) {}
