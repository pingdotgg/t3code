import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import RpcWorkerRpcHttpWorker from "./worker.ts";

/**
 * Stack for the {@link Cloudflare.RpcWorker} +
 * {@link Cloudflare.RpcDurableObject} combined fixture.
 */
export default Alchemy.Stack(
  "RpcWorkerRpcHttpStack",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* RpcWorkerRpcHttpWorker;
    return { url: worker.url.as<string>() };
  }),
);
