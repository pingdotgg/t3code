import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Minimal Effect-native container for the cold-start benchmark. Alchemy bundles
 * this file's Effect program into a generated image; the DO proxies a trivial
 * `ping()` RPC into it, which is enough to prove the container is up and
 * accepting connections on its RPC port.
 */
export class EffectfulContainer extends Cloudflare.Container<
  EffectfulContainer,
  {
    ping: () => Effect.Effect<string>;
  }
>()("BenchEffectfulContainer") {}

export default EffectfulContainer.make(
  {
    main: import.meta.filename,
    image: "oven/bun:latest",
    // Match wrangler's container config so the comparison isolates the
    // framework, not the tier: max_instances 100 (Alchemy defaults to 1),
    // instance_type "lite", and instances 0 (pure scale-from-zero).
    maxInstances: 100,
    instanceType: "lite",
    instances: 0,
  },
  Effect.gen(function* () {
    return {
      ping: () => Effect.succeed("pong"),
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
);
