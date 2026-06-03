import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import D1Worker from "./d1-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * Wrap an HTTP call so a non-2xx response (workers.dev cold-start
 * "There is nothing here yet" / "Script not found" pages) becomes a
 * retryable Effect failure rather than a successful response with a
 * 404/500 status.
 */
const retryUntilOk = <E, R>(
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
      while: (e): e is WorkerNotReady =>
        e instanceof WorkerNotReady && e.status >= 400 && e.status < 600,
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(15)),
      ),
    }),
  );

/**
 * End-to-end test of `Cloudflare.D1Connection.bind(...)` against a real
 * Cloudflare Worker + D1 database.
 *
 * Stack:
 *
 * - `D1WorkerDatabase` (Cloudflare.D1Database).
 * - `D1EffectWorker` — uses `Cloudflare.D1Connection.bind(database)` in
 *   the init phase, with `Cloudflare.D1ConnectionLive` provided to the
 *   worker effect.
 *
 * The worker exposes routes that exercise every method on the
 * `D1ConnectionClient`: `exec`, `prepare` + `.run/.all/.first`,
 * `batch`, and the `raw` Effect that resolves to the underlying
 * Cloudflare D1Database. The test hits those routes over HTTP and
 * asserts the round-trip succeeds — proving the binding name agreed
 * upon by the deploy-time policy and the runtime lookup match, and
 * the Cloudflare runtime actually injected the binding into `env`.
 */
test.provider(
  "D1Connection.bind exercises the full client surface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* D1Worker;
        }),
      );

      expect(worker.url).toBeTypeOf("string");
      const baseUrl = worker.url as string;

      // Cloudflare's edge takes a few seconds to start serving a fresh
      // workers.dev URL — initial requests can return Cloudflare's
      // "There is nothing here yet" 404 page. Retry until /init returns
      // 200, then use the same retry once for the warm-up before
      // running the rest of the surface area assertions in a
      // straight line.
      const initRes = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/init`),
      ).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text.pipe(Effect.as(res))
            : res.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(new WorkerNotReady({ status: res.status, body })),
                ),
              ),
        ),
        Effect.retry({
          while: (e): e is WorkerNotReady =>
            e instanceof WorkerNotReady && e.status >= 400 && e.status < 600,
          schedule: Schedule.exponential("500 millis").pipe(
            Schedule.both(Schedule.recurs(20)),
          ),
        }),
      );
      expect(initRes.status).toBe(200);
      // db.exec returns a count + duration. We don't assert exact
      // values (CREATE TABLE IF NOT EXISTS may report 0 statements
      // executed on a re-run), only that the response shape parses.
      const initBody = (yield* initRes.json) as {
        count: number;
        duration: number;
      };
      expect(typeof initBody.count).toBe("number");
      expect(typeof initBody.duration).toBe("number");

      // batch-insert via prepare.bind. Edge propagation can still serve a
      // transient 404 between routes on a fresh URL, so retry until the
      // route handler responds 200.
      const seedRes = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/seed`),
      ).pipe(
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
          while: (e): e is WorkerNotReady =>
            e instanceof WorkerNotReady && e.status >= 400 && e.status < 600,
          schedule: Schedule.exponential("500 millis").pipe(
            Schedule.both(Schedule.recurs(15)),
          ),
        }),
      );
      expect(seedRes.status).toBe(200);
      expect(yield* seedRes.json).toMatchObject({ batches: 3, success: true });

      // single insert via prepare.bind.run
      const insertRes = yield* retryUntilOk(
        HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/users`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ id: 4, name: "dave" }),
          ),
        ),
      );
      expect(insertRes.status).toBe(200);
      expect(yield* insertRes.json).toMatchObject({
        success: true,
        meta: { changes: 1 },
      });

      // SELECT all via prepare.all
      const allRes = yield* retryUntilOk(HttpClient.get(`${baseUrl}/users`));
      expect(allRes.status).toBe(200);
      const allBody = (yield* allRes.json) as {
        success: boolean;
        results: Array<{ id: number; name: string }>;
      };
      expect(allBody.success).toBe(true);
      expect(allBody.results).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
        { id: 3, name: "carol" },
        { id: 4, name: "dave" },
      ]);

      // SELECT one via prepare.bind.first
      const oneRes = yield* retryUntilOk(HttpClient.get(`${baseUrl}/users/2`));
      expect(oneRes.status).toBe(200);
      expect(yield* oneRes.json).toEqual({ row: { id: 2, name: "bob" } });

      // raw escape hatch (used by Better Auth / Drizzle integrations)
      const rawRes = yield* retryUntilOk(HttpClient.get(`${baseUrl}/raw`));
      expect(rawRes.status).toBe(200);
      expect(yield* rawRes.json).toEqual({ count: 4 });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
