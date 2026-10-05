import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type {
  AlarmObservationResult,
  BatchResult,
  ExplicitRollbackResult,
  FailedBatchResult,
  RegistrationResult,
  RollbackResult,
  SiblingTransactionResult,
  Snapshot,
} from "./fixtures/alarm-callback/object.ts";
import makeStack from "./fixtures/alarm-callback/stack.ts";
import { inMemoryState } from "@/State";

const requestJson = <T>(
  url: string,
  method: "GET" | "POST",
  retryDelay: Duration.Input = "2 seconds",
) =>
  Effect.gen(function* () {
    const client = HttpClient.mapRequest(
      yield* HttpClient.HttpClient,
      HttpClientRequest.setHeaders({
        connection: "close",
        "cache-control": "no-cache",
      }),
    );
    const fresh = new URL(url);
    fresh.searchParams.set("cb", yield* Effect.sync(() => String(Date.now())));
    const response = yield* method === "POST"
      ? client.post(fresh.href)
      : client.get(fresh.href);
    const body = yield* response.text;
    if (response.status !== 200) {
      const message = `${method} ${url}: HTTP ${response.status}: ${body}`;
      if (
        response.status === 404 ||
        (response.status >= 500 &&
          (method === "GET" || body.includes("<title>Script not found |")))
      ) {
        return yield* Effect.fail(
          Object.assign(new Test.WorkerNotReady({ status: response.status }), {
            message,
            body,
            url,
          }),
        );
      }
      return yield* Effect.fail(new Error(message));
    }
    return yield* Effect.try({
      try: () => JSON.parse(body) as T,
      catch: () => new Error(`${method} ${url}: Invalid JSON: ${body}`),
    });
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.retry({
      while: (error) => error instanceof Test.WorkerNotReady,
      schedule: Schedule.spaced(retryDelay),
      times: 8,
    }),
  );

const json = <T>(url: string, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    if (method === "POST") {
      const snapshot = new URL(url);
      snapshot.pathname = snapshot.pathname.replace(
        /\/[^/]+$/,
        snapshot.pathname.endsWith("/legacy") ? "/legacy" : "/snapshot",
      );
      snapshot.search = "";
      yield* requestJson(snapshot.href, "GET");
    }
    return yield* requestJson<T>(url, method);
  });

const poll = <T>(
  url: string,
  until: (value: T) => boolean,
  interval: "2 seconds" | "4 seconds" = "2 seconds",
) =>
  json<T>(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(interval),
      until,
      times: 10,
    }),
    Effect.flatMap((snapshot) =>
      until(snapshot)
        ? Effect.succeed(snapshot)
        : Effect.fail(
            new Error(
              `Alarm polling exhausted for ${url}: ${JSON.stringify(snapshot)}`,
            ),
          ),
    ),
  );

const deliveries = (snapshot: Snapshot) =>
  snapshot.deliveries
    .map(({ callback, value }) => `${callback}:${value}`)
    .sort();

const drained = (count: number) => (snapshot: Snapshot) =>
  snapshot.deliveries.length === count && snapshot.alarm === null;

const assertRollback = (snapshot: Snapshot) => {
  expect(snapshot.application).toBeNull();
  expect(snapshot.cleanupWrite).toBeNull();
  expect(snapshot.rows).toEqual([]);
};

