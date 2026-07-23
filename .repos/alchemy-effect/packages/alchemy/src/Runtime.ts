/**
 * Runtime helpers consumed by generated bundle entrypoints (Cloudflare
 * Workers, Cloudflare Containers, AWS Lambda, …).
 *
 * Anything exported here runs *inside* the deployed function — keep the
 * surface tiny and dependency-light.
 */

import * as Layer from "effect/Layer";

/**
 * Resolve the user's default-export entrypoint into a `Layer` for the
 * bundled runtime.
 *
 * `entrypoint` may be any of:
 *   - a `Layer` factory (`{ build: (...) => ... }`) — used as-is
 *   - an effect-class with `asEffect()` (Alchemy `Platform`/`Worker` shape)
 *   - a plain `Effect`
 *
 * Centralized so the inline ternary doesn't have to be re-emitted into
 * every bundle template (and accidentally rewritten to `x : x` by a bulk
 * replace, which silently swaps the class in for the Effect and bricks
 * every deployed worker/lambda).
 */
export const makeEntrypointLayer = (
  tag: any,
  entrypoint: any,
): Layer.Layer<any> => {
  if (typeof entrypoint?.build === "function") {
    return entrypoint;
  }
  return Layer.effect(
    tag,
    typeof entrypoint?.asEffect === "function"
      ? entrypoint.asEffect()
      : entrypoint,
  );
};
