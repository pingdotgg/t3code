import { expect } from "@alchemy.run/test";
import type * as Test from "@alchemy.run/test/Alchemy";
import type { Status } from "alchemy/Workflows";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";

class NotReady extends Data.TaggedError("NotReady")<{ readonly message: string }> {}

type RunStatus = Status<unknown, unknown>;

/** A deployed conformance fixture (see `app.ts`), and what its engine promises. */
export interface Engine {
  /** The file's `test`, from `Test.make`. */
  readonly test: Test.TestApi["test"];
  /** The fixture's base URL, once it serves. */
  readonly url: Effect.Effect<string>;
  /** The longest four one-second sleeps in a row may take, start to finish. */
  readonly napsWithinMillis: number;
  /**
   * The longest a run whose activity dies twice, then sleeps a second, may
   * take, for an engine whose retry timing it owns. Unset, only the outcome
   * is checked.
   */
  readonly recoveryWithinMillis?: number;
  /** Each case's timeout. */
  readonly timeout: number;
  /**
   * What the platform can't do, each with part of the defect the engine dies
   * with: a case checks the engine says so clearly rather than hanging.
   */
  readonly unsupported?: {
    /** `Activity.raceAll` / `DurableDeferred.raceAll`. */
    readonly raceAll?: string;
  };
}

/**
 * Register the cases every workflow engine passes, against a deployed fixture
 * serving `app` over `WorkflowsLive`.
 */
