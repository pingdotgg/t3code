import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/drizzle-workflow/stack.ts";
import type { Widget } from "./fixtures/drizzle-workflow/schema.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

interface WorkflowStatus {
  status: string;
  output?: {
    inserted: Widget;
    rowCount: number;
    widget: Widget | null;
  };
  error?: { message?: string } | null;
}

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

// Start a fresh workflow instance and poll until it reaches a terminal state.
const runToCompletion = (baseUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    // Fresh workers.dev edge takes a few seconds to start serving 200s.
    const startRes = yield* client.post(`${baseUrl}/workflow/start/1`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady =>
          e instanceof WorkerNotReady && e.status >= 400 && e.status < 600,
        schedule: Schedule.max([
          Schedule.exponential("500 millis"),
          Schedule.recurs(15),
        ]),
      }),
    );
    const { instanceId } = (yield* startRes.json) as { instanceId: string };
    expect(instanceId).toBeTypeOf("string");

    const last = yield* client
      .get(`${baseUrl}/workflow/status/${instanceId}`)
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new WorkerNotReady({ status: res.status })),
        ),
        Effect.flatMap((res) => res.json),
        Effect.map((json) => json as unknown as WorkflowStatus),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (s) => s.status === "complete" || s.status === "errored",
          times: 30,
        }),
      );
    if (last.status !== "complete") {
      return yield* Effect.fail(
        new Error(`workflow ${last.status}: ${JSON.stringify(last.error)}`),
      );
    }
    return last;
  });

/**
 * End-to-end regression guard for the ExecutionContext-in-Workflow fix
 * (PR #515): deploy a Neon project + branch, point a Cloudflare Hyperdrive
 * at it, host a Workflow that runs `Drizzle.Postgres` queries inside `task`
 * steps, fire an instance over HTTP, and assert the run completes with the
 * row it wrote.
 *
 * Before the fix the query inside the step dies on a missing
 * `ExecutionContext` service and the run reports `errored` with no output.
 */
test(
  "Drizzle.Postgres query runs inside a Workflow task (per-run scope provided by the bridge)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");
    const baseUrl = url.replace(/\/+$/, "");

    const last = yield* runToCompletion(baseUrl).pipe(
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
    );

    expect(last.status).toBe("complete");
    expect(last.error).toBeFalsy();
    expect(last.output?.rowCount).toBe(1);
    expect(last.output?.widget).toMatchObject({ id: 1, name: "widget-1" });
    expect(last.output?.inserted).toMatchObject({ id: 1, name: "widget-1" });
  }).pipe(logLevel),
  { timeout: 600_000 },
);

/**
 * Cross-request regression guard for the build-once bridge: the isolate
 * builds its layers on the first event and reuses them; each fetch event
 * builds its own pg pool against its per-event scope and closes it after the
 * response. Sequential requests must not touch a prior event's pool
 * ("Cannot use a pool after calling end on the pool") and concurrent
 * requests must not share I/O objects across request contexts ("Cannot
 * perform I/O on behalf of a different request").
 */
test(
  "Drizzle.Postgres queries survive sequential and concurrent fetch events",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");
    const client = yield* HttpClient.HttpClient;

    const query = (id: number) =>
      Effect.gen(function* () {
        const res = yield* client.get(`${baseUrl}/query/${id}`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new WorkerNotReady({ status: res.status })),
          ),
          Effect.retry({
            while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
            schedule: Schedule.max([
              Schedule.exponential("500 millis"),
              Schedule.recurs(10),
            ]),
          }),
        );
        return (yield* res.json) as { rowCount: number };
      }).pipe(Effect.orDie);

    // Sequential: the second event must not observe the first event's
    // (already closed) pool.
    const first = yield* query(1);
    const second = yield* query(1);
    expect(first.rowCount).toBeTypeOf("number");
    expect(second.rowCount).toBeTypeOf("number");

    // Concurrent: every event acquires its own pool on its own scope.
    const results = yield* Effect.all(
      [1, 2, 3, 4, 5, 6].map((id) => query(id)),
      { concurrency: "unbounded" },
    );
    for (const body of results) {
      expect(body.rowCount).toBeTypeOf("number");
    }
  }).pipe(logLevel),
  { timeout: 600_000 },
);
