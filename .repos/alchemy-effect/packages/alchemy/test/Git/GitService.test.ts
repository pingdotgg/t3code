/**
 * Tier-2 deployed REST lifecycle suite (DESIGN.md §9): drives the typed
 * `HttpApiClient` against a real Cloudflare deployment of the git-service
 * stack. Deterministic repo names with a pre-test purge (delete-if-exists),
 * bounded edge-propagation retries on first contact, `NO_DESTROY=1` keeps
 * the deployment for local iteration.
 *
 * The full wire-protocol coverage lives in `GitProtocol.e2e.test.ts`; the
 * local dev-mode mirror of this suite is `GitService.local.test.ts`.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { GitApi, type Oid } from "@/Git/Api.ts";
import { makeTestStack, TEST_SECRET } from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = makeTestStack("GitServiceTestStack");

// ── edge readiness ──────────────────────────────────────────────────────────

/**
 * A fresh Cloudflare deploy is eventually consistent across PoPs: retry
 * transport failures and the 404/5xx window, but never a decoded domain
 * error (those are the assertions).
 */
const edgeRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("10 seconds"),
    Effect.retry({
      while: (error: unknown) =>
        (error as { _tag?: string })._tag === "TimeoutError" ||
        ((error as { _tag?: string })._tag === "HttpClientError" &&
          (!(error as { response?: { status: number } }).response ||
            (error as { response: { status: number } }).response.status ===
              404 ||
            (error as { response: { status: number } }).response.status >=
              500)),
      schedule: Schedule.spaced("1500 millis"),
      times: 40,
    }),
  );

const makeClient = (url: string, token: string) =>
  HttpApiClient.make(GitApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(HttpClientRequest.bearerToken(token)),
    ),
  });

const asOid = (oid: string): Oid => oid as Oid;

const expectTag = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  tag: string,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe(tag);
      return result.failure;
    }
    return yield* Effect.die("unreachable");
  });

/**
 * Delete-if-exists and wait until the name is free again (delete is an async
 * purge: `status: "deleting"` → 404). Keeps repo names deterministic across
 * runs without leaking 409s from interrupted prior runs.
 */
const purgeRepo = Effect.fn(function* (
  url: string,
  owner: string,
  repo: string,
) {
  const admin = yield* makeClient(url, TEST_SECRET);
  yield* admin.repos
    .delete({ params: { owner, repo } })
    .pipe(Effect.catchTag("RepoNotFound", () => Effect.void));
  yield* admin.repos.get({ params: { owner, repo } }).pipe(
    Effect.as(false),
    Effect.catchTag("RepoNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 60,
    }),
  );
});

// Warm the deployment through the edge-propagation window once, so tests can
// call the API directly.
const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        const admin = yield* makeClient(url, TEST_SECRET);
        yield* admin.repos.list({ query: {} }).pipe(edgeRetry);
      }),
    ),
    logLevel,
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "repo lifecycle: create → read back → 409 → patch → delete → 404",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);
    yield* purgeRepo(url, "e2e", "rest-lifecycle");

    const created = yield* admin.repos.create({
      payload: { owner: "e2e", name: "rest-lifecycle", description: "tier2" },
    });
    expect(created.repo.status).toBe("ready");
    expect(created.repo.defaultBranch).toBe("main");
    expect(created.remote).toContain("/e2e/rest-lifecycle.git");

    // readable immediately after create (one-round-trip design goal)
    const read = yield* admin.repos.get({
      params: { owner: "e2e", repo: "rest-lifecycle" },
    });
    expect(read.repoId).toBe(created.repo.repoId);

    yield* expectTag(
      admin.repos.create({ payload: { owner: "e2e", name: "rest-lifecycle" } }),
      "RepoAlreadyExists",
    );

    const patched = yield* admin.repos.update({
      params: { owner: "e2e", repo: "rest-lifecycle" },
      payload: { description: "updated", readOnly: true },
    });
    expect(patched.description).toBe("updated");
    expect(patched.readOnly).toBe(true);

    // list-all (admin only) sees it
    const listed = yield* admin.repos.list({ query: { owner: "e2e" } });
    expect(listed.items.some((repo) => repo.name === "rest-lifecycle")).toBe(
      true,
    );

    // refs are empty on a fresh repo
    const refs = yield* admin.refs.list({
      params: { owner: "e2e", repo: "rest-lifecycle" },
      query: {},
    });
    expect(refs.refs).toEqual([]);

    // delete → NoContent now, async purge → typed 404
    yield* admin.repos.delete({
      params: { owner: "e2e", repo: "rest-lifecycle" },
    });
    const gone = yield* admin.repos
      .get({ params: { owner: "e2e", repo: "rest-lifecycle" } })
      .pipe(
        Effect.map((repo) => ({ deleted: false, status: repo.status })),
        Effect.catchTag("RepoNotFound", () =>
          Effect.succeed({ deleted: true as const, status: undefined }),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (state) => state.deleted,
          times: 45,
        }),
      );
    expect(gone.deleted).toBe(true);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "REST ref writes: typed ObjectNotFound / ReadOnlyRepo / RefNotFound on an empty repo",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);
    yield* purgeRepo(url, "e2e", "rest-refs");
    yield* admin.repos.create({ payload: { owner: "e2e", name: "rest-refs" } });
    const params = { owner: "e2e", repo: "rest-refs" };

    // pointing a ref at an object the repo does not have → typed 404
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/main" },
        payload: { newOid: asOid("f".repeat(40)) },
      }),
      "ObjectNotFound",
    );

    // readOnly wins over everything else on the write path
    yield* admin.repos.update({ params, payload: { readOnly: true } });
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/main" },
        payload: { newOid: asOid("f".repeat(40)) },
      }),
      "ReadOnlyRepo",
    );
    yield* admin.repos.update({ params, payload: { readOnly: false } });

    // reads of missing refs/objects decode as the tagged classes
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/heads/main" } }),
      "RefNotFound",
    );
    yield* expectTag(
      admin.objects.commit({
        params: { ...params, oid: asOid("e".repeat(40)) },
      }),
      "ObjectNotFound",
    );
    yield* expectTag(
      admin.repos.get({ params: { owner: "e2e", repo: "never-created" } }),
      "RepoNotFound",
    );

    yield* admin.repos.delete({ params });
  }).pipe(logLevel),
  { timeout: 120_000 },
);
