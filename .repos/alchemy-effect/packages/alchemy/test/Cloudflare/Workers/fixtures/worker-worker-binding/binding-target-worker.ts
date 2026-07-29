import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native worker that exposes a single RPC method (`greet`) plus a
 * `fetch` handler. Used as the *callee* in the binding fixtures below.
 */
export default class BindingTargetWorker extends Cloudflare.Worker<BindingTargetWorker>()(
  "BindingTargetWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("hello from BindingTargetWorker");
      }),
    };
  }),
) {}
