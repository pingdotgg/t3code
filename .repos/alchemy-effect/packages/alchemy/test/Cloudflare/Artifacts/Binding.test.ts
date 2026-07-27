import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/stack.ts";

/**
 * Artifacts ("Git for agents") is a beta product whose native Worker binding +
 * implicit-namespace REST surface require the account to be onboarded to the
 * beta. The standing test account IS entitled, so this suite runs live by
 * default (verified green: deploy → create/list/get/delete round-trip → destroy
 * for both the effect-native and async invocation styles).
 *
 * If an account is NOT onboarded, repo creation is rejected at runtime; set
 * `CLOUDFLARE_TEST_ARTIFACTS=0` to skip the entire suite skip-clean on such an
 * account.
 */
const ARTIFACTS_ENABLED = process.env.CLOUDFLARE_TEST_ARTIFACTS !== "0";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

// Bounded spaced schedule — caps total cold-start wait so a real failure
// surfaces fast instead of riding to the vitest timeout.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]);

/** Retry an HTTP call until it returns 200 (rides out cold-start 404s). */
const untilOk = <E, R>(
  eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: ready,
    }),
  );

const body = <T>(res: HttpClientResponse.HttpClientResponse) =>
  res.json.pipe(Effect.map((b) => b as T));

const createRepo = (base: string, name: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.post(`${base}/create?name=${encodeURIComponent(name)}`),
    ),
  ).pipe(
    Effect.flatMap(
      body<{
        name: string;
        remote: string;
        defaultBranch: string;
        hasToken: boolean;
      }>,
    ),
  );

const listRepos = (base: string) =>
  untilOk(HttpClient.get(`${base}/list`)).pipe(
    Effect.flatMap(body<{ names: string[]; total: number }>),
  );

const getRepo = (base: string, name: string) =>
  untilOk(HttpClient.get(`${base}/get?name=${encodeURIComponent(name)}`)).pipe(
    Effect.flatMap(body<{ found: boolean }>),
  );

const deleteRepo = (base: string, name: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(
        `${base}/delete?name=${encodeURIComponent(name)}`,
      ),
    ),
  ).pipe(Effect.flatMap(body<{ deleted: boolean }>));

/**
 * Drive the full client surface over one worker base URL: create a repo,
 * confirm it shows up in `list` and `get`, then `delete` it and confirm it is
 * gone. `label` namespaces the repo so the two style-runs stay independent
 * against the one shared namespace.
 */
const exercise = (label: string, base: string) =>
  Effect.gen(function* () {
    const repo = `${label}-repo`;

    const created = yield* createRepo(base, repo);
    expect(created.name).toBe(repo);
    expect(created.defaultBranch).toBe("main");
    expect(created.remote).toContain("https://");
    expect(created.hasToken).toBe(true);

    const listed = yield* listRepos(base);
    expect(listed.names).toContain(repo);

    expect((yield* getRepo(base, repo)).found).toBe(true);

    expect((yield* deleteRepo(base, repo)).deleted).toBe(true);
    expect((yield* getRepo(base, repo)).found).toBe(false);
  });

// `beforeAll` has no `.skipIf`, so the deploy is gated inside the effect: when
// the Artifacts beta flag is unset, skip the (entitlement-blocked) deploy and
// return empty URLs. The tests below are `skipIf`-gated on the same flag, so
// they never read these placeholder URLs.
const stack = beforeAll(
  ARTIFACTS_ENABLED
    ? deploy(Stack)
    : Effect.succeed({ effectWorkerUrl: "", asyncWorkerUrl: "" }),
  { timeout: HOOK_TIMEOUT },
);
afterAll.skipIf(!ARTIFACTS_ENABLED || !!process.env.NO_DESTROY)(
  destroy(Stack),
  { timeout: HOOK_TIMEOUT },
);

// Effect-native worker: `Cloudflare.Artifacts.ReadWriteNamespace(Repos)` + `ReadWriteNamespaceBinding`.
test.skipIf(!ARTIFACTS_ENABLED)(
  "effect binding: create / list / get / delete round-trip",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("effect", out.effectWorkerUrl);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

// Async worker: namespace declared on `env: { REPOS }`, used from plain async fetch.
test.skipIf(!ARTIFACTS_ENABLED)(
  "async binding: create / list / get / delete round-trip",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("async", out.asyncWorkerUrl);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);
