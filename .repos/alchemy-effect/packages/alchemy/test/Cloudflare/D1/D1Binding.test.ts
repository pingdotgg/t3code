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

// Bounded spaced schedule — caps total wait so a genuine failure surfaces
// fast instead of an uncapped exponential blowing past the test timeout
// while riding out fresh-workers.dev cold-start propagation.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(45)]);

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

class RowsMismatch extends Data.TaggedError("RowsMismatch")<{
  actual: string;
}> {}

const retryRows = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.retry({
      while: (e: E) => e instanceof RowsMismatch,
      schedule: ready,
    }),
  );

/**
 * Drive the full D1 client surface against ONE deployed worker over `fetch`:
 * `exec` (/init) → `batch` (/seed) → `prepare.bind.run` (/users POST) →
 * `prepare.bind.all` (/users GET) → `prepare.bind.first` (/users/:id) →
 * `raw` (/raw). Both workers share one physical database; each stamps its
 * rows with a distinct `style`, so the row-count assertions stay independent.
 */
const exercise = (base: string) =>
  Effect.gen(function* () {
    // exec — CREATE TABLE. Don't assert exact count (0 on a re-run), only shape.
    const initRes = yield* untilOk(
      HttpClient.execute(HttpClientRequest.post(`${base}/init`)),
    );
    const initBody = (yield* initRes.json) as {
      count: number;
      duration: number;
    };
    expect(typeof initBody.count).toBe("number");
    expect(typeof initBody.duration).toBe("number");

    // batch — three inserts in one transactional call.
    const seedRes = yield* untilOk(
      HttpClient.execute(HttpClientRequest.post(`${base}/seed`)),
    );
    expect(yield* seedRes.json).toMatchObject({ batches: 3, success: true });

    // prepare.bind.run — single insert.
    const insertRes = yield* untilOk(
      HttpClient.execute(
        HttpClientRequest.post(`${base}/users`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ id: 4, name: "dave" }),
        ),
      ),
    );
    expect(yield* insertRes.json).toMatchObject({
      success: true,
      meta: { changes: 1 },
    });

    // prepare.all — SELECT all rows for this style. D1 read-after-write is
    // eventually consistent across edge locations, so retry until all four
    // seeded/inserted rows are visible.
    const expected = [
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
      { id: 3, name: "carol" },
      { id: 4, name: "dave" },
    ];
    const allBody = yield* untilOk(HttpClient.get(`${base}/users`)).pipe(
      Effect.flatMap((res) => res.json),
      Effect.flatMap((body) => {
        const b = body as {
          success: boolean;
          results: Array<{ id: number; name: string }>;
        };
        return b.results.length === expected.length
          ? Effect.succeed(b)
          : Effect.fail(
              new RowsMismatch({ actual: JSON.stringify(b.results) }),
            );
      }),
      retryRows,
    );
    expect(allBody.success).toBe(true);
    expect(allBody.results).toEqual(expected);

    // prepare.bind.first — SELECT one row.
    const oneRes = yield* untilOk(HttpClient.get(`${base}/users/2`));
    expect(yield* oneRes.json).toEqual({ row: { id: 2, name: "bob" } });

    // raw — direct runtime D1Database access (the Better Auth / Drizzle hatch).
    // Retry until the count reflects all four rows (eventual consistency).
    const rawBody = yield* untilOk(HttpClient.get(`${base}/raw`)).pipe(
      Effect.flatMap((res) => res.json),
      Effect.flatMap((body) => {
        const b = body as { count: number };
        return b.count === expected.length
          ? Effect.succeed(b)
          : Effect.fail(new RowsMismatch({ actual: JSON.stringify(b) }));
      }),
      retryRows,
    );
    expect(rawBody.count).toBe(4);
  });

/**
 * End-to-end test of `Cloudflare.D1.QueryDatabase(...)` against a real
 * Cloudflare Worker + D1 database, covering BOTH invocation styles against
 * one shared database:
 *
 * - effect-worker: `yield* Cloudflare.D1.QueryDatabase(db)` in Init with
 *   `Cloudflare.D1.QueryDatabaseBinding` provided to the worker effect;
 * - async-worker: the database declared on the Worker `env` (resolved to the
 *   native `cf.D1Database` via `InferEnv`) and used from a plain async fetch.
 *
 * The stack lives in `fixtures/stack.ts` so it can also be inspected directly,
 * e.g. `alchemy tail --stage test ./test/Cloudflare/D1/fixtures/stack.ts`.
 */
const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

// ── effect-worker ── `yield* Cloudflare.D1.QueryDatabase(db)` + ConnectionBinding.
test(
  "effect-worker: QueryDatabase exercises the full client surface",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise(out.effectWorkerUrl);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

// ── async-worker ── D1 declared on `env`, native `env.DB` used from async fetch.
test(
  "async-worker: env-declared D1 binding exercises the full surface",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise(out.asyncWorkerUrl);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);
