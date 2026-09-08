import type { ReadBucketClient } from "@/Prisma/ReadBucket.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared read-side routes so every method of {@link ReadBucketClient}
 * (`get`, `head`, `list`, `presignGet`) is driven over `fetch`. Returns
 * `undefined` when the path is not a read route so the caller can fall
 * through (used by the read-write fixtures).
 */
export const readRoutes = (store: ReadBucketClient, url: URL) =>
  Effect.gen(function* () {
    if (url.pathname === "/get") {
      const key = url.searchParams.get("key") ?? "";
      const object = yield* store.get(key).pipe(Effect.orDie);
      const value = object ? yield* object.text().pipe(Effect.orDie) : null;
      return yield* HttpServerResponse.json({
        value,
        contentType: object?.contentType ?? null,
        metadata: object?.metadata ?? null,
      });
    }
    if (url.pathname === "/head") {
      const key = url.searchParams.get("key") ?? "";
      const object = yield* store.head(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        exists: object !== null,
        size: object?.size ?? null,
      });
    }
    if (url.pathname === "/list") {
      const limit = url.searchParams.get("limit");
      const result = yield* store
        .list({
          prefix: url.searchParams.get("prefix") ?? undefined,
          delimiter: url.searchParams.get("delimiter") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: limit ? Number(limit) : undefined,
        })
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        keys: result.objects.map((o) => o.key),
        delimitedPrefixes: result.delimitedPrefixes,
        truncated: result.truncated,
        cursor: result.truncated ? result.cursor : null,
      });
    }
    // The app mints the URL from its bound credentials and hands it back; the
    // test then fetches that URL directly, carrying no credentials of its own.
    if (url.pathname === "/presign-get") {
      const key = url.searchParams.get("key") ?? "";
      const expiresIn = url.searchParams.get("expiresIn");
      const contentType = url.searchParams.get("contentType");
      const presigned = yield* store
        .presignGet(key, {
          expiresIn: expiresIn ? Number(expiresIn) : undefined,
          contentType: contentType ?? undefined,
        })
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ url: presigned });
    }
    return undefined;
  });
