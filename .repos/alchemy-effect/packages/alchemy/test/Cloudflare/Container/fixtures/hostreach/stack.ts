import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import HostReachContainerWorker from "./worker.ts";

/**
 * Dev-only stack proving a container can reach services listening on the
 * developer's machine (the topology of every local dev database). Owns its
 * own fixture identity so it never shares state with the other container
 * suites when files run concurrently.
 */
export default Alchemy.Stack(
  "HostReachContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* HostReachContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
