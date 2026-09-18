import * as Cloudflare from "alchemy/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Cache } from "./Bindings.ts";

/** KV's floor for both `expirationTtl` and `cacheTtl`. */
const MIN_TTL = Duration.minutes(1);

const seconds = (duration: Duration.Duration) =>
  Math.floor(Duration.toSeconds(duration));

/**
 * A lookup-through cache on the registry's KV namespace, shared by every
 * isolate of the Worker.
 *
 * Concurrent misses each run the lookup and each write; the last write wins.
 * That is deliberate: a cache that shares an in-flight lookup, like Effect's
 * `Cache`, has later callers join the first caller's fiber, and workerd drops
 * a fiber resumed from another request's context once that request
 * completes, which surfaces as the joining request hanging.
 *
 * Reads set `cacheTtl`, so a value can still be served from the colo's edge
 * cache for up to a minute after it expired; a lookup's `ttl` must leave
 * that margin. Values with less than a minute left are not stored. KV
 * failures are logged and fall through to the lookup.
 */
export const make = <K, A, I, E, R>(
  key: (input: K) => string,
  value: Schema.Codec<A, I>,
  lookup: (
    input: K,
  ) => Effect.Effect<{ value: A; ttl: Duration.Duration }, E, R>,
) => {
  const json = Schema.fromJsonString(value);
  const decode = Schema.decodeUnknownEffect(json);
  const encode = Schema.encodeEffect(json);
  return (input: K) =>
    Effect.gen(function* () {
      const kv = yield* Cloudflare.KV.ReadWriteNamespace(Cache);
      const id = key(input);
      const hit = yield* kv.get(id, { cacheTtl: seconds(MIN_TTL) }).pipe(
        Effect.flatMap((text) =>
          text === null ? Effect.succeed(undefined) : decode(text),
        ),
        Effect.catch((e) =>
          Effect.logWarning(`cache read of ${id} failed: ${e}`).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      if (hit !== undefined) {
        return hit;
      }
      const fresh = yield* lookup(input);
      if (Duration.isGreaterThanOrEqualTo(fresh.ttl, MIN_TTL)) {
        yield* encode(fresh.value).pipe(
          Effect.flatMap((text) =>
            kv.put(id, text, { expirationTtl: seconds(fresh.ttl) }),
          ),
          Effect.catch((e) =>
            Effect.logWarning(`cache write of ${id} failed: ${e}`),
          ),
        );
      }
      return fresh.value;
    });
};