describe.concurrent.each([
  { dev: true, stage: "alarm-callback-local" },
  { dev: false, stage: "alarm-callback-live" },
])(
  "makeCallback (dev: $dev)",
  ({ dev, stage }) => {
    const state = dev ? inMemoryState() : Cloudflare.state();
    const Stack = makeStack(state);
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: Cloudflare.providers(),
      state,
      dev,
      stage,
    });

    const stack = beforeAll(
      Effect.gen(function* () {
        yield* destroy(Stack);
        const output = yield* deploy(Stack);
        yield* Effect.all([
          requestJson<Snapshot>(
            `${output.url}/readiness/snapshot`,
            "GET",
            "4 seconds",
          ),
          requestJson(`${output.url}/readiness/legacy`, "GET", "4 seconds"),
        ]).pipe(
          Effect.retry({
            while: Cause.isTimeoutError,
            schedule: Schedule.spaced("1 second"),
            times: 3,
          }),
        );
        expect(output.url.startsWith("http://localhost:")).toBe(dev);
        return output;
      }),
      { timeout: 120_000 },
    );
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
      timeout: 30_000,
    });

    test(
      "Worker callback registration stays unsupported after a Durable Object call",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const result = yield* json<
          RegistrationResult & { runtimeType: string }
        >(`${url}/worker-registration/worker-registration`, "POST");
        expect(result.snapshot.boots).toBeGreaterThan(0);
        expect(result.runtimeType).toBe("Cloudflare.Worker");
        expect(result.failure).toEqual({
          tag: "CallbackError",
          callback: "unsupported-worker",
          message: `Durable callbacks are not supported by ${result.runtimeType}`,
        });
        expect(result.snapshot.pendingJobs).toEqual([]);
        expect(result.snapshot.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "late DO registration defects without disabling initialized callbacks",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const base = `${url}/late-registration`;
        const rejected = yield* json<RegistrationResult>(
          `${base}/late-registration`,
          "POST",
        );
        expect(rejected.failure?.tag).toBe("CallbackError");
        expect(rejected.failure?.callback).toBe("late");
        expect(rejected.failure?.message).toContain("instance initialization");
        expect(rejected.snapshot.pendingJobs).toEqual([]);
        expect(rejected.snapshot.deliveries).toEqual([]);
        expect(rejected.snapshot.alarm).toBeNull();
        const scheduled = yield* json<Snapshot>(`${base}/timing`, "POST");
        expect(scheduled.id).toBe(rejected.snapshot.id);
        expect(scheduled.alarm).not.toBeNull();
        const delivered = yield* poll<Snapshot>(`${base}/snapshot`, drained(5));
        expect(delivered.id).toBe(rejected.snapshot.id);
        expect(deliveries(delivered)).toEqual([
          "archive:checkpoint",
          "archive:date",
          "archive:duration",
          "archive:latest",
          "secondary:other-callback",
        ]);
        expect(delivered.pendingJobs).toEqual([]);
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "batches native alarm bookkeeping across nested callbacks, legacy mutations, and finalizers",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const base = `${url}/bookkeeping`;
        const result = yield* json<BatchResult>(`${base}/bookkeeping`, "POST");
        yield* Effect.logInfo("Native alarm bookkeeping", result.counts);
        expect(result.counts).toEqual({
          schemaChecks: 1,
          reconciliations: 1,
          setAlarm: 1,
          deleteAlarm: 0,
        });
        expect(result.snapshot.pendingJobs).toHaveLength(3);
        expect(result.snapshot.alarm).not.toBeNull();
        const delivered = yield* poll<Snapshot>(`${base}/snapshot`, drained(3));
        expect(deliveries(delivered)).toEqual([
          "archive:batched",
          "archive:finalizer",
          "secondary:nested",
        ]);
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "batches native alarm deletion for repeated cancellation",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const result = yield* json<BatchResult>(
          `${url}/cancel-bookkeeping/cancel-bookkeeping`,
          "POST",
        );
        yield* Effect.logInfo("Native cancellation bookkeeping", result.counts);
        expect(result.counts).toEqual({
          schemaChecks: 1,
          reconciliations: 1,
          setAlarm: 0,
          deleteAlarm: 1,
        });
        expect(result.snapshot.pendingJobs).toEqual([]);
        expect(result.snapshot.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    for (const explicit of [true, false]) {
      test(
        `${explicit ? "explicit rollback" : "native reconciliation failure"} discards deferred bookkeeping and retries schema initialization`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          const operation = explicit
            ? "bookkeeping-rollback"
            : "bookkeeping-failure";
          const base = `${url}/${operation}`;
          const result = yield* json<FailedBatchResult>(
            `${base}/${operation}`,
            "POST",
          );
          if (explicit) expect(result.failure).toBeNull();
          else
            expect(result.failure).toContain(
              "no such table: alchemy_alarm_callbacks",
            );
          expect(result.rolledBack.counts).toEqual({
            schemaChecks: 1,
            reconciliations: explicit ? 0 : 1,
            setAlarm: 0,
            deleteAlarm: 0,
          });
          assertRollback(result.rolledBack.snapshot);
          expect(result.rolledBack.snapshot.pendingJobs).toEqual([]);
          expect(result.rolledBack.snapshot.alarm).toBeNull();
          expect(result.recovered.counts).toEqual({
            schemaChecks: 1,
            reconciliations: 1,
            setAlarm: 1,
            deleteAlarm: 0,
          });
          expect(result.recovered.snapshot.pendingJobs).toHaveLength(1);
          expect(result.recovered.snapshot.alarm).not.toBeNull();
          const delivered = yield* poll<Snapshot>(
            `${base}/snapshot`,
            drained(1),
          );
          expect(deliveries(delivered)).toEqual(["archive:recovered"]);
          assertRollback(delivered);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );
    }

    test(
      "preserves getAlarm observations and explicit native alarm write ordering in transactions",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const { at, observations, committed } =
          yield* json<AlarmObservationResult>(
            `${url}/alarm-observations/alarm-observations`,
            "POST",
          );
        expect(observations).toEqual([
          at,
          null,
          at + 1_000,
          at + 2_000,
          null,
          null,
        ]);
        expect(committed).toBe(at + 3_000);
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "native alarms deliver typed payloads, overwrite by callback and ID, and cancel",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const initial = yield* json<Snapshot>(`${url}/timing/timing`, "POST");
        expect(initial.alarm).not.toBeNull();
        const result = yield* poll<Snapshot>(
          `${url}/timing/snapshot`,
          drained(5),
        );
        expect(deliveries(result)).toEqual([
          "archive:checkpoint",
          "archive:date",
          "archive:duration",
          "archive:latest",
          "secondary:other-callback",
        ]);
        expect(result.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "commits application SQL, KV, and a scheduled callback in one transaction",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const initial = yield* json<{
          marker: string;
          legacyOverload: string;
          snapshot: Snapshot;
        }>(`${url}/atomic/atomic`, "POST");
        expect(initial.marker).toBe("committed");
        expect(initial.legacyOverload).toBe("callback");
        expect(initial.snapshot.application).toBe("committed");
        expect(initial.snapshot.rows).toEqual([{ value: "committed" }]);
        expect(initial.snapshot.alarm).not.toBeNull();
        const result = yield* poll<Snapshot>(
          `${url}/atomic/snapshot`,
          drained(1),
        );
        expect(result.deliveries).toEqual([
          {
            callback: "archive",
            value: "committed",
            application: "committed",
            boots: result.boots,
          },
        ]);
        expect(result.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "delivers a callback registered during transactional initialization",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const base = `${url}/transactional-registration`;
        const initial = yield* json<Snapshot>(
          `${base}/transactional-registration`,
          "POST",
        );
        expect(initial.pendingJobs).toHaveLength(1);
        expect(initial.pendingJobs[0]?.callback).toBe("transactional-init");
        expect(initial.alarm).not.toBeNull();
        const result = yield* poll<Snapshot>(`${base}/snapshot`, drained(1));
        expect(result.id).toBe(initial.id);
        expect(result.application).toBe("registered-in-transaction");
        expect(result.deliveries).toEqual([
          {
            callback: "transactional-init",
            value: "registered-in-transaction",
            application: "registered-in-transaction",
            boots: result.boots,
          },
        ]);
        expect(result.pendingJobs).toEqual([]);
        expect(result.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "rejects a pre-existing sibling fiber write during another fiber's transaction",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const result = yield* json<SiblingTransactionResult>(
          `${url}/sibling-transaction/sibling-transaction`,
          "POST",
        );
        expect(result.failure).toBe("sibling-rollback");
        expect(result.siblingAcknowledged).toBe(false);
        expect(result.siblingFailure?.tag).toBe("DurableObjectStorageError");
        expect(result.siblingValue).toBeNull();
        assertRollback(result.snapshot);
        expect(result.snapshot.pendingJobs).toEqual([]);
        expect(result.snapshot.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "explicit rollback rejects later storage writes and callback scheduling while repeated rollback succeeds",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const base = `${url}/rollback-explicit`;
        const result = yield* json<ExplicitRollbackResult>(
          `${base}/rollback-explicit`,
          "POST",
        );
        expect(result.repeatedRollbackSucceeded).toBe(true);
        expect(result.operations.map(({ operation }) => operation)).toEqual([
          "put",
          "sql",
          "schedule",
        ]);
        for (const operation of result.operations) {
          expect(operation.acknowledged).toBe(false);
          expect(operation.failure?.tag).toBe("DurableObjectStorageError");
          if (operation.operation !== "schedule") {
            expect(operation.failure?.wrappedBy).toBeNull();
          }
        }
        assertRollback(result.snapshot);
        expect(result.snapshot.deliveries).toEqual([]);
        expect(result.snapshot.pendingJobs).toEqual([]);
        expect(result.snapshot.alarm).toBeNull();
        const persisted = yield* json<Snapshot>(`${base}/snapshot`);
        assertRollback(persisted);
        expect(persisted.deliveries).toEqual([]);
        expect(persisted.pendingJobs).toEqual([]);
        expect(persisted.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    for (const [kind, failure] of [
      ["typed", "typed-value"],
      ["defect", "defect"],
      ["interrupt", "interrupted"],
    ] as const) {
      test(
        `${kind} failure rolls back SQL, KV, scheduling, cancellation, and the native wake`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          const base = `${url}/rollback-${kind}`;
          const result = yield* json<RollbackResult>(
            `${base}/rollback-${kind}`,
            "POST",
          );
          expect(result.failure).toBe(failure);
          expect(result.cleanupWaited).toBe(true);
          expect(result.alarmBefore).not.toBeNull();
          expect(result.alarmAfter).toBe(result.alarmBefore);
          assertRollback(result.snapshot);
          const after = yield* poll<Snapshot>(`${base}/snapshot`, drained(2));
          assertRollback(after);
          expect(deliveries(after)).toEqual([
            "archive:checkpoint",
            "archive:kept",
          ]);
          expect(after.alarm).toBeNull();
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );
    }

    test(
      "persists a recovery wake before a fallible handler and acknowledges only success",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* json(`${url}/retry/retry`, "POST");
        const result = yield* poll<Snapshot>(
          `${url}/retry/snapshot`,
          drained(1),
        );
        expect(deliveries(result)).toEqual(["retry:retried"]);
        expect(result.attempts).toHaveLength(2);
        for (const attempt of result.attempts) {
          expect(attempt.recovery).not.toBeNull();
          expect(attempt.recovery!).toBeGreaterThan(attempt.now);
        }
        expect(result.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "acknowledging a callback does not delete its same-ID replacement",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* json(`${url}/replacement/replace`, "POST");
        const result = yield* poll<Snapshot>(
          `${url}/replacement/snapshot`,
          drained(2),
        );
        expect(deliveries(result)).toEqual([
          "archive:replace-first",
          "archive:replace-second",
        ]);
        expect(result.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "reconstructs instance-local registrations after abort without mixing object IDs",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const [first, second] = yield* Effect.all(
          [
            json<Snapshot>(`${url}/reset-first/reset?value=first`, "POST"),
            json<Snapshot>(`${url}/reset-second/reset?value=second`, "POST"),
          ],
          { concurrency: "unbounded" },
        );
        expect(first.id).not.toBe(second.id);
        // Pending jobs must survive a delayed abort.
        yield* Effect.sleep("5 seconds");
        const aborted = yield* json<{ aborted: boolean }>(
          `${url}/reset-first/abort`,
          "POST",
        );
        expect(aborted.aborted).toBe(true);
        const reconstructed = yield* json<Snapshot>(
          `${url}/reset-first/snapshot`,
        );
        expect(reconstructed.boots).toBeGreaterThan(first.boots);
        expect(reconstructed.pendingJobs).toEqual(first.pendingJobs);
        expect(reconstructed.deliveries).toEqual([]);
        yield* Effect.all(
          [
            json<Snapshot>(`${url}/reset-first/release-pending`, "POST"),
            json<Snapshot>(`${url}/reset-second/release-pending`, "POST"),
          ],
          { concurrency: "unbounded" },
        );
        const [afterFirst, afterSecond] = yield* Effect.all(
          [
            poll<Snapshot>(`${url}/reset-first/snapshot`, drained(1)),
            poll<Snapshot>(`${url}/reset-second/snapshot`, drained(1)),
          ],
          { concurrency: "unbounded" },
        );
        expect(afterFirst.id).toBe(first.id);
        expect(afterFirst.boots).toBeGreaterThan(first.boots);
        expect(afterFirst.deliveries[0]?.boots).toBe(afterFirst.boots);
        expect(deliveries(afterFirst)).toEqual(["archive:first"]);
        expect(deliveries(afterSecond)).toEqual(["archive:second"]);
        expect(afterFirst.alarm).toBeNull();
        expect(afterSecond.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "recovers a callback after the handler aborts with native alarm retries enabled",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* json(`${url}/recovery/recovery`, "POST");
        const result = yield* poll<Snapshot>(
          `${url}/recovery/snapshot`,
          drained(1),
          "4 seconds",
        );
        yield* Effect.logInfo("Alarm crash recovery snapshot", result);
        expect(deliveries(result)).toEqual(["crash:recovered"]);
        expect(result.pendingJobs).toEqual([]);
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts[1]!.boots).toBeGreaterThan(
          result.attempts[0]!.boots,
        );
        for (const attempt of result.attempts) {
          expect(attempt.recovery).not.toBeNull();
          expect(attempt.recovery!).toBeGreaterThan(attempt.now);
        }
        expect(result.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "retains an aborted callback with native retries disabled and recovers after an explicit wake",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const base = `${url}/recovery-no-retry`;
        yield* json(`${base}/recovery-no-retry`, "POST");
        const retained = yield* poll<Snapshot>(
          `${base}/snapshot`,
          (snapshot) => snapshot.attempts.length > 0,
        );
        expect(retained.attempts[0]!.recovery).not.toBeNull();
        if (retained.deliveries.length === 0) {
          expect(retained.pendingJobs).toHaveLength(1);
          expect(retained.pendingJobs[0]!.callback).toBe("crash");
          expect(retained.pendingJobs[0]!.id).toBe("recovery");
          yield* json(`${base}/wake`, "POST");
        }
        const recovered = yield* poll<Snapshot>(`${base}/snapshot`, drained(1));
        expect(deliveries(recovered)).toEqual(["crash:recovered"]);
        expect(recovered.pendingJobs).toEqual([]);
        expect(recovered.attempts).toHaveLength(2);
        expect(recovered.attempts[1]!.boots).toBeGreaterThan(
          recovered.attempts[0]!.boots,
        );
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "retains an unknown callback until its registration is restored",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const initial = yield* json<Snapshot>(
          `${url}/unknown/optional`,
          "POST",
        );
        expect(initial.alarm).not.toBeNull();
        yield* Effect.sleep("5 seconds");
        expect(
          (yield* json<{ aborted: boolean }>(`${url}/unknown/abort`, "POST"))
            .aborted,
        ).toBe(true);
        const reconstructed = yield* json<Snapshot>(`${url}/unknown/snapshot`);
        expect(reconstructed.boots).toBeGreaterThan(initial.boots);
        expect(reconstructed.pendingJobs).toEqual(initial.pendingJobs);
        expect(reconstructed.deliveries).toEqual([]);
        const released = yield* json<Snapshot>(
          `${url}/unknown/release-pending`,
          "POST",
        );
        const pending = yield* poll<Snapshot>(
          `${url}/unknown/snapshot`,
          (value) => value.alarm !== null && value.alarm > released.alarm!,
        );
        expect(pending.boots).toBeGreaterThan(initial.boots);
        expect(pending.deliveries).toEqual([]);
        expect(pending.alarm).not.toBeNull();
        expect(pending.alarm!).toBeGreaterThan(released.alarm!);
        expect(pending.pendingJobs).toEqual(
          released.pendingJobs.map((job) => ({
            ...job,
            run_at: pending.alarm,
          })),
        );
        yield* json(`${url}/unknown/enable-optional`, "POST");
        expect(
          (yield* json<{ aborted: boolean }>(`${url}/unknown/abort`, "POST"))
            .aborted,
        ).toBe(true);
        const restored = yield* poll<Snapshot>(
          `${url}/unknown/snapshot`,
          drained(1),
          "4 seconds",
        );
        expect(deliveries(restored)).toEqual(["optional:retained"]);
        expect(restored.boots).toBeGreaterThan(pending.boots);
        expect(restored.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "drains a backlog over native alarm wakes without losing or duplicating jobs",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* json(`${url}/batch/batch`, "POST");
        const result = yield* poll<Snapshot>(
          `${url}/batch/snapshot`,
          drained(105),
        );
        expect(deliveries(result)).toEqual(
          Array.from({ length: 105 }, (_, i) => `archive:batch-${i}`).sort(),
        );
        expect(result.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );

    test(
      "legacy scheduling and its native alarm handler coexist with registered callbacks",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* json(`${url}/legacy/legacy`, "POST");
        const result = yield* poll<{
          registered: string | null;
          legacy: { id: string; payload: { value: string } }[];
          pending: unknown[];
          alarm: number | null;
        }>(
          `${url}/legacy/legacy`,
          (value) =>
            value.registered !== null &&
            value.legacy.length === 1 &&
            value.alarm === null,
        );
        expect(result.registered).toBe("registered");
        expect(result.legacy).toHaveLength(1);
        expect(result.legacy[0]?.id).toBe("shared-id");
        expect(result.legacy[0]?.payload).toEqual({ value: "legacy" });
        expect(result.pending).toEqual([]);
        expect(result.alarm).toBeNull();
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
    );
  },
  { tags: ["provider:cloudflare", "provider:cloudflare:worker"] },
);
