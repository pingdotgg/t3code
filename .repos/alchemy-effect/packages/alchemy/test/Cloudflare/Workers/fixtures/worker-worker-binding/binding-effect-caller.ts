import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import BindingTargetWorker from "./binding-target-worker.ts";

/**
 * Effect-native worker that calls another Effect-native worker's RPC method
 * via `Cloudflare.bindWorker`. This is the canonical Effect → Effect cross-
 * worker pattern: the bound stub returns Effects, errors and streams flow
 * back through the typed channel.
 *
 * GET /?name=foo  →  pipes the bound `greet(name)` Effect through.
 */
export default class BindingEffectCaller extends Cloudflare.Worker<BindingEffectCaller>()(
  "BindingEffectCaller",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const target = yield* Cloudflare.bindWorker(BindingTargetWorker);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const name =
          new URL(request.url, "http://x").searchParams.get("name") ?? "world";
        const greeting = yield* target.greet(name);
        return HttpServerResponse.text(String(greeting));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`effect caller failed: ${String(cause)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }),
) {}
