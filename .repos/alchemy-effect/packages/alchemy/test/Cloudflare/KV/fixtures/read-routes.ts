import type { ReadNamespaceClient } from "@/Cloudflare/KV/ReadNamespace.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared read-side routes exercised by both the binding and HTTP fixtures so
 * every method of {@link ReadNamespaceClient} is driven over `fetch`:
 *
 * - `GET /get?key=` — `get(key)` (text, the default).
 * - `GET /get-json?key=` — `get(key, "json")` (parsed JSON value).
 * - `GET /get-bulk?keys=a,b` — `get([...], "text")` (bulk read → `Map`).
 * - `GET /getWithMetadata?key=` — `getWithMetadata(key)` (value + metadata).
 * - `GET /list?prefix=` — `list()` / `list({ prefix })`.
 *
 * Returns `undefined` when the path is not a read route so the caller can fall
 * through (used by the read-write fixtures).
 */
export const readRoutes = (kv: ReadNamespaceClient, url: URL) =>
  Effect.gen(function* () {
    if (url.pathname === "/get") {
      const key = url.searchParams.get("key") ?? "";
      const value = yield* kv.get(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ value });
    }
    if (url.pathname === "/get-json") {
      const key = url.searchParams.get("key") ?? "";
      const value = yield* kv.get(key, "json").pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ value });
    }
    if (url.pathname === "/get-bulk") {
      const keys = (url.searchParams.get("keys") ?? "")
        .split(",")
        .filter((k) => k.length > 0);
      const values = yield* kv.get(keys, "text").pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        values: Object.fromEntries(values),
      });
    }
    if (url.pathname === "/getWithMetadata") {
      const key = url.searchParams.get("key") ?? "";
      const result = yield* kv.getWithMetadata(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        value: result.value,
        metadata: result.metadata,
      });
    }
    if (url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") ?? undefined;
      const result = yield* kv
        .list(prefix ? { prefix } : undefined)
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        keys: result.keys.map((k) => k.name),
      });
    }
    return undefined;
  });
