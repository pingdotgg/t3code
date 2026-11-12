import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { daily, every, Tick, webhook, WebhookRequest } from "./triggers.ts";
import { signal, start, store } from "./stepServices.ts";
import { invoke, sleep, step, stop, title, wait, workflow } from "./workflow.ts";
import { type AgentResult, WorkflowAgentError, WorkflowAgents } from "./WorkflowAgents.ts";
import Migration0092 from "../persistence/Migrations/092_Workflows.ts";
import Migration0093 from "../persistence/Migrations/093_WorkflowTriggers.ts";
import Migration0094 from "../persistence/Migrations/094_WorkflowStepEnvironment.ts";
import Migration0095 from "../persistence/Migrations/095_WorkflowRunInput.ts";
import Migration0096 from "../persistence/Migrations/096_WorkflowStore.ts";
import Migration0097 from "../persistence/Migrations/097_WorkflowRunParent.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import { agent, ask } from "./workflowAgent.ts";
import * as Workflows from "./Workflows.ts";
import type { WorkflowRun, WorkflowRunStatus } from "./WorkflowStore.ts";

const EMPTY = { runs: [], questions: [] };
const once = { retry: { times: 0 } } as const;

/** A workflow whose `flaky` step fails until `failures` reaches zero, counting every execution. */
const definitions = (counts: Ref.Ref<Record<string, number>>, failures: Ref.Ref<number>) => {
  const count = (name: string) =>
    Ref.updateAndGet(counts, (all) => ({ ...all, [name]: (all[name] ?? 0) + 1 })).pipe(
      Effect.map((all) => all[name]!),
    );
  return [
    workflow(
      "owned",
      {
        version: 1,
        payload: Schema.Struct({ mode: Schema.Literals(["finish", "stop", "hold"]) }),
        // Counted by how the run ended, and failing for as long as `failures` says.
        onEnd: (payload, end) =>
          Effect.flatMap(
            Ref.getAndUpdate(failures, (left) => Math.max(0, left - 1)),
            (left) =>
              left > 0
                ? Effect.fail("the machine would not go")
                : count(`end:${payload.mode}:${end.outcome}:${end.reason ?? ""}`),
          ),
      },
      (payload) =>
        Effect.gen(function* () {
          yield* step("take", { returns: Schema.Number, ...once }, count("take"));
          if (payload.mode === "stop") return yield* stop("no need");
          if (payload.mode === "hold") yield* wait("go", { returns: Schema.String });
        }),
    ),
    workflow(
      "flaky",
      { version: 1, payload: Schema.Struct({ id: Schema.String }), returns: Schema.String },
      () =>
        Effect.gen(function* () {
          yield* step("before", { returns: Schema.Number, ...once }, count("before"));
          const attempt = yield* step(
            "flaky",
            { returns: Schema.Number, ...once },
            Effect.flatMap(
              Ref.getAndUpdate(failures, (left) => Math.max(0, left - 1)),
              (left) => (left > 0 ? Effect.fail("the dependency is down") : count("flaky")),
            ),
          );
          return `done on attempt ${attempt}`;
        }),
    ),
    workflow(
      "review",
      {
        version: 1,
        payload: Schema.Struct({ change: Schema.String, timeout: Schema.optional(Schema.String) }),
        returns: Schema.String,
      },
      (payload) =>
        Effect.gen(function* () {
          yield* title("named", `review of ${payload.change}`);
          yield* sleep("settle", "1 millis");
          const [a, b] = yield* Effect.all(
            [
              step("check/a", { returns: Schema.Number, ...once }, count("check/a")),
              step("check/b", { returns: Schema.Number, ...once }, count("check/b")),
            ],
            { concurrency: 2 },
          );
          const verdict = yield* wait("verdict", {
            returns: Schema.Struct({ merge: Schema.Boolean }),
            key: payload.change,
            ...(payload.timeout === undefined ? {} : { timeout: "0 millis" }),
          });
          if (Option.isNone(verdict)) return yield* stop("nobody answered");
          yield* step("after", { returns: Schema.Number, ...once }, count("after"));
          return `${a + b} checks, merge: ${verdict.value.merge}`;
        }),
    ),
    workflow(
      "broken",
      { version: 1, payload: Schema.Struct({ how: Schema.Literals(["dies", "unstorable"]) }) },
      (payload) =>
        payload.how === "dies"
          ? step(
              "dies",
              { returns: Schema.Void, ...once },
              Effect.die(new Error("null dereference")),
            )
          : Effect.asVoid(
              step("unstorable", { returns: Schema.Int, ...once }, Effect.succeed(1.5)),
            ),
    ),
    workflow("twice", { version: 1, payload: Schema.Struct({}) }, () =>
      Effect.gen(function* () {
        yield* step("same", { returns: Schema.Void, ...once }, Effect.void);
        yield* step("same", { returns: Schema.Void, ...once }, Effect.void);
      }),
    ),
  ];
};

