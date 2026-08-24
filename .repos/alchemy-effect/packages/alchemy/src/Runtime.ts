/**
 * Runtime helpers consumed by generated bundle entrypoints (Cloudflare
 * Workers, Cloudflare Containers, AWS Lambda, …).
 *
 * Anything exported here runs *inside* the deployed function — keep the
 * surface tiny and dependency-light.
 */

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isRedactedMarker, sanitizeKey } from "./RuntimeContext.ts";
import { asEffect } from "./Util/types.ts";

/**
 * Resolve the user's default-export entrypoint into a `Layer` for the
 * bundled runtime.
 *
 * `entrypoint` may be any of:
 *   - a `Layer` factory (`{ build: (...) => ... }`) — used as-is
 *   - an Alchemy `Platform`/`Worker` construct (now a real `Effect`)
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
  return Layer.effect(tag, asEffect(entrypoint));
};

/**
 * Unwrap the `{"_tag":"Redacted","value":...}` marker that the deploy-time
 * `Config` interceptor (see `Platform.ts`) and `RuntimeContext.set` use to
 * preserve `Redacted`-ness across the env-var boundary. Returns the inner
 * source value as a string, or `undefined` when `raw` is not a marker.
 */
const parseRedactedMarker = (raw: string): string | undefined => {
  if (!raw.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRedactedMarker(parsed)) {
      return typeof parsed.value === "string"
        ? parsed.value
        : JSON.stringify(parsed.value);
    }
  } catch {
    // not JSON — plain env value, fall through
  }
  return undefined;
};

/**
 * Reify an env-var string the way `RuntimeContext.get` does: unwrap the
 * `Redacted` marker, unquote a JSON-stringified string, and pass anything
 * else through verbatim.
 */
const reifyEnvString = (raw: string): string => {
  const marker = parseRedactedMarker(raw);
  if (marker !== undefined) {
    return marker;
  }
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // not JSON — plain env value, fall through
    }
  }
  return raw;
};

/**
 * Wrap a runtime's env-backed `ConfigProvider` so values that were
 * auto-bound by the deploy-time `Config` interceptor decode transparently.
 *
 * The engine can't know which config values are sensitive, so the
 * interceptor binds every `Config` read during Init onto the deploy target
 * as a secret, serialized as a `{"_tag":"Redacted","value":<source>}`
 * marker. The interceptor's runtime branch reifies those markers for reads
 * during Init, but effects that run later (request handlers, nested
 * layers) resolve `Config` against the raw env-backed provider — without
 * this wrapper, `Config.number("PORT")` inside a handler sees the marker
 * JSON instead of the source value and fails with a schema error.
 *
 * Two behaviors:
 * - Leaf values that carry the marker are unwrapped to the raw source
 *   string before `Config` schemas decode them; everything else passes
 *   through untouched.
 * - On a miss, falls back to the flat `sanitizeKey`-canonicalized key
 *   (`my.key` → `my_key`) that the interceptor bound the value under, so
 *   config names with non-alphanumeric characters resolve at runtime too.
 */
export const reifyBoundConfigProvider = (
  base: ConfigProvider.ConfigProvider,
  env: Record<string, unknown>,
): ConfigProvider.ConfigProvider =>
  ConfigProvider.make((path) =>
    base.load(path).pipe(
      Effect.map((node) => {
        if (node?._tag === "Value") {
          const value = parseRedactedMarker(node.value);
          return value === undefined ? node : ConfigProvider.makeValue(value);
        }
        if (node === undefined) {
          const raw = env[sanitizeKey(path.map((p) => p.toString()).join("_"))];
          if (typeof raw === "string") {
            return ConfigProvider.makeValue(reifyEnvString(raw));
          }
        }
        return node;
      }),
    ),
  );
