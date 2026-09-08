import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Destination, INBOX } from "./src/Email.ts";

export default Alchemy.Stack(
  "CloudflareEmailExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const destination = yield* Destination;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      destinationEmail: destination.email,
      destinationVerified: destination.verified,
      inbox: INBOX,
    };
  }),
);
