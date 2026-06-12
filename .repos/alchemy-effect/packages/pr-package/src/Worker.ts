import * as Cloudflare from "alchemy/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  aliasRedirectPath,
  type AliasParserOptions,
  type ParseAliasUrl,
} from "./aliases.ts";
import { AuthToken } from "./AuthToken.ts";
import { Bucket } from "./Bucket.ts";
import PackageStore from "./PackageStore.ts";
import { TagIndex } from "./TagIndex.ts";

class Unauthorized {
  readonly _tag = "Unauthorized";
}

export interface HandlerOptions extends AliasParserOptions {
  /** Default TTL when X-TTL is not provided on upload. e.g. "3 weeks". */
  defaultTtl?: string;
}

const bindings = Layer.mergeAll(
  Cloudflare.R2BucketBindingLive,
  Cloudflare.KVNamespaceBindingLive,
  Cloudflare.SecretBindingLive,
);

/**
 * Init effect for a pr-package worker. Pass as the third argument to
 * `Cloudflare.Worker<X>()(...)` in your stack file.
 *
 * The user's stack file must be the worker entry (`main: import.meta.filename`)
 * because `parseAliasUrl` is a closure that has to live in the bundle.
 *
 * @example
 * ```ts
 * import * as PrPackage from "@alchemy.run/pr-package";
 *
 * class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.filename, url: true, ... },
 *   PrPackage.handler({
 *     parseAliasUrl: (url) => ({ pkgName: "...", tag: "..." }),
 *   }),
 * ) {}
 * ```
 */
