/**
 * The Git host with its bytes on S3 (DESIGN §22): the same building-block
 * assembly as `stack.ts`, with `BlobStoreS3(GitObjects)` in place of R2. Needs BOTH
 * provider sets — the bucket is an `AWS.S3.Bucket` and the Worker binds
 * the S3 operations cross-cloud (an IAM identity is minted for it).
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  BlobStoreS3,
  GIT_WORKER_OPTIONS,
  ApiHandlersLive,
  HasherInline,
  ReposDurableObject,
  RegistryDurableObject,
} from "@alchemy.run/git";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { TestRoutes } from "./http.ts";
import { TEST_SECRET, TestApi, TestAuthLive } from "./stack.ts";
export { TEST_SECRET };

/** Declared here so the stack tears it down with the packs still inside. */
export const GitObjects = AWS.S3.Bucket("GitS3Objects", { forceDestroy: true });

const GitLive = TestRoutes.pipe(
  Layer.provide(ApiHandlersLive),
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherInline),
  Layer.provide(BlobStoreS3(GitObjects)),
);

export default class S3GitHost extends Cloudflare.Worker<S3GitHost>()(
  "GitS3Worker",
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

export const makeS3TestStack = (name: string) =>
  Alchemy.Stack(
    name,
    {
      providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
      state: Cloudflare.state(),
    },
    Effect.gen(function* () {
      const host = yield* S3GitHost;
      return { url: host.url.as<string>() };
    }),
  );
