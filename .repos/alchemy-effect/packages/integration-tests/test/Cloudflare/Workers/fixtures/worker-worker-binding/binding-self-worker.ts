import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Effect-native worker that binds ITSELF with
 * `Cloudflare.Workers.bindWorker(BindingSelfWorker)` and calls its own RPC
 * method through that binding. The class is declared before its
 * implementation (`.make`) so the implementation can reference it.
 *
 * GET /?name=foo  →  `greet(name)` through the self binding, so a greeting
 *                    proves the call left the handler and came back in
 *                    through the Worker's own RPC surface.
 */
export class BindingSelfWorker extends Cloudflare.Worker<
  BindingSelfWorker,
  { greet: (name: string) => Effect.Effect<string> }
>()("BindingSelfWorker") {}

export default BindingSelfWorker.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const self = yield* Cloudflare.Workers.bindWorker(BindingSelfWorker);

    return {
      greet: (name: string) => Effect.succeed(`hello ${name} from self`),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const name = new URL(request.url, "http://x").searchParams.get("name") ?? "world";
        const greeting = yield* self.greet(name);
        return HttpServerResponse.text(greeting);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`self caller failed: ${String(cause)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }),
);