export const conformance = (engine: Engine) => {
  const { test, timeout } = engine;

  const request = <T>(path: string, method: "GET" | "POST" = "GET") =>
    Effect.gen(function* () {
      const target = `${yield* engine.url}${path}`;
      const client = HttpClient.mapRequest(
        yield* HttpClient.HttpClient,
        HttpClientRequest.setHeaders({ connection: "close", "cache-control": "no-cache" }),
      );
      const response = yield* method === "POST" ? client.post(target) : client.get(target);
      const body = yield* response.text;
      if (response.status !== 200) {
        return yield* new NotReady({ message: `${method} ${target}: ${response.status}: ${body}` });
      }
      return (body.startsWith("{") || body.startsWith("[") ? JSON.parse(body) : body) as T;
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "NotReady",
        schedule: Schedule.spaced("1 second"),
        times: 10,
      }),
    );

  /** Start a run, and return how to read and drive it. */
  const start = (workflow: string, id: string, query = "") =>
    Effect.map(
      request<{ executionId: string }>(`/start/${workflow}/${id}${query}`, "POST"),
      ({ executionId }) => {
        const run = `/${workflow}/${id}?executionId=${executionId}`;
        return {
          executionId,
          status: request<RunStatus>(`/status${run}`),
          approve: (by: string) => request(`/approve${run}&by=${by}`, "POST"),
          interrupt: request(`/interrupt${run}`, "POST"),
          resume: request(`/resume${run}`, "POST"),
        };
      },
    );

  /** Read a status until the run is finished. */
  const awaitResult = (status: Effect.Effect<RunStatus, unknown, HttpClient.HttpClient>) =>
    status.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (current) => current._tag !== "Running" && current._tag !== "NotStarted",
        times: Math.ceil(timeout / 1_000),
      }),
    );

  const journal = (id: string) => request<string[]>(`/journal/${id}`);

  /** Read a journal until it has `count` entries. */
  const awaitJournal = (id: string, count: number) =>
    journal(id).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (entries) => entries.length >= count,
        times: 60,
      }),
    );

  /** A fresh id per run, so a retried case never reads an earlier attempt's journal. */
  const freshId = (prefix: string) =>
    Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

  test(
    "runs a workflow and returns its result",
    Effect.gen(function* () {
      const id = yield* freshId("greet");
      const run = yield* start("Greet", id, "?name=sam");
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "hello sam" });
      expect(yield* journal(id)).toEqual(["greet", "log"]);
    }),
    { timeout },
  );

  test(
    "starting the same execution twice runs it once",
    Effect.gen(function* () {
      const id = yield* freshId("twice");
      const first = yield* start("Greet", id);
      const second = yield* start("Greet", id);
      expect(second.executionId).toBe(first.executionId);
      expect(yield* awaitResult(first.status)).toEqual({
        _tag: "Completed",
        result: "hello world",
      });
      expect(yield* journal(id)).toEqual(["greet", "log"]);
    }),
    { timeout },
  );

  test(
    "a run that was never started reads as not started",
    Effect.gen(function* () {
      const id = yield* freshId("never");
      expect(yield* request<RunStatus>(`/status/Greet/${id}?executionId=${id}`)).toEqual({
        _tag: "NotStarted",
      });
    }),
    { timeout },
  );

  test(
    "sleeps durably between activities",
    Effect.gen(function* () {
      const id = yield* freshId("nap");
      const run = yield* start("Nap", id, "?seconds=3");
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "rested" });
      expect(yield* journal(id)).toEqual(["before", "after"]);
    }),
    { timeout },
  );

  test(
    "wakes on time after each of several sleeps",
    Effect.gen(function* () {
      const id = yield* freshId("naps");
      const started = yield* Clock.currentTimeMillis;
      const run = yield* start("Naps", id, "?seconds=1&count=4");
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "rested" });
      // A wake-up that inherited its predecessor's retry budget waits out a
      // backoff that doubles on every hop.
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(engine.napsWithinMillis);
      expect(yield* journal(id)).toEqual(["after"]);
    }),
    { timeout },
  );

  test(
    "waits for a signal from outside",
    Effect.gen(function* () {
      const id = yield* freshId("approve");
      const run = yield* start("Approve", id);
      // Suspended on the signal, having run only its first activity.
      yield* awaitJournal(id, 1);
      expect(yield* run.status).toEqual({ _tag: "Running" });
      yield* run.approve("agent");
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "approved by agent",
      });
      expect(yield* journal(id)).toEqual(["requested", "approved:agent"]);
    }),
    { timeout },
  );

  test(
    "a signal sent before the run waits for it completes the wait",
    Effect.gen(function* () {
      const id = yield* freshId("early");
      const run = yield* start("Approve", id);
      yield* run.approve("early");
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "approved by early",
      });
      expect(yield* journal(id)).toEqual(["requested", "approved:early"]);
    }),
    { timeout },
  );

  test(
    "a signal sent again, or after the run finished, changes nothing",
    Effect.gen(function* () {
      const id = yield* freshId("again");
      const run = yield* start("Approve", id);
      yield* awaitJournal(id, 1);
      yield* run.approve("first");
      yield* run.approve("second");
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "approved by first",
      });
      yield* run.approve("late");
      expect(yield* run.status).toEqual({ _tag: "Completed", result: "approved by first" });
      expect(yield* journal(id)).toEqual(["requested", "approved:first"]);
    }),
    { timeout },
  );

  test(
    "a typed failure runs compensations",
    Effect.gen(function* () {
      const id = yield* freshId("declined");
      const run = yield* start("Checkout", id, "?decline=true");
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Failed",
        error: { _tag: "Declined", reason: "card declined" },
      });
      expect(yield* journal(id)).toEqual(["reserve", "declined", "release"]);
    }),
    { timeout },
  );

  test(
    "a successful workflow keeps its steps",
    Effect.gen(function* () {
      const id = yield* freshId("charged");
      const run = yield* start("Checkout", id);
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "charged" });
      expect(yield* journal(id)).toEqual(["reserve", "charged"]);
    }),
    { timeout },
  );

  test(
    "a defect in an activity is the run's result, not retried",
    Effect.gen(function* () {
      const id = yield* freshId("crash");
      const run = yield* start("Crash", id);
      const status = yield* awaitResult(run.status);
      expect(status._tag).toBe("Died");
      // The defect's message survives, though one of its fields isn't JSON.
      expect(JSON.stringify(status)).toContain("boom: request timed out");
      expect(yield* journal(id)).toEqual(["crash"]);
    }),
    { timeout },
  );

  test(
    "retries a run whose activity dies, then wakes on time",
    Effect.gen(function* () {
      const id = yield* freshId("flaky");
      const started = yield* Clock.currentTimeMillis;
      const run = yield* start("Flaky", id, "?seconds=1");
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "recovered" });
      if (engine.recoveryWithinMillis !== undefined) {
        // A wake-up that inherited the failed runs' retry budget waits it out.
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(
          engine.recoveryWithinMillis,
        );
      }
      expect(yield* journal(id)).toEqual(["attempt", "attempt", "attempt", "after"]);
    }),
    { timeout },
  );

  test(
    "interrupting a waiting workflow runs its compensations",
    Effect.gen(function* () {
      const id = yield* freshId("hold");
      const run = yield* start("Hold", id);
      yield* awaitJournal(id, 1);
      yield* run.interrupt;
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Interrupted" });
      expect(yield* journal(id)).toEqual(["reserve", "release"]);
    }),
    { timeout },
  );

  test(
    "interrupting a workflow on its way to a wait runs its compensations",
    Effect.gen(function* () {
      const id = yield* freshId("hold-early");
      const run = yield* start("Hold", id);
      yield* run.interrupt;
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Interrupted" });
      expect(yield* journal(id)).toEqual(["reserve", "release"]);
    }),
    { timeout },
  );

  test(
    "interrupting a sleeping workflow finishes it",
    Effect.gen(function* () {
      const id = yield* freshId("sleeping");
      const run = yield* start("Nap", id, "?seconds=600");
      yield* awaitJournal(id, 1);
      yield* run.interrupt;
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Interrupted" });
      expect(yield* journal(id)).toEqual(["before"]);
    }),
    { timeout },
  );

  test(
    "interrupting a finished workflow changes nothing",
    Effect.gen(function* () {
      const id = yield* freshId("finished");
      const run = yield* start("Greet", id);
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "hello world",
      });
      yield* run.interrupt;
      expect(yield* run.status).toEqual({ _tag: "Completed", result: "hello world" });
    }),
    { timeout },
  );

  test(
    "a failure after a step runs its compensation",
    Effect.gen(function* () {
      const id = yield* freshId("abandoned");
      const run = yield* start("Checkout", id, "?abandon=true");
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Failed",
        error: { _tag: "Declined", reason: "abandoned" },
      });
      expect(yield* journal(id)).toEqual(["reserve", "release"]);
    }),
    { timeout },
  );

  test(
    "retries an activity's typed failure with Activity.retry",
    Effect.gen(function* () {
      const id = yield* freshId("retry");
      const run = yield* start("Retry", id);
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "succeeded on attempt 3",
      });
      expect(yield* journal(id)).toEqual(["attempt:1", "attempt:2", "attempt:3"]);
    }),
    { timeout },
  );

  test(
    "catches an activity's defect and carries on",
    Effect.gen(function* () {
      const id = yield* freshId("recover");
      const run = yield* start("Recover", id);
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "recovered" });
      expect(yield* journal(id)).toEqual(["fail", "recovered"]);
    }),
    { timeout },
  );

  test(
    "a run suspended on failure waits, then finishes once resumed",
    Effect.gen(function* () {
      const id = yield* freshId("suspends");
      const run = yield* start("Suspends", id);
      yield* awaitJournal(id, 2);
      yield* Effect.sleep("3 seconds");
      expect(yield* run.status).toEqual({ _tag: "Running" });
      expect(yield* journal(id)).toEqual(["reserve", "attempt"]);
      yield* run.resume;
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "resumed" });
      expect(yield* journal(id)).toEqual(["reserve", "attempt", "attempt"]);
    }),
    { timeout },
  );

  test(
    "interrupting a run suspended on failure runs its compensations",
    Effect.gen(function* () {
      const id = yield* freshId("suspends-interrupt");
      const run = yield* start("Suspends", id);
      yield* awaitJournal(id, 2);
      yield* run.interrupt;
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Interrupted" });
      // The replay that runs the compensations may run the failed activity
      // again first, as Effect's own engine does: it has no recorded result.
      const entries = yield* journal(id);
      expect(entries.filter((entry) => entry === "reserve")).toEqual(["reserve"]);
      expect(entries.filter((entry) => entry === "release")).toEqual(["release"]);
      expect(entries.at(-1)).toBe("release");
    }),
    { timeout },
  );

  test(
    "sleeps durably inside an activity and decodes its result",
    Effect.gen(function* () {
      const id = yield* freshId("wake-in-step");
      const started = yield* Clock.currentTimeMillis;
      const run = yield* start("WakeInStep", id, "?seconds=2");
      const status = yield* awaitResult(run.status);
      expect(status).toMatchObject({ _tag: "Completed" });
      // A DateTime, sent back as its ISO string: after the sleep, not before.
      const at = Date.parse((status as { result: string }).result);
      expect(at).toBeGreaterThanOrEqual(started + 2_000);
      expect(yield* journal(id)).toEqual(["woke", "decoded"]);
    }),
    { timeout },
  );

  test(
    "suspending runs finalizers and ensuring, never compensations or catchCause",
    Effect.gen(function* () {
      const id = yield* freshId("guarded");
      const run = yield* start("Guarded", id);
      yield* awaitJournal(id, 1);
      yield* run.approve("agent");
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "guarded for agent",
      });
      const entries = yield* journal(id);
      // Finalizers and `ensuring` run on every suspension and on completion.
      expect(entries).toContain("finalized");
      expect(entries).toContain("ensured");
      expect(entries.filter((entry) => entry === "reserve")).toEqual(["reserve"]);
      expect(entries.filter((entry) => entry === "done:agent")).toEqual(["done:agent"]);
      expect(entries).not.toContain("caught");
      expect(entries).not.toContain("release");
    }),
    { timeout },
  );

  test(
    "a race returns its first activity, and replays the same winner",
    Effect.gen(function* () {
      const id = yield* freshId("race");
      const run = yield* start("Race", id);
      const unsupported = engine.unsupported?.raceAll;
      if (unsupported !== undefined) {
        expect(yield* awaitResult(run.status)).toEqual({
          _tag: "Died",
          defect: expect.stringContaining(unsupported),
        });
        return;
      }
      yield* awaitJournal(id, 1);
      yield* run.approve("agent");
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "fast" });
      expect(yield* journal(id)).toEqual(["raced:fast"]);
    }),
    { timeout },
  );

  test(
    "a parent waits for a child that waits for a signal",
    Effect.gen(function* () {
      const id = yield* freshId("parent-waiting");
      const run = yield* start("ParentOfWaiting", id);
      yield* awaitJournal(`${id}-child`, 1);
      // Starting the child again finds the run the parent started.
      const child = yield* start("Approve", `${id}-child`);
      yield* child.approve("agent");
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "parent got approved by agent",
      });
      expect(yield* journal(`${id}-child`)).toEqual(["requested", "approved:agent"]);
      expect(yield* journal(id)).toEqual(["parent:approved by agent"]);
    }),
    { timeout },
  );

  test(
    "runs activities in parallel",
    Effect.gen(function* () {
      const id = yield* freshId("fanout");
      const run = yield* start("Fanout", id);
      expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: 6 });
      expect([...(yield* journal(id))].sort()).toEqual(["part:1", "part:2", "part:3"]);
    }),
    { timeout },
  );

  test(
    "a child's typed failure reaches its parent",
    Effect.gen(function* () {
      const id = yield* freshId("parent-failing");
      const run = yield* start("ParentOfFailing", id);
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "child card declined",
      });
      expect(yield* journal(`${id}-child`)).toEqual(["reserve", "declined", "release"]);
      expect(yield* journal(id)).toEqual(["parent:child card declined"]);
    }),
    { timeout },
  );

  test(
    "runs a child workflow",
    Effect.gen(function* () {
      const id = yield* freshId("parent");
      const run = yield* start("Parent", id);
      expect(yield* awaitResult(run.status)).toEqual({
        _tag: "Completed",
        result: "parent got hello child",
      });
      expect(yield* journal(`${id}-child`)).toEqual(["greet", "log"]);
      expect(yield* journal(id)).toEqual(["parent:hello child"]);
    }),
    { timeout },
  );
};
