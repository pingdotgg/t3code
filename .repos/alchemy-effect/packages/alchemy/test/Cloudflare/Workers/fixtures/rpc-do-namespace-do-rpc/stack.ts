import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import RpcCounterWorker from "./worker.ts";

/**
 * Stack with one Worker driving an
 * {@link Cloudflare.RpcDurableObject} counter via the typed
 * `getByName(id)` client.
 */
export default Alchemy.Stack(
  "RpcDurableObjectStack",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* RpcCounterWorker;
    return { url: worker.url.as<string>() };
  }),
);
