import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "DevCliKillFixture",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("KillFixtureWorker", {
      main: "./worker.ts",
    });
    return { workerUrl: worker.url.as<string>() };
  }),
);
