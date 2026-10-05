import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Reads a `Config` value in Init (#1831). Changing the value must redeploy the
 * Worker even though no binding and no code changed.
 */
export default class InitConfigWorker extends Cloudflare.Worker<InitConfigWorker>()(
  "InitConfigWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const mode = yield* Config.String("INIT_CONFIG_WORKER_MODE").pipe(
      Config.withDefault("unset"),
    );
    return {
      fetch: Effect.succeed(HttpServerResponse.text(mode)),
    };
  }),
) {}
