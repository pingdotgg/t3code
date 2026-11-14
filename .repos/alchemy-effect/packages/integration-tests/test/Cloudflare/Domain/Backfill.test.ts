import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { progressOf } from "@alchemy.run/cloudflare/Domain/Backfill";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import BenchV1 from "./fixtures/bench/v1.ts";
import BenchV2Short from "./fixtures/bench/v2-short.ts";
import BenchV2 from "./fixtures/bench/v2.ts";
import BenchV3 from "./fixtures/bench/v3.ts";
import LedgerV1 from "./fixtures/catch-up/v1.ts";
import LedgerV2WideBumped from "./fixtures/catch-up/v2-wide-bumped.ts";
import LedgerV2Wide from "./fixtures/catch-up/v2-wide.ts";
import LedgerV2 from "./fixtures/catch-up/v2.ts";

/**
 * How a deploy and a backfill behave together on Cloudflare: a deploy waits
 * for the backfill and reports its progress; it is safe to repeat, to time
 * out and to interrupt (the backfill runs on, and the next deploy waits on it);
 * a version bump rebuilds a view while its backfill runs; and removing a view
 * stops its backfill. Each case seeds accounts, then deploys views over them.
 */

const ACCOUNTS = 1000;
const EVENTS = 5;
// Ten accounts per request, many requests at once.
const SEED_BATCH = 10;

class NotYet extends Data.TaggedError("NotYet")<{
  readonly status: number;
  readonly body: string;
}> {}

const call = (url: string, method: "GET" | "POST", path: string) =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeaders({ connection: "close", "cache-control": "no-cache" }),
    ),
  ).pipe(
    Effect.flatMap((res) =>
      res.text.pipe(
        Effect.flatMap((body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotYet({ status: res.status, body })),
        ),
      ),
    ),
    Effect.timeout("2 minutes"),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
  );

const serving = (url: string, version: string) =>
  call(url, "GET", "/version").pipe(
    Effect.filterOrFail(
      (body) => body === version,
      (body) => new NotYet({ status: 200, body }),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );

/** Deploy accounts only, and give each of them its deposits. */
const seeded = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const { worker } = yield* stack.deploy(
      Effect.gen(function* () {
        return { worker: yield* BenchV1 };
      }),
    );
    const url = worker.url!.replace(/\/+$/, "");
    yield* serving(url, "v1");
    yield* Effect.forEach(
      Array.from({ length: ACCOUNTS / SEED_BATCH }, (_, i) => i * SEED_BATCH),
      (from) => call(url, "POST", `/seed/${from}/${SEED_BATCH}/${EVENTS}`),
      { concurrency: 32, discard: true },
    );
    return { url, workerName: worker.workerName };
  });

const deployOf = (stack: Test.ScratchStack, worker: typeof BenchV1) =>
  stack.deploy(
    Effect.gen(function* () {
      return { worker: yield* worker };
    }),
  );

/** The view's state for a few accounts: each has every deposit, once. */
const checkViews = (url: string) =>
  Effect.gen(function* () {
    const expected = Array.from({ length: EVENTS }, (_, n) => n + 1);
    for (const i of [0, ACCOUNTS / 2, ACCOUNTS - 1]) {
      const view = JSON.parse(yield* call(url, "GET", `/view/b${i}`)) as {
        amounts: Array<number>;
      } | null;
      expect(view?.amounts).toEqual(expected);
    }
    const history = JSON.parse(yield* call(url, "GET", "/history")) as { complete: boolean };
    expect(history.complete).toBe(true);
  });

/** Whether a deploy failed because the backfill outlasted its wait. */
const stillRunning = (deploy: Effect.Effect<unknown, unknown, never>) =>
  deploy.pipe(
    Effect.as(""),
    Effect.catchCause((cause) => Effect.succeed(String(cause))),
    Effect.map((failure) => /BackfillStillRunning|still running/.test(failure)),
  );

/** The latest completed instance of the Worker's backfill Workflow. */
const lastWait = (workerName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const all = yield* workflows.listWorkflows.items({ accountId }).pipe(Stream.runCollect);
    const workflow = [...all].find((w) => w.scriptName === workerName);
    expect(workflow).toBeDefined();
    const instances = yield* workflows.listInstances
      .items({ accountId, workflowName: workflow!.name, status: "complete" })
      .pipe(Stream.runCollect);
    const latest = [...instances].sort((a, b) => b.createdOn.localeCompare(a.createdOn))[0];
    expect(latest).toBeDefined();
    return yield* workflows.getInstance({
      accountId,
      workflowName: workflow!.name,
      instanceId: latest!.id,
    });
  });

