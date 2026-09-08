import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Minimal Worker that exists only to be named by an `Email.Rule` /
 * `Email.CatchAll` `worker` action in the same apply — the shape that
 * reproduces alchemy-run/alchemy#1348.
 */
export default class RuleTargetWorker extends Cloudflare.Worker<RuleTargetWorker>()(
  "EmailRuleTargetWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
