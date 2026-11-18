import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import InterceptContainerWorker from "./worker.ts";

/**
 * Dev-only stack for a container whose outbound HTTP its owning Durable
 * Object intercepts. Owns its own fixture identity so it never shares state
 * with the other container suites when files run concurrently.
 */
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "InterceptContainerStack",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const worker = yield* InterceptContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