/** Write a change, ask a person whether to merge it, then land it in the writer's own thread. */
const tally = store.entry("tally", Schema.Number);
const stored = [
  /** Counts itself in the store, with the first try of the step failing after it counted. */
  workflow(
    "tally",
    {
      version: 1,
      payload: Schema.Struct({ wrong: Schema.optional(Schema.Boolean) }),
      returns: Schema.Number,
    },
    (payload) =>
      payload.wrong === true
        ? step(
            "read",
            { returns: Schema.Number, ...once },
            Effect.as(store.entry("tally", Schema.String).get, 0),
          )
        : step(
            "count",
            { returns: Schema.Number, ...once },
            tally
              .update((current) => Option.getOrElse(current, () => 0) + 1)
              .pipe(Effect.map(Option.getOrElse(() => 0))),
          ),
  ),
  /** Waits in line for a door that `opener` opens. */
  workflow(
    "door",
    { version: 1, payload: Schema.Struct({ door: Schema.String }), returns: Schema.String },
    (payload) =>
      Effect.map(
        wait("open", { returns: Schema.String, key: payload.door }),
        Option.getOrElse(() => "never"),
      ),
  ),
  workflow(
    "opener",
    { version: 1, payload: Schema.Struct({ door: Schema.String, fail: Schema.Boolean }) },
    (payload) =>
      step(
        "open",
        { returns: Schema.Void, retry: { times: 1 } },
        Effect.gen(function* () {
          // Written and taken back together when the step fails after writing.
          yield* store.transaction(
            Effect.gen(function* () {
              yield* store.entry(`doors/${payload.door}`, Schema.String).set("open");
              const tries = yield* store
                .entry(`tries/${payload.door}`, Schema.Number)
                .update((current) => Option.getOrElse(current, () => 0) + 1);
              if (payload.fail && Option.contains(tries, 1)) return yield* Effect.fail("slipped");
            }),
          );
          yield* signal({ workflow: "door", key: payload.door }, "came in");
        }),
      ),
  ),
];

const kid = workflow(
  "kid",
  {
    version: 1,
    payload: Schema.Struct({ mode: Schema.Literals(["finish", "stop", "hold"]) }),
    returns: Schema.String,
  },
  (payload) =>
    Effect.gen(function* () {
      if (payload.mode === "stop") return yield* stop("nothing to do");
      if (payload.mode === "hold") yield* wait("go", { returns: Schema.String });
      return "grown";
    }),
);
const family = [
  kid,
  /** Runs a kid as part of itself and reports how the kid ended. */
  workflow(
    "parent",
    {
      version: 1,
      payload: Schema.Struct({ mode: Schema.Literals(["finish", "stop", "hold"]) }),
      returns: Schema.String,
    },
    (payload) =>
      Effect.map(invoke("kid", kid, payload), (ended) =>
        ended.outcome === "completed" ? ended.value : `${ended.outcome}: ${ended.reason}`,
      ),
  ),
  /** Starts two kids and does not wait for them. */
  workflow(
    "spawner",
    { version: 1, payload: Schema.Struct({}), returns: Schema.Array(Schema.String) },
    () =>
      step(
        "spawn",
        { returns: Schema.Array(Schema.String), ...once },
        Effect.forEach(["one", "two"], (key) =>
          Effect.map(start(kid, { mode: "finish" }, { key: `spawned/${key}` }), (run) => run.runId),
        ),
      ),
  ),
  /** Two agents at once, the second with a minute to finish. */
  workflow("pair", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
    Effect.map(
      Effect.all(
        [
          agent("left", { brief: "Left.", project: "p1" }),
          agent("right", { brief: "Right.", project: "p1", timeout: "1 minute" }),
        ],
        { concurrency: 2 },
      ),
      ([left, right]) => `${left.value} ${right.value}`,
    ),
  ),
];

const fix = workflow(
  "fix",
  {
    version: 1,
    payload: Schema.Struct({ project: Schema.String, environment: Schema.optional(Schema.String) }),
    returns: Schema.String,
  },
  (payload) =>
    Effect.gen(function* () {
      const written = yield* agent("write", {
        brief: "Write the fix.",
        project: payload.project,
        ...(payload.environment === undefined ? {} : { environment: payload.environment }),
        output: Schema.Struct({ branch: Schema.String }),
      });
      const answer = yield* ask("merge", {
        title: `Merge ${written.value.branch}?`,
        choices: ["Merge", "Leave"],
        data: { branch: written.value.branch },
      });
      if (Option.isNone(answer) || answer.value.choice !== "Merge") return yield* stop("left");
      const landed = yield* agent("land", { brief: "Land it.", thread: written.thread });
      return `${written.value.branch}: ${landed.value}`;
    }),
);

