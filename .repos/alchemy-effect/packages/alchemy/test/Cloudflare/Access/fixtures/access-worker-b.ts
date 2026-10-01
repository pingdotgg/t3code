import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { App } from "./access-worker.ts";

/**
 * Second Worker enrolling into the SAME shared application as
 * `access-worker.ts`. Pins the many-Workers-one-application merge through
 * the binding contract.
 */
export default class SecondAccessWorker extends Cloudflare.Worker<SecondAccessWorker>()(
  "SecondAccessWorker",
  {
    main: import.meta.url,
    access: App,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const access = yield* Cloudflare.Access.Context;
        return yield* HttpServerResponse.json({
          marker: "alchemy-access-worker-b-open",
          authenticated: access !== undefined,
        });
      }),
    };
  }),
) {}
