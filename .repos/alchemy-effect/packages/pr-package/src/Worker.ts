import * as Cloudflare from "alchemy/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
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
import {
  tarballId,
  tarballKey,
  tarballRef,
  type TarballRef,
} from "./Tarball.ts";

class Unauthorized {
  readonly _tag = "Unauthorized";
}

export interface HandlerOptions extends AliasParserOptions {
  /** Default TTL when Alchemy-TTL is not provided while assigning tags. e.g. "3 weeks". */
  defaultTtl?: string;
}

const bindings = Layer.mergeAll(
  Cloudflare.R2.ReadWriteBucketBinding,
  Cloudflare.KV.ReadWriteNamespaceBinding,
  Cloudflare.SecretsStore.ReadSecretBinding,
);

const encodedProject = (project: string) =>
  project.split("/").map(encodeURIComponent).join("/");

const parseTarballPath = (subPath: string) => {
  const match = subPath.match(/^\/packages\/([a-f0-9]{64})(\/stats)?$/);
  if (!match) return undefined;
  return {
    hash: match[1]!,
    stats: match[2] !== undefined,
  };
};

const parseTags = (raw: string | undefined) => {
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((tag) => typeof tag === "string" && tag.length > 0)
  ) {
    return undefined;
  }
  return [...new Set(value)];
};

/**
 * Init effect for a pr-package worker. Pass as the third argument to
 * `Cloudflare.Worker<X>()(...)` in your stack file.
 *
 * The user's stack file must be the worker entry (`main: import.meta.url`)
 * because `parseAliasUrl` is a closure that has to live in the bundle.
 */
