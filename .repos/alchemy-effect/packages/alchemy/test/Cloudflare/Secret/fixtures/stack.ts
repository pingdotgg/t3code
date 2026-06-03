import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import SecretsTestWorker from "./worker.ts";

export default Alchemy.Stack(
  "AlchemySecretWorkerStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* SecretsTestWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
