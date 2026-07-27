import type { ReadWriteNamespaceClient } from "@/Cloudflare/Artifacts/ReadWriteNamespace.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared routes that exercise every method of {@link ReadWriteNamespaceClient} over
 * `fetch`. The same routes back both the Effect-native worker (which yields
 * `Cloudflare.Artifacts.ReadWriteNamespace(...)`) and — by mirroring the logic in plain
 * async/await — the async worker, so both invocation styles drive the exact
 * same behavior against one shared namespace.
 *
 * Routes:
 * - `POST /create?name=` — create a repo, returns `{ name, remote, hasToken }`
 * - `GET  /list`         — list repos, returns `{ names: string[], total }`
 * - `GET  /get?name=`    — fetch a repo handle, returns `{ found: boolean }`
 * - `DELETE /delete?name=` — delete a repo, returns `{ deleted: boolean }`
 *
 * Returns `undefined` for unknown paths so the worker shell can 404.
 */
export const artifactsRoutes = (client: ReadWriteNamespaceClient, url: URL) =>
  Effect.gen(function* () {
    const name = url.searchParams.get("name") ?? "";

    if (url.pathname === "/create") {
      const repo = yield* client
        .create(name, { setDefaultBranch: "main" })
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        name: repo.name,
        remote: repo.remote,
        defaultBranch: repo.defaultBranch,
        hasToken: typeof repo.token === "string" && repo.token.length > 0,
      });
    }

    if (url.pathname === "/list") {
      const result = yield* client.list().pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        names: result.repos.map((r) => r.name),
        total: result.total,
      });
    }

    if (url.pathname === "/get") {
      const found = yield* client.get(name).pipe(
        Effect.as(true),
        Effect.catchTag("ArtifactsError", () => Effect.succeed(false)),
      );
      return yield* HttpServerResponse.json({ found });
    }

    if (url.pathname === "/delete") {
      const deleted = yield* client.delete(name).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ deleted });
    }

    return undefined;
  });
