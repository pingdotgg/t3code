import * as HttpRouter from "effect/unstable/http/HttpRouter";
/**
 * Shared test-stack fixture for the git-service suites (DESIGN.md §9).
 *
 * git-service ships no Worker of its own — the package exports building
 * blocks (`ApiLive`, `ApiHandlersLive`, `ReposDurableObject`,
 * `RegistryDurableObject`, …) that users assemble into their own
 * `Cloudflare.Worker`. This fixture is exactly that assembly: the same
 * shape the example app and the RFC's headline snippet use.
 *
 * Every suite deploys under its own stack name so concurrently-running
 * suites never share (or race on) a deployment.
 *
 * The suites authenticate with two shared secrets, resolved by the
 * user-land middleware in `test-auth.ts`; the engine sees no credential.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  ApiHandlersLive,
  HasherInline,
  ReposDurableObject,
  RegistryDurableObject,
} from "@/Git/index.ts";
import { TestRoutes } from "./http.ts";
import { TestApi, TestAuthLive, TestCaller } from "./test-auth.ts";

export {
  TEST_SECRET,
  TEST_SECRET_DEV,
  TEST_USER,
  TEST_USER_DEV,
  TestApi,
  TestAuthLive,
} from "./test-auth.ts";

/** The suites' bucket — owned by the assembly, like any user's. */
const GitObjects = Cloudflare.R2.Bucket("GitObjects", {
  // Test stacks must tear down even with packs/bundles/head snapshots
  // still in the bucket (the e2e benches leave repos behind by design).
  forceDestroy: true,
});

/** Storage and implementation layers for the application router. */
const GitLive = TestRoutes.pipe(
  Layer.provide(ApiHandlersLive),
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  // In-process hashing: service-binding fan-out runs on the caller's
  // thread on Workers (DESIGN §22.10), so the simpler layer is the reference.
  Layer.provide(HasherInline),
  Layer.provide(BlobStoreR2(GitObjects)),
);

/** The suites' git host: the reference building-block assembly. */
export default class TestGitHost extends Cloudflare.Worker<TestGitHost>()(
  "GitWorker",
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

/**
 * Builds the deployable test stack under a suite-specific name.
 *
 * @example
 * ```typescript
 * const Stack = makeTestStack("GitServiceTestStack");
 * const stack = beforeAll(deploy(Stack));
 * afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
 * ```
 */
export const makeTestStack = (name: string) =>
  Alchemy.Stack(
    name,
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const host = yield* TestGitHost;
      return { url: host.url.as<string>() };
    }),
  );
