import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  CloneToken,
  CreateRepoResponse,
  Metadata,
  RepoApi,
  RepoConflict,
  RepoInfo,
  RepoNotFound,
} from "./Api.ts";
import Repo from "./Repo.ts";
import { Repos } from "./Repos.ts";

// Workers don't have a FileSystem, so HttpPlatform's file-response surface
// is stubbed. The repo API never serves files.
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export default class Worker extends Cloudflare.Worker<Worker>()(
  "Api",
  {
    main: import.meta.filename,
    observability: { enabled: true },
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const artifacts = yield* Cloudflare.Artifacts.bind(Repos);
    const repos = yield* Repo;

    const findRepo = (name: string) =>
      artifacts.list({ limit: 100 }).pipe(
        Effect.flatMap((res) => {
          const found = res.repos.find(
            (r: { name: string }) => r.name === name,
          );
          return found
            ? Effect.succeed(found)
            : Effect.fail(new RepoNotFound({ name }));
        }),
        Effect.catchTag("ArtifactsError", () =>
          Effect.fail(new RepoNotFound({ name })),
        ),
      );

    const handlers = HttpApiBuilder.group(RepoApi, "repos", (h) =>
      h
        .handle("createRepo", ({ payload }) =>
          artifacts
            .create(payload.name, {
              description: payload.description,
              setDefaultBranch: "main",
            })
            .pipe(
              Effect.tap(() =>
                repos
                  .getByName(payload.name)
                  .init(payload.description ?? "")
                  .pipe(Effect.orDie),
              ),
              Effect.map(
                (c) =>
                  new CreateRepoResponse({
                    name: c.name,
                    remote: c.remote,
                    token: c.token,
                    defaultBranch: c.defaultBranch,
                  }),
              ),
              Effect.catchTag("ArtifactsError", (err) =>
                Effect.fail(new RepoConflict({ message: err.message })),
              ),
            ),
        )
        .handle("getRepo", ({ params }) =>
          findRepo(params.name).pipe(
            Effect.flatMap((found) =>
              repos
                .getByName(params.name)
                .get()
                .pipe(
                  Effect.catch(() => Effect.succeed(null)),
                  Effect.map(
                    (meta) =>
                      new RepoInfo({
                        id: found.id,
                        name: found.name,
                        description: found.description ?? null,
                        defaultBranch: found.defaultBranch,
                        remote: found.remote,
                        status: found.status,
                        readOnly: found.readOnly,
                        createdAt: found.createdAt,
                        updatedAt: found.updatedAt,
                        lastPushAt: found.lastPushAt ?? null,
                        metadata: meta ? new Metadata(meta) : null,
                      }),
                  ),
                ),
            ),
          ),
        )
        .handle("updateRepo", ({ params, payload }) =>
          findRepo(params.name).pipe(
            Effect.flatMap(() =>
              repos
                .getByName(params.name)
                .update({
                  description: payload.description,
                  topics: payload.topics ? [...payload.topics] : undefined,
                })
                .pipe(Effect.orDie),
            ),
            Effect.map((m) => new Metadata(m)),
          ),
        )
        .handle("deleteRepo", ({ params }) =>
          artifacts.delete(params.name).pipe(
            Effect.asVoid,
            Effect.catchTag("ArtifactsError", () =>
              Effect.fail(new RepoNotFound({ name: params.name })),
            ),
          ),
        )
        .handle("starRepo", ({ params }) =>
          findRepo(params.name).pipe(
            Effect.flatMap(() =>
              repos.getByName(params.name).star().pipe(Effect.orDie),
            ),
            Effect.map((m) => new Metadata(m)),
          ),
        )
        .handle("cloneToken", ({ params, payload }) =>
          artifacts.get(params.name).pipe(
            Effect.flatMap((handle) =>
              handle.createToken(payload.scope ?? "read", payload.ttl ?? 3600),
            ),
            Effect.map(
              (t) =>
                new CloneToken({
                  id: t.id,
                  plaintext: t.plaintext,
                  scope: t.scope as "read" | "write",
                  expiresAt: t.expiresAt,
                }),
            ),
            Effect.catchTag("ArtifactsError", () =>
              Effect.fail(new RepoNotFound({ name: params.name })),
            ),
          ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(RepoApi).pipe(
        Layer.provide(handlers),
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.ArtifactsBindingLive))),
) {}
