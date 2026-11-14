/**
 * The Git host with its pack hasher on AWS Lambda (DESIGN §22.11): the
 * same building-block assembly as `stack.ts`, with `HasherLambda` in place
 * of the in-process hasher. Needs BOTH provider sets — the Worker binds
 * `InvokeFunction` cross-cloud (an IAM identity is minted for it).
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  ApiHandlersLive,
  ReposDurableObject,
  RegistryDurableObject,
} from "@alchemy.run/git";
import { HasherFunction, HasherLambda } from "@alchemy.run/git/Hasher";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { TestRoutes } from "./http.ts";
import { TEST_SECRET, TestApi, TestAuthLive } from "./stack.ts";
export { TEST_SECRET };

const GitObjects = Cloudflare.R2.Bucket("GitLambdaObjects", {
  forceDestroy: true,
});

const GitLive = TestRoutes.pipe(
  Layer.provide(ApiHandlersLive),
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherLambda(HasherFunction)),
  Layer.provide(AWS.Lambda.InvokeFunctionHttp),
  Layer.provide(BlobStoreR2(GitObjects)),
);

export default class LambdaGitHost extends Cloudflare.Worker<LambdaGitHost>()(
  "GitLambdaWorker",
  {
    main: import.meta.url,
    ...GIT_WORKER_OPTIONS,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const fetch = yield* HttpRouter.toHttpEffect(GitLive);
    return { fetch };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}

export const makeLambdaTestStack = (name: string) =>
  Alchemy.Stack(
    name,
    {
      providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
      state: Cloudflare.state(),
    },
    Effect.gen(function* () {
      const host = yield* LambdaGitHost;
      return { url: host.url.as<string>() };
    }),
  );
