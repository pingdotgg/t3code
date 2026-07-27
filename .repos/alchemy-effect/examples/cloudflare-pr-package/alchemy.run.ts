import * as PrPackage from "@alchemy.run/pr-package";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "CloudflarePrPackageExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const authToken = yield* PrPackage.AuthTokenValue;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      // `authToken.text` is an `Output<Redacted<string>>`. Map over the Output
      // to unwrap the Redacted so the stack output emits the real token —
      // otherwise it JSON-serializes to the literal string "<redacted>".
      authToken: authToken.text.pipe(Output.map(Redacted.value)),
    };
  }),
);
