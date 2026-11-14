import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import EntrypointPropsWorker from "./effect-worker.ts";

/** The async Worker, hosting its own Durable Object. */
export const AsyncEntrypointPropsWorker = () =>
  Cloudflare.Worker("AsyncEntrypointPropsWorker", {
    main: new URL("./async-worker.ts", import.meta.url).pathname,
    env: { MINTER: Cloudflare.DurableObject("AsyncPropsMinter") },
  });

export default Alchemy.Stack(
  "EntrypointPropsStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effect = yield* EntrypointPropsWorker;
    const async = yield* AsyncEntrypointPropsWorker();
    return {
      effectUrl: effect.url.as<string>(),
      asyncUrl: async.url.as<string>(),
    };
  }),
);
