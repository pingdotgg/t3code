import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** The plain-JS `RestArgs` class hosted by `host.ts`, in another script. */
export class RestArgs extends Cloudflare.DurableObject<
  RestArgs,
  { received: (...args: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<unknown>> }
>()("RestArgs") {}

/**
 * Effect Worker that calls the plain-JS Durable Object inside a span, so the
 * call would carry trace context if the stub appended it.
 */
export default class RestArgsCaller extends Cloudflare.Worker<RestArgsCaller>()(
  "RestArgsCaller",
  { main: import.meta.url },
  Effect.gen(function* () {
    const restArgs = yield* RestArgs.from(Config.String("REST_ARGS_HOST"));
    return {
      fetch: Effect.gen(function* () {
        const args = yield* restArgs.getByName("rest").received("a", "b");
        return yield* HttpServerResponse.json({ args });
      }).pipe(Effect.withSpan("rest-args.caller"), Effect.orDie),
    };
  }),
) {}
