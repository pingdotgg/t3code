import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { roundTrip } from "./dep.cjs";

/**
 * A Worker whose bundle contains a CommonJS module with top-level
 * `require("events")` / `require("node:util")` — the `pg` shape from #880.
 * Deploying it proves the direct Worker bundler converts those requires
 * into ESM imports of the workerd-provided builtins: an unconverted bundle
 * fails Cloudflare's startup validation before any request is served.
 */
export default class RequireNodeBuiltinsWorker extends Cloudflare.Worker<RequireNodeBuiltinsWorker>()(
  "RequireNodeBuiltinsWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const value =
          new URL(request.url, "http://localhost").searchParams.get("value") ??
          "";
        return HttpServerResponse.text(roundTrip(value));
      }),
    };
  }),
) {}