type Started = Parameters<WorkflowAgents["Service"]["start"]>[0];

/** Agents the test plays: it sees each turn start and decides how that turn ends. */
const fakeAgents = () => {
  const turns = new Map<
    string,
    { started: Deferred.Deferred<Started>; ended: Deferred.Deferred<AgentResult> }
  >();
  const interrupted: Array<{
    readonly threadId: string;
    readonly environment?: string | undefined;
  }> = [];
  let threads = 0;
  const turn = (key: string) => {
    const known = turns.get(key);
    if (known !== undefined) return known;
    const made = {
      started: Deferred.makeUnsafe<Started>(),
      ended: Deferred.makeUnsafe<AgentResult>(),
    };
    turns.set(key, made);
    return made;
  };
  return {
    service: WorkflowAgents.of({
      start: (input) =>
        Effect.gen(function* () {
          // The engine's own setting for reading integers must not reach what a step calls.
          if (yield* SqlClient.SafeIntegers) {
            return yield* new WorkflowAgentError({ reason: "SafeIntegers leaked into a step" });
          }
          yield* Deferred.succeed(turn(input.key).started, input);
          return {
            threadId: input.thread ?? `thread-${++threads}`,
            turnId: input.key,
            ...(input.environment === undefined ? {} : { environment: input.environment }),
          };
        }),
      result: (started) => Deferred.await(turn(started.turnId).ended),
      interrupt: (thread) => Effect.sync(() => void interrupted.push(thread)),
    }),
    interrupted,
    /** The turn of `runId` with this key, once it has been started. */
    started: (runId: string, key: string) => Deferred.await(turn(`${runId}/${key}`).started),
    end: (runId: string, key: string, result: Partial<AgentResult>) =>
      Deferred.succeed(turn(`${runId}/${key}`).ended, {
        ending: "completed" as const,
        detail: "",
        reply: "",
        ...result,
      }),
  };
};

const triggered = [
  workflow(
    "nightly",
    { version: 1, payload: Tick, returns: Schema.String, triggers: [every("1 hour")] },
    (tick) => Effect.succeed(tick.scheduledAt),
  ),
  workflow(
    "morning",
    { version: 1, payload: Tick, triggers: [daily("09:00", { weekdays: [1, 2, 3, 4, 5] })] },
    () => Effect.void,
  ),
  workflow(
    "inbound",
    {
      version: 1,
      payload: WebhookRequest,
      triggers: [webhook("push", { key: (request) => request.headers["x-delivery"] })],
    },
    (request) => (request.body === "ping" ? stop("only a ping") : Effect.succeed(request.body)),
  ),
];

const harness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflows-" });
  const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
  yield* Effect.provide(
    Effect.all(
      [Migration0092, Migration0093, Migration0094, Migration0095, Migration0096, Migration0097],
      {
        discard: true,
      },
    ),
    database,
  );
  const counts = yield* Ref.make<Record<string, number>>({});
  const failures = yield* Ref.make(0);
  // One database file, so a second engine built from it is the server after a restart.
  const agents = fakeAgents();
  const engine = WorkflowEngine.layer([
    ...definitions(counts, failures),
    fix,
    ...triggered,
    ...stored,
    ...family,
  ]).pipe(
    Layer.provide(Layer.succeed(WorkflowAgents, agents.service)),
    Layer.provide(database),
    Layer.provide(NodeCrypto.layer),
  );
  // The engine polls its message store, backs off between retries and bounds its shutdown, all
  // on the clock, so time runs for as long as a server is up, shutdown included.
  const boot = <A, E>(use: Effect.Effect<A, E, Workflows.Workflows>) =>
    Effect.raceFirst(
      Effect.scoped(Effect.provide(use, engine)),
      Effect.forever(TestClock.adjust("1 second")),
    );
  return { counts, failures, boot, agents };
});

const status =
  (...statuses: ReadonlyArray<WorkflowRunStatus>) =>
  (run: WorkflowRun) =>
    statuses.includes(run.status);

