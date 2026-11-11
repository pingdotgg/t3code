import type { ReadWriteNamespaceClient } from "@alchemy.run/cloudflare/Artifacts/ReadWriteNamespace";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

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
 * - `POST /import?name=&url=&branch=` — shallow-import a public Git remote
 * - `POST /token?name=&scope=` — mint a repo token, returns `{ id, plaintext, remote }`
 * - `POST /revoke?name=&id=` — revoke a repo token, returns `{ revoked: boolean }`
 *
 * The import and token routes exist only on the Effect-native worker.
 *
 * Returns `undefined` for unknown paths so the worker shell can 404.
 */
export const artifactsRoutes = (client: ReadWriteNamespaceClient, url: URL) =>
  Effect.gen(function* () {
    const name = url.searchParams.get("name") ?? "";

    // Surface the typed ArtifactsError as a 500 with the message in the
    // body (instead of orDie's empty 500) so a failing test's
    // WorkerNotReady error says WHAT the binding rejected with.
    const failWith = (error: { message: string }) =>
      HttpServerResponse.json({ error: error.message }, { status: 500 });

    if (url.pathname === "/create") {
      return yield* client.create(name, { setDefaultBranch: "main" }).pipe(
        Effect.flatMap((repo) =>
          HttpServerResponse.json({
            name: repo.name,
            remote: repo.remote,
            defaultBranch: repo.defaultBranch,
            hasToken: typeof repo.token === "string" && repo.token.length > 0,
          }),
        ),
        Effect.catchTag("ArtifactsError", failWith),
      );
    }

    if (url.pathname === "/list") {
      return yield* client.list().pipe(
        Effect.flatMap((result) =>
          HttpServerResponse.json({
            names: result.repos.map((r) => r.name),
            total: result.total,
          }),
        ),
        Effect.catchTag("ArtifactsError", failWith),
      );
    }

    if (url.pathname === "/get") {
      const found = yield* client.get(name).pipe(
        Effect.as(true),
        Effect.catchTag("ArtifactsError", () => Effect.succeed(false)),
      );
      return yield* HttpServerResponse.json({ found });
    }

    if (url.pathname === "/delete") {
      return yield* client.delete(name).pipe(
        Effect.flatMap((deleted) => HttpServerResponse.json({ deleted })),
        Effect.catchTag("ArtifactsError", failWith),
      );
    }

    if (url.pathname === "/import") {
      return yield* client
        .import({
          source: {
            url: url.searchParams.get("url") ?? "",
            branch: url.searchParams.get("branch") ?? undefined,
            depth: 1,
          },
          target: { name },
        })
        .pipe(
          Effect.flatMap((repo) =>
            HttpServerResponse.json({ name: repo.name, defaultBranch: repo.defaultBranch }),
          ),
          Effect.catchTag("ArtifactsError", failWith),
        );
    }

    if (url.pathname === "/token") {
      const scope = url.searchParams.get("scope") === "write" ? "write" : "read";
      return yield* client.get(name).pipe(
        Effect.flatMap((repo) => Effect.all([repo.createToken(scope, 600), repo.info()])),
        Effect.flatMap(([token, info]) =>
          HttpServerResponse.json({
            id: token.id,
            plaintext: token.plaintext,
            remote: info.remote,
          }),
        ),
        Effect.catchTag("ArtifactsError", failWith),
      );
    }

    if (url.pathname === "/revoke") {
      return yield* client.get(name).pipe(
        Effect.flatMap((repo) => repo.revokeToken(url.searchParams.get("id") ?? "")),
        Effect.flatMap((revoked) => HttpServerResponse.json({ revoked })),
        Effect.catchTag("ArtifactsError", failWith),
      );
    }

    return undefined;
  });
