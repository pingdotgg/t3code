/** The application's HTTP routes: our API and Git, with shared authentication. */
import * as Http from "alchemy/Http";

import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Layer from "effect/Layer";
import { AppApi, MeLive } from "./api.ts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { ProtocolLive } from "./protocol.ts";
import { RefsLive, PullsLive } from "./ref-writes.ts";
import { GitHubLive } from "./github.ts";
import { Authentication } from "./middleware.ts";

/** Packs, clone bundles, and spilled pushes. */
export const GitObjects = Cloudflare.R2.Bucket("GitObjects", {
  // `bun test` sets NODE_ENV=test: the integration test tears the stack
  // down with repositories still in the bucket.
  forceDestroy: process.env.NODE_ENV === "test",
});

const PublicRoutes = HttpApiBuilder.layer(AppApi).pipe(
  Layer.provide(
    Layer.mergeAll(
      MeLive,
      ProtocolLive,
      RefsLive,
      PullsLive,
      GitHubLive,
      HttpApiBuilder.group(AppApi, "repos", (h) =>
        Effect.map(Git.Handlers, (defaults) => h.handleAll(defaults.repos)),
      ),
      HttpApiBuilder.group(AppApi, "objects", (h) =>
        Effect.map(Git.Handlers, (defaults) => h.handleAll(defaults.objects)),
      ),
    ),
  ),
  Layer.provide(Authentication.layer),
);

export const HttpLive = Layer.mergeAll(PublicRoutes, Git.InternalApiLive).pipe(
  Layer.provide(Git.ApiHandlersLive),
  Layer.provide(Git.ReposDurableObject),
  Layer.provide(Git.RegistryDurableObject), // owner/name → repo
  Layer.provide(Git.HasherInline), // push verification in this Worker
  Layer.provide(Git.BlobStoreR2(GitObjects)), // packs, bundles, large pushes
  Layer.provide(Http.Platform),
);