it.effect(
  "a failing step pauses its run, and resuming runs that step again and nothing before it",
  () =>
    Effect.gen(function* () {
      const { counts, failures, boot } = yield* harness;
      yield* Ref.set(failures, 2);
      const runId = yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const { runId } = yield* workflows.start("flaky", { id: "a" }, { idempotencyKey: "a" });
          const again = yield* workflows.start("flaky", { id: "a" }, { idempotencyKey: "a" });
          assert.equal(again.runId, runId);

          const paused = yield* workflows.waitFor(runId, status("paused"));
          assert.include(paused.detail ?? "", "the dependency is down");
          assert.equal(paused.pauses, 1);

          yield* workflows.resume(runId);
          const pausedAgain = yield* workflows.waitFor(runId, (run) => run.pauses === 2);
          assert.equal(pausedAgain.status, "paused");
          return runId;
        }),
      );

      // The server restarts while the run is paused. Nothing retries it until it is resumed.
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          assert.equal((yield* workflows.get(runId)).run.status, "paused");
          yield* workflows.resume(runId);
          const done = yield* workflows.waitFor(runId, status("completed"));
          assert.equal(done.result, "done on attempt 1");
          assert.equal(done.pauses, 0);
          const { steps } = yield* workflows.get(runId);
          assert.deepStrictEqual(
            steps.map((step) => [step.name, step.status, step.attempts]),
            [
              ["before", "completed", 1],
              ["flaky", "completed", 3],
            ],
          );
        }),
      );
      assert.deepStrictEqual(yield* Ref.get(counts), { before: 1, flaky: 1 });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a wait survives a restart, checks what it is signalled with, and steps run once", () =>
  Effect.gen(function* () {
    const { counts, boot } = yield* harness;
    const runId = yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* workflows.start(
          "review",
          { change: "c1" },
          { idempotencyKey: "c1" },
        );
        const waiting = yield* workflows.waitFor(runId, status("waiting"));
        assert.equal(waiting.title, "review of c1");
        const wrong = yield* workflows
          .signal({ runId, wait: "verdict" }, { merge: "yes" }, { id: "s0" })
          .pipe(Effect.flip);
        assert.include(wrong.message, "merge");
        return runId;
      }),
    );
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        // Addressed by key: the sender knows the change, not the run.
        assert.equal(
          yield* workflows.signal({ workflow: "review", key: "c1" }, { merge: true }, { id: "s1" }),
          "delivered",
        );
        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.equal(done.result, "2 checks, merge: true");
      }),
    );
    assert.deepStrictEqual(yield* Ref.get(counts), { "check/a": 1, "check/b": 1, after: 1 });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a signal sent before its wait opens is delivered when it does", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness;
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        assert.equal(
          yield* workflows.signal(
            { workflow: "review", key: "c2" },
            { merge: false },
            { id: "s2" },
          ),
          "buffered",
        );
        const { runId } = yield* workflows.start(
          "review",
          { change: "c2" },
          { idempotencyKey: "c2" },
        );
        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.equal(done.result, "2 checks, merge: false");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a wait past its timeout wakes with nothing, and a workflow may stop on its own", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness;
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* workflows.start(
          "review",
          { change: "c3", timeout: "now" },
          { idempotencyKey: "c3" },
        );
        yield* workflows.waitFor(runId, status("waiting"));
        yield* workflows.sweep;
        const stopped = yield* workflows.waitFor(runId, status("stopped"));
        assert.equal(stopped.detail, "nobody answered");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a cancelled run ends, and two steps with one name pause their run", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness;
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const waiting = yield* workflows.start(
          "review",
          { change: "c4" },
          { idempotencyKey: "c4" },
        );
        yield* workflows.waitFor(waiting.runId, status("waiting"));
        yield* workflows.cancel(waiting.runId, "not needed");
        const cancelled = (yield* workflows.get(waiting.runId)).run;
        assert.equal(cancelled.status, "cancelled");
        assert.equal(cancelled.detail, "not needed");
        // A signal for the wait it had is kept as mail, not delivered to a run that ended.
        assert.equal(
          yield* workflows.signal(
            { runId: waiting.runId, wait: "verdict" },
            { merge: true },
            { id: "s4" },
          ),
          "buffered",
        );

        const twice = yield* workflows.start("twice", {}, { idempotencyKey: "t1" });
        const paused = yield* workflows.waitFor(twice.runId, status("paused"));
        assert.include(paused.detail ?? "", 'named "same"');

        const missing = yield* workflows
          .start("nothing", {}, { idempotencyKey: "n1" })
          .pipe(Effect.flip);
        assert.equal(missing._tag, "WorkflowNotRegisteredError");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "an agent returns checked data, a person answers, and a later step continues the thread",
  () =>
    Effect.gen(function* () {
      const { boot, agents } = yield* harness;
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const { runId } = yield* workflows.start(
            "fix",
            { project: "p1" },
            { idempotencyKey: "f1" },
          );

          const write = yield* agents.started(runId, "write/0");
          assert.equal(write.project, "p1");
          assert.equal(write.thread, undefined);
          assert.deepStrictEqual(write.outputSchema?.required, ["branch"]);
          // It ended its turn without a result: the same thread is asked for it, not for the work.
          yield* agents.end(runId, "write/0", { reply: "done" });
          const correction = yield* agents.started(runId, "write/0/correct/0");
          assert.equal(correction.thread, "thread-1");
          yield* agents.end(runId, "write/0/correct/0", { output: { branch: "fix/1" } });

          yield* workflows.waitFor(runId, (run) => run.detail === "merge");
          const [question] = yield* workflows.questions;
          assert.deepStrictEqual(question?.request, {
            title: "Merge fix/1?",
            choices: ["Merge", "Leave"],
            data: { branch: "fix/1" },
          });
          const refused = yield* workflows
            .signal({ runId, wait: "merge" }, { choice: "Maybe" }, { id: "a0" })
            .pipe(Effect.flip);
          assert.include(refused.message, "merge waits for");
          yield* workflows.signal({ runId, wait: "merge" }, { choice: "Merge" }, { id: "a1" });

          const land = yield* agents.started(runId, "land/0");
          assert.equal(land.thread, "thread-1");
          assert.equal(land.outputSchema, undefined);
          yield* agents.end(runId, "land/0", { reply: "merged as abc123" });
          const done = yield* workflows.waitFor(runId, status("completed"));
          assert.equal(done.result, "fix/1: merged as abc123");
          assert.deepStrictEqual(yield* workflows.questions, []);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "an agent whose turn dies is tried on a new thread, then its run pauses until resumed",
  () =>
    Effect.gen(function* () {
      const { boot, agents } = yield* harness;
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const { runId } = yield* workflows.start(
            "fix",
            { project: "p1" },
            { idempotencyKey: "f2" },
          );
          yield* agents.started(runId, "write/0");
          yield* agents.end(runId, "write/0", { ending: "failed", detail: "failed" });
          yield* agents.started(runId, "write/1");
          yield* agents.end(runId, "write/1", { ending: "failed", detail: "provider error" });

          const paused = yield* workflows.waitFor(runId, status("paused"));
          assert.include(paused.detail ?? "", "provider error");
          yield* workflows.resume(runId);
          yield* agents.started(runId, "write/2");
          yield* agents.end(runId, "write/2", { output: { branch: "fix/2" } });
          yield* workflows.waitFor(runId, (run) => run.detail === "merge");
          yield* workflows.signal({ runId, wait: "merge" }, { choice: "Leave" }, { id: "a2" });
          const stopped = yield* workflows.waitFor(runId, status("stopped"));
          assert.equal(stopped.detail, "left");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a step that dies, or whose result cannot be stored, pauses its run like any failure",
  () =>
    Effect.gen(function* () {
      const { boot } = yield* harness;
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const dies = yield* workflows.start("broken", { how: "dies" }, { idempotencyKey: "b1" });
          const died = yield* workflows.waitFor(dies.runId, status("paused"));
          assert.include(died.detail ?? "", "null dereference");
          const unstorable = yield* workflows.start(
            "broken",
            { how: "unstorable" },
            { idempotencyKey: "b2" },
          );
          const refused = yield* workflows.waitFor(unstorable.runId, status("paused"));
          assert.include(refused.detail ?? "", "unstorable");
          assert.equal((yield* workflows.get(unstorable.runId)).steps[0]?.status, "failed");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "signals: one per wait, a retried id is not a second one, and bad early mail is dropped",
  () =>
    Effect.gen(function* () {
      const { boot } = yield* harness;
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const key = { workflow: "review", key: "k1" };
          // Two signals before any run waits: the first is not what the wait expects.
          yield* workflows.signal(key, { merge: "x" }, { id: "bad" });
          yield* workflows.signal(key, { merge: true }, { id: "good" });
          const first = yield* workflows.start(
            "review",
            { change: "k1" },
            { idempotencyKey: "k1a" },
          );
          const done = yield* workflows.waitFor(first.runId, status("completed"));
          assert.equal(done.result, "2 checks, merge: true");
          // The sender retries the signal that was already delivered from the mail.
          assert.equal(yield* workflows.signal(key, { merge: true }, { id: "good" }), "delivered");

          const second = yield* workflows.start(
            "review",
            { change: "k1" },
            { idempotencyKey: "k1b" },
          );
          const third = yield* workflows.start(
            "review",
            { change: "k1" },
            { idempotencyKey: "k1c" },
          );
          yield* workflows.waitFor(second.runId, status("waiting"));
          yield* workflows.waitFor(third.runId, status("waiting"));
          // Nothing was left over for them, and each new signal wakes one run.
          assert.equal(yield* workflows.signal(key, { merge: false }, { id: "s1" }), "delivered");
          assert.equal(yield* workflows.signal(key, { merge: true }, { id: "s2" }), "delivered");
          const results = [
            (yield* workflows.waitFor(second.runId, status("completed"))).result,
            (yield* workflows.waitFor(third.runId, status("completed"))).result,
          ];
          // Each new signal woke one of the two runs, whichever opened its wait first.
          assert.sameMembers(
            results.map((result) => String(result).split(", ")[1]),
            ["merge: false", "merge: true"],
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "onEnd runs once however the run ends, and a cancelled run's is tried until it works",
  () =>
    Effect.gen(function* () {
      const { boot, counts, failures } = yield* harness;
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const finished = yield* workflows.start(
            "owned",
            { mode: "finish" },
            { idempotencyKey: "f" },
          );
          const stopped = yield* workflows.start(
            "owned",
            { mode: "stop" },
            { idempotencyKey: "s" },
          );
          yield* workflows.waitFor(finished.runId, status("completed"));
          yield* workflows.waitFor(stopped.runId, status("stopped"));

          const held = yield* workflows.start("owned", { mode: "hold" }, { idempotencyKey: "h" });
          yield* workflows.waitFor(held.runId, status("waiting"));
          yield* Ref.set(failures, 1);
          yield* workflows.cancel(held.runId, "not needed");
          const ended = (step: { readonly name: string }) => step.name === "onEnd";
          // The first try failed, which is on the run for a person to see.
          const firstTry = (yield* workflows.get(held.runId)).steps.find(ended);
          assert.deepStrictEqual(
            [firstTry?.status, firstTry?.detail],
            ["failed", "the machine would not go"],
          );
          yield* workflows.sweep;
          const { steps } = yield* workflows.get(held.runId);
          assert.deepStrictEqual(
            steps.map((step) => [step.name, step.status, step.attempts]),
            [
              ["take", "completed", 1],
              ["go", "failed", 1],
              ["onEnd", "completed", 2],
            ],
          );
          // Nothing is left to do, so another look changes nothing.
          yield* workflows.sweep;
          // A cleanup that works the first time is told why the run was cancelled, too.
          const second = yield* workflows.start(
            "owned",
            { mode: "hold" },
            { idempotencyKey: "h2" },
          );
          yield* workflows.waitFor(second.runId, status("waiting"));
          yield* workflows.cancel(second.runId, "changed my mind");
          const all = yield* Ref.get(counts);
          assert.deepStrictEqual(
            Object.entries(all).filter(([name]) => name.startsWith("end:")),
            [
              ["end:finish:completed:", 1],
              ["end:stop:stopped:no need", 1],
              ["end:hold:cancelled:not needed", 1],
              ["end:hold:cancelled:changed my mind", 1],
            ],
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "the store is shared by runs, survives a restart, and a failed transaction writes nothing",
  () =>
    Effect.gen(function* () {
      const { boot } = yield* harness;
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const runs = yield* Effect.forEach(["a", "b", "c"], (key) =>
            workflows.start("tally", {}, { idempotencyKey: key }),
          );
          const counted = yield* Effect.forEach(runs, (run) =>
            workflows.waitFor(run.runId, status("completed")),
          );
          assert.sameMembers(
            counted.map((run) => run.result),
            [1, 2, 3],
          );
        }),
      );
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const next = yield* workflows.start("tally", {}, { idempotencyKey: "d" });
          assert.equal((yield* workflows.waitFor(next.runId, status("completed"))).result, 4);
          // A key read with another schema is the step's failure, with the key in the reason.
          const wrong = yield* workflows.start("tally", { wrong: true }, { idempotencyKey: "w" });
          const paused = yield* workflows.waitFor(wrong.runId, status("paused"));
          assert.include(paused.detail ?? "", "The stored value at tally does not fit its schema");

          // The first try fails inside the transaction, so the door it opened is not there, and
          // the try count it raised is 1 again on the second try, which is the one that signals.
          const waiting = yield* workflows.start("door", { door: "east" }, { idempotencyKey: "e" });
          yield* workflows.waitFor(waiting.runId, status("waiting"));
          const opener = yield* workflows.start(
            "opener",
            { door: "east", fail: true },
            { idempotencyKey: "o" },
          );
          yield* workflows.waitFor(opener.runId, status("paused"));
          assert.equal((yield* workflows.get(waiting.runId)).run.status, "waiting");
          const clean = yield* workflows.start(
            "opener",
            { door: "east", fail: false },
            { idempotencyKey: "o2" },
          );
          yield* workflows.waitFor(clean.runId, status("completed"));
          assert.equal(
            (yield* workflows.waitFor(waiting.runId, status("completed"))).result,
            "came in",
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("an invoked run reports how it ended, and cancelling the parent cancels it", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness;
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        // The kid of a parent that waits on it, once the kid itself waits.
        const heldKid = Effect.gen(function* () {
          const kid = (yield* workflows.list({})).find(
            (run) =>
              run.workflow === "kid" && (run.status === "running" || run.status === "waiting"),
          );
          return yield* workflows.waitFor(kid!.runId, status("waiting"));
        });
        const finished = yield* workflows.start(
          "parent",
          { mode: "finish" },
          { idempotencyKey: "f" },
        );
        const stopped = yield* workflows.start("parent", { mode: "stop" }, { idempotencyKey: "s" });
        assert.equal(
          (yield* workflows.waitFor(finished.runId, status("completed"))).result,
          "grown",
        );
        assert.equal(
          (yield* workflows.waitFor(stopped.runId, status("completed"))).result,
          "stopped: nothing to do",
        );

        const held = yield* workflows.start("parent", { mode: "hold" }, { idempotencyKey: "h" });
        yield* workflows.waitFor(held.runId, (run) => run.detail === "kid");
        const child = yield* heldKid;
        yield* workflows.cancel(held.runId, "not needed");
        assert.equal((yield* workflows.get(child.runId)).run.status, "cancelled");

        // A kid cancelled by itself is an outcome its parent hears, not a failure.
        const second = yield* workflows.start("parent", { mode: "hold" }, { idempotencyKey: "h2" });
        yield* workflows.waitFor(second.runId, (run) => run.detail === "kid");
        const lone = yield* heldKid;
        yield* workflows.cancel(lone.runId, "changed my mind");
        assert.equal(
          (yield* workflows.waitFor(second.runId, status("completed"))).result,
          "cancelled: changed my mind",
        );

        const spawner = yield* workflows.start("spawner", {}, { idempotencyKey: "sp" });
        const spawned = (yield* workflows.waitFor(spawner.runId, status("completed")))
          .result as ReadonlyArray<string>;
        assert.equal(spawned.length, 2);
        for (const runId of spawned) {
          assert.equal((yield* workflows.waitFor(runId, status("completed"))).result, "grown");
        }
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("two agents run side by side, and one past its time limit is stopped", () =>
  Effect.gen(function* () {
    const { boot, agents } = yield* harness;
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const run = yield* workflows.start("pair", {}, { idempotencyKey: "p" });
        // Both have started before either has ended.
        yield* agents.started(run.runId, "left/0");
        yield* agents.started(run.runId, "right/0");
        yield* agents.end(run.runId, "left/0", { reply: "done" });
        // The right one never answers. Its minute passes on the clock, and its thread is stopped.
        const paused = yield* workflows.waitFor(run.runId, status("paused"));
        assert.include(paused.detail ?? "", "it was not done after 1m");
        assert.equal(agents.interrupted.length, 1);
        const { steps } = yield* workflows.get(run.runId);
        assert.deepStrictEqual(steps.map((step) => [step.name, step.status]).toSorted(), [
          ["left", "completed"],
          ["right", "failed"],
        ]);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("an agent step in a linked environment keeps its thread there", () =>
  Effect.gen(function* () {
    const { boot, agents } = yield* harness;
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const run = yield* workflows.start(
          "fix",
          { project: "/work/app", environment: "env-b" },
          { idempotencyKey: "e1" },
        );
        const write = yield* agents.started(run.runId, "write/0");
        assert.equal(write.environment, "env-b");
        yield* agents.end(run.runId, "write/0", { output: { branch: "fix/1" } });
        yield* workflows.waitFor(run.runId, status("waiting"));
        yield* workflows.signal(
          { runId: run.runId, wait: "merge" },
          { choice: "Merge" },
          { id: "m1" },
        );

        // The step that continues the thread names no environment: the thread carries it.
        const land = yield* agents.started(run.runId, "land/0");
        assert.equal(land.environment, "env-b");
        assert.equal(land.thread, "thread-1");
        yield* workflows.waitFor(run.runId, (current) => current.detail === "agent land");
        const { steps } = yield* workflows.get(run.runId);
        assert.deepStrictEqual(
          steps.filter((step) => step.kind === "agent").map((step) => step.environmentId),
          ["env-b", "env-b"],
        );
        yield* workflows.cancel(run.runId, "not needed");
        assert.deepStrictEqual(agents.interrupted, [
          { threadId: "thread-1", environment: "env-b" },
        ]);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("cancelling a run stops its agent, and a turn a person stopped is not tried again", () =>
  Effect.gen(function* () {
    const { boot, agents } = yield* harness;
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const cancelled = yield* workflows.start(
          "fix",
          { project: "p1" },
          { idempotencyKey: "x1" },
        );
        yield* agents.started(cancelled.runId, "write/0");
        yield* workflows.waitFor(cancelled.runId, (run) => run.detail === "agent write");
        const { steps } = yield* workflows.get(cancelled.runId);
        yield* workflows.cancel(cancelled.runId, "not needed");
        assert.deepStrictEqual(
          agents.interrupted.map((thread) => thread.threadId),
          [steps[0]?.threadId],
        );

        const stopped = yield* workflows.start("fix", { project: "p1" }, { idempotencyKey: "x2" });
        yield* agents.started(stopped.runId, "write/0");
        yield* agents.end(stopped.runId, "write/0", { ending: "stopped", detail: "interrupted" });
        const paused = yield* workflows.waitFor(stopped.runId, status("paused"));
        assert.include(paused.detail ?? "", "stopped");
        // Resuming is the person saying go on: the next round starts.
        yield* workflows.resume(stopped.runId);
        yield* agents.started(stopped.runId, "write/1");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a watcher is sent the runs again when one changes", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness;
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        assert.deepStrictEqual(yield* Stream.runHead(workflows.watch), Option.some(EMPTY));
        const { runId } = yield* workflows.start(
          "review",
          { change: "c9", timeout: "1 hour" },
          { idempotencyKey: "c9" },
        );
        const seen = yield* workflows.watch.pipe(
          Stream.filter((snapshot) => snapshot.runs.some((run) => run.status === "waiting")),
          Stream.runHead,
        );
        assert.deepStrictEqual(
          Option.getOrThrow(seen).runs.map((run) => run.runId),
          [runId],
        );
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a schedule starts one run when it is due, and one for all the times a restart missed",
  () =>
    Effect.gen(function* () {
      const { boot } = yield* harness;
      const nightly = (workflows: Workflows.Workflows["Service"]) =>
        Effect.map(workflows.list(), (runs) => runs.filter((run) => run.workflow === "nightly"));
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          // The first look only notes when it is next due.
          yield* workflows.sweep;
          assert.deepStrictEqual(yield* nightly(workflows), []);
          yield* TestClock.adjust("61 minutes");
          yield* workflows.sweep;
          yield* workflows.sweep;
          const [run] = yield* nightly(workflows);
          assert.equal((yield* nightly(workflows)).length, 1);
          const done = yield* workflows.waitFor(run!.runId, status("completed"));
          assert.match(String(done.result), /^1970-01-01T01:/);
        }),
      );
      yield* TestClock.adjust("3 hours");
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          yield* workflows.sweep;
          yield* workflows.sweep;
          assert.equal((yield* nightly(workflows)).length, 2);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a request to a hook starts a run, its retry is the same run, and a bad token none", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness;
    const request = (body: string, delivery: string) => ({
      method: "POST",
      headers: { "x-delivery": delivery },
      query: "",
      body,
    });
    const token = yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const [hook] = yield* workflows.hooks;
        assert.equal(hook?.workflow, "inbound");
        const [hookId, token] = hook!.path.split("/").slice(-2).map(decodeURIComponent);
        const deliver = (body: string, delivery: string, withToken = token!) =>
          workflows.deliver({
            hookId: hookId!,
            token: withToken,
            request: request(body, delivery),
          });

        assert.isTrue(Option.isNone(yield* deliver("hello", "d1", "not the token")));
        const first = Option.getOrThrow(yield* deliver("hello", "d1"));
        assert.deepStrictEqual(Option.getOrThrow(yield* deliver("hello", "d1")), first);
        const done = yield* workflows.waitFor(first.runId, status("completed"));
        assert.equal(done.result, "hello");

        const ping = Option.getOrThrow(yield* deliver("ping", "d2"));
        const stopped = yield* workflows.waitFor(ping.runId, status("stopped"));
        assert.equal(stopped.detail, "only a ping");
        return token;
      }),
    );
    // The URL a sender was given still works after a restart.
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        assert.isTrue((yield* workflows.hooks)[0]?.path.endsWith(`/${token}`));
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
