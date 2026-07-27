import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import CrossVersionWorker from "./src/worker.ts";

// Identical across every stage folder: same Stack name ("CrossVersionApp"),
// same Cloudflare state store, same worker logical id. Sharing those three
// (plus stage + account) is what makes each subsequent deploy an in-place
// UPGRADE of the same app rather than a fresh one.
export default Alchemy.Stack(
  "CrossVersionApp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* CrossVersionWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
