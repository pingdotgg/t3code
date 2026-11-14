import type {
  ArtifactsError,
  ReadNamespaceClient,
} from "@alchemy.run/cloudflare/Artifacts/ReadWriteNamespace";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Routes over the read-only {@link ReadNamespaceClient}: repo metadata, commit
 * history and Git object reads. Every route takes `?name=` for the repo.
 *
 * - `GET /get`                 — `{ found, code }`; `code` is the platform error code
 * - `GET /info`                — `{ name, defaultBranch }`
 * - `GET /log?ref=&limit=`     — `CommitMetadata[]`
 * - `GET /read-commit?hash=`   — `CommitMetadata | null`
 * - `GET /read-tree?hash=`     — `TreeEntry[] | null`
 * - `GET /read-blob?hash=`     — `{ text } | null`
 * - `GET /read-file?ref=&path=` — `{ text, type } | null`
 *
 * A failed call returns a 500 carrying the error's `message` and `code`, so
 * the test's readiness retry rides out a repo that is still importing.
 */
export const artifactsReadRoutes = (client: ReadNamespaceClient, url: URL) =>
  Effect.gen(function* () {
    const params = url.searchParams;
    const name = params.get("name") ?? "";
    const hash = params.get("hash") ?? "";
    const failWith = (error: { message: string; code?: string }) =>
      HttpServerResponse.json({ error: error.message, code: error.code }, { status: 500 });
    const blobJson = (blob: Blob | null) =>
      blob === null
        ? Effect.succeed(null)
        : Effect.promise(() => blob.text()).pipe(Effect.map((text) => ({ text, type: blob.type })));

    if (url.pathname === "/get") {
      return yield* client.get(name).pipe(
        Effect.flatMap(() => HttpServerResponse.json({ found: true })),
        Effect.catchTag("ArtifactsError", (e) =>
          HttpServerResponse.json({ found: false, code: e.code }),
        ),
      );
    }

    const respond = <A>(effect: Effect.Effect<A, ArtifactsError, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((value) => HttpServerResponse.json(value)),
        Effect.catchTag("ArtifactsError", failWith),
      );
    const repo = client.get(name);

    if (url.pathname === "/info") {
      return yield* respond(
        repo.pipe(
          Effect.flatMap((repo) => repo.info()),
          Effect.map((info) => ({ name: info.name, defaultBranch: info.defaultBranch })),
        ),
      );
    }

    if (url.pathname === "/log") {
      return yield* respond(
        repo.pipe(
          Effect.flatMap((repo) =>
            repo.log({
              ref: params.get("ref") ?? undefined,
              limit: params.has("limit") ? Number(params.get("limit")) : undefined,
            }),
          ),
        ),
      );
    }

    if (url.pathname === "/read-commit") {
      return yield* respond(repo.pipe(Effect.flatMap((repo) => repo.readCommit(hash))));
    }

    if (url.pathname === "/read-tree") {
      return yield* respond(repo.pipe(Effect.flatMap((repo) => repo.readTree(hash))));
    }

    if (url.pathname === "/read-blob") {
      return yield* respond(
        repo.pipe(
          Effect.flatMap((repo) => repo.readBlob(hash)),
          Effect.flatMap(blobJson),
        ),
      );
    }

    if (url.pathname === "/read-file") {
      return yield* respond(
        repo.pipe(
          Effect.flatMap((repo) =>
            repo.readFile({ ref: params.get("ref") ?? "", path: params.get("path") ?? "" }),
          ),
          Effect.flatMap(blobJson),
        ),
      );
    }

    return undefined;
  });