const { test } = Test.make({ providers: Cloudflare.providers() });

describe.sequential("a deploy and its backfill", () => {
  test.provider(
    "a deploy waits for the backfill and reports its progress, and the same deploy again changes nothing",
    (stack) =>
      Effect.gen(function* () {
        const { url, workerName } = yield* seeded(stack);
        yield* deployOf(stack, BenchV2);
        yield* serving(url, "v2");
        yield* checkViews(url);

        // What the deploy reported as it waited: the run, done, over every account.
        const wait = yield* lastWait(workerName);
        const [run] = progressOf(wait.steps ?? []) ?? [];
        expect(run?.target).toBe("view:Deposits");
        expect(run?.phase).toBe("complete");
        expect(run?.done).toBe(run?.subtrees);
        expect(run?.instances).toBeGreaterThanOrEqual(ACCOUNTS);

        // The same model again: nothing to backfill, nothing to wait for.
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            return { worker: yield* BenchV2 };
          }),
        );
        expect(plan.resources["Ledger.DomainBackfillRun"]?.action).toBe("noop");

        yield* stack.destroy();
      }),
    { timeout: 900_000 },
  );

  test.provider(
    "a deploy that times out leaves the backfill running, and the next deploy waits for it",
    (stack) =>
      Effect.gen(function* () {
        const { url } = yield* seeded(stack);
        expect(yield* stillRunning(deployOf(stack, BenchV2Short))).toBe(true);
        yield* deployOf(stack, BenchV2);
        yield* serving(url, "v2");
        yield* checkViews(url);
        yield* stack.destroy();
      }),
    { timeout: 900_000 },
  );

  test.provider(
    "an interrupted deploy leaves the backfill running, and the next deploy waits for it",
    (stack) =>
      Effect.gen(function* () {
        const { url } = yield* seeded(stack);
        // Interrupt the deploy once the view's code is up and its backfill has begun.
        const deploy = yield* Effect.forkChild(deployOf(stack, BenchV2));
        yield* serving(url, "v2");
        yield* Fiber.interrupt(deploy);
        yield* deployOf(stack, BenchV2);
        yield* checkViews(url);
        yield* stack.destroy();
      }),
    { timeout: 900_000 },
  );

  test.provider(
    "a version bump while a backfill runs rebuilds the view from the history",
    (stack) =>
      Effect.gen(function* () {
        const { url } = yield* seeded(stack);
        expect(yield* stillRunning(deployOf(stack, BenchV2Short))).toBe(true);
        yield* deployOf(stack, BenchV3);
        yield* serving(url, "v3");
        yield* checkViews(url);
        yield* stack.destroy();
      }),
    { timeout: 900_000 },
  );

  test.provider(
    "removing a view while it backfills stops it, and adding it back rebuilds it",
    (stack) =>
      Effect.gen(function* () {
        const { url } = yield* seeded(stack);
        expect(yield* stillRunning(deployOf(stack, BenchV2Short))).toBe(true);
        yield* deployOf(stack, BenchV1);
        yield* serving(url, "v1");
        yield* deployOf(stack, BenchV3);
        yield* serving(url, "v3");
        yield* checkViews(url);
        yield* stack.destroy();
      }),
    { timeout: 900_000 },
  );

  test.provider(
    "a view that reads more sources without a version bump fails the deploy, and a bump rebuilds it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const ledger = (worker: typeof LedgerV1) =>
          stack.deploy(
            Effect.gen(function* () {
              return { worker: yield* worker };
            }),
          );
        const { worker } = yield* ledger(LedgerV1);
        const url = worker.url!.replace(/\/+$/, "");
        yield* serving(url, "v1");
        yield* call(url, "POST", "/deposit/a-1/10");
        yield* call(url, "POST", "/deposit/a-2/5");
        yield* ledger(LedgerV2);

        // The timeline's backfill read accounts only: the deploy refuses to wait on it.
        const refused = yield* ledger(LedgerV2Wide).pipe(
          Effect.as(""),
          Effect.catchCause((cause) => Effect.succeed(String(cause))),
        );
        expect(refused).toContain("Bump its version");

        yield* ledger(LedgerV2WideBumped);
        yield* serving(url, "v2-wide-bumped");
        const timeline = JSON.parse(yield* call(url, "GET", "/timeline")) as {
          entries: Array<string>;
        } | null;
        expect([...(timeline?.entries ?? [])].sort()).toEqual(["a-1:10", "a-2:5"]);
        yield* stack.destroy();
      }),
    { timeout: 900_000 },
  );
});
