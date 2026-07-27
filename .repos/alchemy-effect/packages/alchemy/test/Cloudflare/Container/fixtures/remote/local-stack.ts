import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import LocalRemoteContainerWorker from "./local-worker.ts";

/**
 * Same worker/DO/container arrangement as `stack.ts`, but under a distinct
 * stack name AND a distinct fixture identity (`local-worker.ts` /
 * `local-object.ts` — LocalRemoteContainer* logical ids) so the local-dev
 * test (`LocalContainer.test.ts`) never shares state, a container
 * application, or a workers.dev worker with the live `Container.test.ts`
 * deployment when the two files run concurrently.
 */
export default Alchemy.Stack(
  "LocalRemoteContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* LocalRemoteContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
