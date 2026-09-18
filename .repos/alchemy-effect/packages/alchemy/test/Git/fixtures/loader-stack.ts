import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { TestRoutes } from "./http.ts";
/**
 * The Git host with its pack hasher on dynamically loaded Workers (DESIGN
 * §22.12): the same building-block assembly as `stack.ts`, with
 * `HasherWorkerLoader` in place of the in-process hasher.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  ApiHandlersLive,
  ReposDurableObject,
  RegistryDurableObject,
} from "@/Git/index.ts";
import { HasherWorkerLoader } from "@/Git/Hasher/index.ts";

import { TEST_SECRET, TestApi, TestAuthLive } from "./stack.ts";
export { TEST_SECRET };

const GitObjects = Cloudflare.R2.Bucket("GitLoaderObjects", {
  forceDestroy: true,
});

const GitLive = TestRoutes.pipe(
  Layer.provide(ApiHandlersLive),
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherWorkerLoader()),
  Layer.provide(BlobStoreR2(GitObjects)),
);

export default class LoaderGitHost extends Cloudflare.Worker<LoaderGitHost>()(
  "GitLoaderWorker",
  {
    main: import.meta.url,
    ...GIT_WORKER_OPTIONS,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const fetch = yield* HttpRouter.toHttpEffect(GitLive);
    return { fetch };
  }),
) {}

export const makeLoaderTestStack = (name: string) =>
  Alchemy.Stack(
    name,
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const host = yield* LoaderGitHost;
      return { url: host.url.as<string>() };
    }),
  );