export const handler = (options: HandlerOptions = {}) =>
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(yield* Bucket);
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(yield* TagIndex);
    const authToken = yield* Cloudflare.SecretsStore.ReadSecret(
      yield* AuthToken,
    );
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
          if (
            !authHeader ||
            authHeader !== `Bearer ${Redacted.value(expected)}`
          ) {
            return yield* Effect.fail(new Unauthorized());
          }
        });

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

        const projectMatch = path.match(
          /^\/projects\/((?:@|%40)[^/]+\/[^/]+|[^/]+)(\/.*)?$/i,
        );
        if (!projectMatch) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const project = decodeURIComponent(projectMatch[1]);
        const subPath = projectMatch[2] || "/";
        const content = parseTarballPath(subPath);

        // Content is addressed by package and SHA-256. Repeated CI runs can
        // probe this route and avoid sending bytes.
        if (
          content &&
          !content.stats &&
          (method === "HEAD" || method === "PUT")
        ) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;
            const ref = tarballRef(project, content.hash);
            const key = tarballKey(ref);
            const existing = yield* r2.head(key).pipe(Effect.orDie);

            if (method === "HEAD") {
              return HttpServerResponse.empty({
                status: existing ? 200 : 404,
              });
            }

            const contentLength = Number(
              request.headers["content-length"] ?? 0,
            );
            if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
              return yield* HttpServerResponse.json(
                { error: "Content-Length must be a positive integer" },
                { status: 400 },
              );
            }

            if (existing && existing.size !== contentLength) {
              return yield* HttpServerResponse.json(
                { error: "Content-Length does not match the existing tarball" },
                { status: 400 },
              );
            }

            if (!existing) {
              yield* r2
                .put(key, request.stream, {
                  contentLength,
                  sha256: Uint8Array.from(content.hash.match(/../g)!, (byte) =>
                    Number.parseInt(byte, 16),
                  ),
                })
                .pipe(Effect.orDie);
            }

            return yield* HttpServerResponse.json({
              package: project,
              hash: content.hash,
              size: existing?.size ?? contentLength,
              uploaded: !existing,
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

        // Tags are lightweight pointers to a content-addressed tarball.
        if (method === "PUT" && subPath === "/tags") {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            let tags: string[] | undefined;
            try {
              tags = parseTags(request.headers["alchemy-tags"]);
            } catch {
              tags = undefined;
            }
            if (!tags) {
              return yield* HttpServerResponse.json(
                {
                  error:
                    "Alchemy-Tags must be a non-empty JSON array of strings",
                },
                { status: 400 },
              );
            }

            const hash = request.headers["alchemy-tarball-hash"];
            if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
              return yield* HttpServerResponse.json(
                { error: "Alchemy-Tarball-Hash (sha256) is required" },
                { status: 400 },
              );
            }

            const ref = tarballRef(project, hash);
            const id = tarballId(ref);
            const object = yield* r2.head(tarballKey(ref)).pipe(Effect.orDie);
            if (!object) {
              return yield* HttpServerResponse.json(
                { error: "tarball not found" },
                { status: 404 },
              );
            }

            const ttlStr = request.headers["alchemy-ttl"] || defaultTtl;
            const ttlDuration = Duration.fromInput(ttlStr as Duration.Input);
            if (ttlDuration._tag === "None") {
              return yield* HttpServerResponse.json(
                {
                  error: "Alchemy-TTL must be an Effect Duration string",
                },
                { status: 400 },
              );
            }
            const ttlMillis = Duration.toMillis(ttlDuration.value);
            if (ttlMillis <= 0) {
              return yield* HttpServerResponse.json(
                { error: "Alchemy-TTL must be a positive duration" },
                { status: 400 },
              );
            }
            const expiresAt = Date.now() + ttlMillis;

            for (const tag of tags) {
              const oldId = yield* kv.get(`tag:${project}:${tag}`);
              if (oldId && oldId !== id) {
                const oldRef = JSON.parse(oldId) as TarballRef;
                const oldStore = packages.getByName(oldId);
                const { orphaned } = yield* oldStore
                  .removeTag(tag)
                  .pipe(Effect.orDie);
                if (orphaned) {
                  yield* r2.delete(tarballKey(oldRef)).pipe(Effect.orDie);
                }
              }
            }

            for (const tag of tags) {
              yield* kv.put(`tag:${project}:${tag}`, id);
            }

            const store = packages.getByName(id);
            yield* store
              .init(project, hash, tags, expiresAt)
              .pipe(Effect.orDie);

            return yield* HttpServerResponse.json({
              package: project,
              hash,
              size: object.size,
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

        if (method === "GET" && subPath.startsWith("/tags/")) {
          const tag = decodeURIComponent(subPath.slice("/tags/".length));
          const id = yield* kv.get(`tag:${project}:${tag}`);
          if (!id) {
            return yield* HttpServerResponse.json(
              { error: "tag not found" },
              { status: 404 },
            );
          }

          const [packageName, hash] = JSON.parse(id) as TarballRef;
          if (packageName !== project) {
            return yield* HttpServerResponse.json(
              { error: "tag points to another package" },
              { status: 500 },
            );
          }

          const store = packages.getByName(id);
          yield* store.recordDownload(tag).pipe(Effect.orDie);

          return HttpServerResponse.fromWeb(
            new Response(null, {
              status: 302,
              headers: {
                location: `/projects/${encodedProject(project)}/packages/${hash}`,
              },
            }),
          );
        }

        if (method === "GET" && content && !content.stats) {
          const object = yield* r2
            .get(tarballKey(tarballRef(project, content.hash)))
            .pipe(Effect.orDie);
          if (!object) {
            return yield* HttpServerResponse.json(
              { error: "tarball not found" },
              { status: 404 },
            );
          }

          const body = yield* object.arrayBuffer().pipe(Effect.orDie);
          return HttpServerResponse.fromWeb(
            new Response(body, {
              status: 200,
              headers: {
                "content-type": "application/gzip",
                "content-length": String(object.size),
                "cache-control": "public, max-age=31536000, immutable",
              },
            }),
          );
        }

        if (method === "DELETE" && subPath.startsWith("/tags/")) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;

            const tag = decodeURIComponent(subPath.slice("/tags/".length));
            const id = yield* kv.get(`tag:${project}:${tag}`);
            if (!id) {
              return yield* HttpServerResponse.json(
                { error: "tag not found" },
                { status: 404 },
              );
            }

            const ref = JSON.parse(id) as TarballRef;
            const store = packages.getByName(id);
            const { orphaned } = yield* store.removeTag(tag).pipe(Effect.orDie);

            yield* kv.delete(`tag:${project}:${tag}`);
            if (orphaned) {
              yield* r2.delete(tarballKey(ref)).pipe(Effect.orDie);
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

        if (method === "GET" && content?.stats) {
          return yield* Effect.gen(function* () {
            yield* requireAuth;
            const ref = tarballRef(project, content.hash);
            const object = yield* r2.head(tarballKey(ref)).pipe(Effect.orDie);
            if (!object) {
              return yield* HttpServerResponse.json(
                { error: "tarball not found" },
                { status: 404 },
              );
            }

            const store = packages.getByName(tarballId(ref));
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
