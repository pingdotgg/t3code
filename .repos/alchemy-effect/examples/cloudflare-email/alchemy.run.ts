import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Destination, InboxRule, Routing } from "./src/Email.ts";

export default Alchemy.Stack(
  "CloudflareEmailExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const routing = yield* Routing;
    const destination = yield* Destination;
    const rule = yield* InboxRule;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      zoneId: routing.zoneId,
      routingEnabled: routing.enabled,
      destinationEmail: destination.email,
      destinationVerified: destination.verified,
      ruleId: rule.ruleId,
    };
  }),
);
