import type { ReadBucketClient } from "@/Cloudflare/R2/ReadBucket.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared read-side routes exercised by both the binding and HTTP fixtures so
 * every method of {@link ReadBucketClient} (`get`, `head`, `list`) is driven
 * over `fetch`. Returns `undefined` when the path is not a read route so the
 * caller can fall through (used by the read-write fixtures).
 */
export const readRoutes = (r2: ReadBucketClient, url: URL) =>
  Effect.gen(function* () {
    if (url.pathname === "/get") {
      const key = url.searchParams.get("key") ?? "";
      const object = yield* r2.get(key).pipe(Effect.orDie);
      const value = object ? yield* object.text().pipe(Effect.orDie) : null;
      return yield* HttpServerResponse.json({ value });
    }
    if (url.pathname === "/head") {
      const key = url.searchParams.get("key") ?? "";
      const object = yield* r2.head(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        exists: object !== null,
        size: object?.size ?? null,
      });
    }
    if (url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") ?? undefined;
      const result = yield* r2
        .list(prefix ? { prefix } : undefined)
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        keys: result.objects.map((o) => o.key),
      });
    }
    return undefined;
  });
