import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** The upgrade Worker with its models removed. */
export default class DomainUpgradePlainWorker extends Cloudflare.Worker<DomainUpgradePlainWorker>()(
  "DomainUpgradeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return { fetch: Effect.succeed(HttpServerResponse.text("no models")) };
  }),
) {}