export const handler = (options: HandlerOptions = {}) =>
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2Bucket.bind(yield* Bucket);
    const kv = yield* Cloudflare.KVNamespace.bind(yield* TagIndex);
    const authToken = yield* Cloudflare.Secret.bind(yield* AuthToken);
    const packages = yield* PackageStore;

    const parseAliasUrl: ParseAliasUrl = options.parseAliasUrl ?? (() => null);
    const defaultTtl = options.defaultTtl ?? "3 weeks";

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const host = request.headers.host ?? "localhost";
        const url = new URL(request.url, `https://${host}`);
        const path = url.pathname;
        const method = request.method;

        const requireAuth = Effect.gen(function* () {
          const authHeader = request.headers.authorization;
          const expected = yield* authToken;
          if (!authHeader || authHeader !== `Bearer ${expected}`) {
            return yield* Effect.fail(new Unauthorized());
          }
        });

        // Pretty alias paths 301 → /projects/:pkgName/tags/:tag (relative).
        if (method === "GET" && !path.startsWith("/projects/")) {
          const match = parseAliasUrl(url);
          if (match) {
            return HttpServerResponse.fromWeb(
              new Response(null, {
                status: 301,
                headers: { location: aliasRedirectPath(match) },
              }),
            );
          }
        }

        // Route: /projects/:pkgName/...
        const projectMatch = path.match(
          /^\/projects\/((?:@|%40)[^/]+\/[^/]+|[^/]+)(\/.*)?$/i,
        );
        if (!projectMatch) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const project = decodeURIComponent(projectMatch[1]);
        const subPath = projectMatch[2] || "/";

        // --- PUT /projects/:pkgName/packages ---
        if (method === "PUT" && subPath === "/packages") {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const tagsRaw = request.headers["x-tags"];
            const ttlRaw = request.headers["x-ttl"];
            const contentLength = Number(
              request.headers["content-length"] ?? 0,
            );

            if (!tagsRaw) {
              return yield* HttpServerResponse.json(
                { error: "X-Tags header is required" },
                { status: 400 },
              );
            }

            let tags: string[];
            try {
              tags = JSON.parse(tagsRaw);
              if (!Array.isArray(tags) || tags.length === 0) {
                return yield* HttpServerResponse.json(
                  { error: "X-Tags must be a non-empty JSON array of strings" },
                  { status: 400 },
                );
              }
            } catch {
              return yield* HttpServerResponse.json(
                { error: "X-Tags must be valid JSON" },
                { status: 400 },
              );
            }

            if (!contentLength) {
              return yield* HttpServerResponse.json(
                { error: "Content-Length header is required" },
                { status: 400 },
              );
            }

            const ttlStr = ttlRaw || defaultTtl;
            const ttlDuration = Duration.fromInput(ttlStr as Duration.Input);
            if (ttlDuration._tag === "None") {
              return yield* HttpServerResponse.json(
                {
                  error:
                    "X-TTL must be an Effect Duration string (e.g. '7 hours', '3 weeks', '30 minutes')",
                },
                { status: 400 },
              );
            }
            const ttlMillis = Duration.toMillis(ttlDuration.value);
            if (ttlMillis <= 0) {
              return yield* HttpServerResponse.json(
                {
                  error:
                    "X-TTL must be a positive duration (e.g. '7 hours', '3 weeks')",
                },
                { status: 400 },
              );
            }
            const resourceId = crypto.randomUUID();
            const expiresAt = Date.now() + ttlMillis;

            for (const tag of tags) {
              const oldResourceId = yield* kv.get(`tag:${project}:${tag}`);
              if (oldResourceId && oldResourceId !== resourceId) {
                const oldStore = packages.getByName(oldResourceId);
                const { orphaned } = yield* oldStore
                  .removeTag(tag)
                  .pipe(Effect.orDie);
                if (orphaned) {
                  yield* r2.delete(oldResourceId + ".tgz").pipe(Effect.orDie);
                  yield* kv.delete(`metadata:${oldResourceId}`);
                }
              }
            }

            yield* r2
              .put(resourceId + ".tgz", request.stream, {
                contentLength,
              })
              .pipe(Effect.orDie);

            for (const tag of tags) {
              yield* kv.put(`tag:${project}:${tag}`, resourceId);
            }

            yield* kv.put(
              `metadata:${resourceId}`,
              JSON.stringify({ project, tags, expiresAt }),
            );

            const store = packages.getByName(resourceId);
            yield* store.init(tags, expiresAt).pipe(Effect.orDie);

            return yield* HttpServerResponse.json({
              resourceId,
              project,
              tags,
              ttl: ttlStr,
              expiresAt,
            });
          }).pipe(
            Effect.catchTag("Unauthorized", () =>
              HttpServerResponse.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            ),
          );
        }

        // --- GET /projects/:pkgName/tags/:tag ---
        if (method === "GET" && subPath.startsWith("/tags/")) {
          const tag = decodeURIComponent(subPath.slice("/tags/".length));
          const resourceId = yield* kv.get(`tag:${project}:${tag}`);
          if (!resourceId) {
            return yield* HttpServerResponse.json(
              { error: "tag not found" },
              { status: 404 },
            );
          }

          const store = packages.getByName(resourceId);
          yield* store.recordDownload(tag).pipe(Effect.orDie);

          const encodedProject = project
            .split("/")
            .map(encodeURIComponent)
            .join("/");
          return HttpServerResponse.fromWeb(
            new Response(null, {
              status: 302,
              headers: {
                location: `/projects/${encodedProject}/packages/${resourceId}`,
              },
            }),
          );
        }

        // --- GET /projects/:pkgName/packages/:resourceId ---
        if (
          method === "GET" &&
          subPath.startsWith("/packages/") &&
          !subPath.endsWith("/stats")
        ) {
          const resourceId = subPath.slice("/packages/".length);
          const object = yield* r2.get(resourceId + ".tgz").pipe(Effect.orDie);
          if (!object) {
            return yield* HttpServerResponse.json(
              { error: "resource not found" },
              { status: 404 },
            );
          }

          const body = yield* object.arrayBuffer().pipe(Effect.orDie);
          return HttpServerResponse.fromWeb(
            new Response(body, {
              status: 200,
              headers: {
                "content-type": "application/gzip",
                "cache-control": "public, max-age=31536000, immutable",
              },
            }),
          );
        }

        // --- DELETE /projects/:pkgName/tags/:tag ---
        if (method === "DELETE" && subPath.startsWith("/tags/")) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const tag = decodeURIComponent(subPath.slice("/tags/".length));
            const resourceId = yield* kv.get(`tag:${project}:${tag}`);
            if (!resourceId) {
              return yield* HttpServerResponse.json(
                { error: "tag not found" },
                { status: 404 },
              );
            }

            const store = packages.getByName(resourceId);
            const { orphaned } = yield* store.removeTag(tag).pipe(Effect.orDie);

            yield* kv.delete(`tag:${project}:${tag}`);

            if (orphaned) {
              yield* r2.delete(resourceId + ".tgz").pipe(Effect.orDie);
              yield* kv.delete(`metadata:${resourceId}`);
            }

            return yield* HttpServerResponse.json({ ok: true });
          }).pipe(
            Effect.catchTag("Unauthorized", () =>
              HttpServerResponse.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            ),
          );
        }

        // --- GET /projects/:pkgName/packages/:resourceId/stats ---
        if (
          method === "GET" &&
          subPath.startsWith("/packages/") &&
          subPath.endsWith("/stats")
        ) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const resourceId = subPath.slice(
              "/packages/".length,
              -"/stats".length,
            );
            const meta = yield* kv.get(`metadata:${resourceId}`);
            if (!meta) {
              return yield* HttpServerResponse.json(
                { error: "resource not found" },
                { status: 404 },
              );
            }

            const store = packages.getByName(resourceId);
            const stats = yield* store.getStats().pipe(Effect.orDie);

            return yield* HttpServerResponse.json(stats);
          }).pipe(
            Effect.catchTag("Unauthorized", () =>
              HttpServerResponse.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            ),
          );
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catch((error: any) =>
          Effect.succeed(
            HttpServerResponse.text(
              `Internal Server Error: ${error?.message ?? error?._tag ?? String(error)}`,
              { status: 500 },
            ),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(bindings));
