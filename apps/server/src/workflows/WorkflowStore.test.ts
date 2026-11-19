import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import Migration0099 from "../persistence/Migrations/099_Workflows.ts";
import Migration0100 from "../persistence/Migrations/100_WorkflowTriggers.ts";
import Migration0101 from "../persistence/Migrations/101_WorkflowStepEnvironment.ts";
import Migration0102 from "../persistence/Migrations/102_WorkflowRunInput.ts";
import Migration0103 from "../persistence/Migrations/103_WorkflowStore.ts";
import Migration0104 from "../persistence/Migrations/104_WorkflowRunParent.ts";
import Migration0105 from "../persistence/Migrations/105_WorkflowStepResult.ts";
import Migration0106 from "../persistence/Migrations/106_WorkflowWaitWatch.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const withStore = <A, E>(use: Effect.Effect<A, E, WorkflowStore.WorkflowStore>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-store-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    const migrated = Layer.effectDiscard(
      Effect.all(
        [
          Migration0099,
          Migration0100,
          Migration0101,
          Migration0102,
          Migration0103,
          Migration0104,
          Migration0105,
          Migration0106,
        ],
        {
          discard: true,
        },
      ),
    );
    return yield* Effect.provide(
      use,
      WorkflowStore.layer.pipe(Layer.provideMerge(migrated), Layer.provide(database)),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect("a run still waits while one of the things it started side by side is out", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      yield* store.runStarted({
        runId: "r1",
        workflow: "duo",
        version: 1,
        engineTag: "duo@1",
        idempotencyKey: "k",
        input: {},
      });
      const now = Effect.map(store.run("r1"), (run) => [run?.status, run?.detail]);
      yield* store.stepStarted("r1", "left", "agent");
      yield* store.stepStarted("r1", "right", "agent");
      yield* store.stepStarted("r1", "approve", "ask");
      yield* store.runStatus("r1", "waiting", "agent left");

      yield* store.stepEnded("r1", "left", "completed", null);
      yield* store.runResumed("r1");
      assert.deepStrictEqual(yield* now, ["waiting", "agent right"]);

      yield* store.stepEnded("r1", "right", "completed", null);
      yield* store.runResumed("r1");
      assert.deepStrictEqual(yield* now, ["waiting", "approve"]);

      yield* store.stepEnded("r1", "approve", "completed", null);
      yield* store.runResumed("r1");
      assert.deepStrictEqual(yield* now, ["running", null]);
    }),
  ),
);

it.effect("counts what waits on a person, and finds the run's latest agent thread", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const start = (runId: string) =>
        store.runStarted({
          runId,
          workflow: "fix",
          version: 1,
          engineTag: "fix@1",
          idempotencyKey: runId,
          input: {},
        });
      assert.deepStrictEqual(yield* store.counts, { needsYou: 0, active: 0, total: 0 });
      yield* Effect.forEach(["r1", "r2", "r3"], start);
      yield* store.runPaused("r1", "the build failed");
      yield* store.runEnded("r3", "completed", null, null);
      yield* store.waitOpened({
        runId: "r2",
        name: "merge",
        workflow: "fix",
        key: undefined,
        token: "t",
        schemaJson: "{}",
        requestJson: '{"title":"Merge?"}',
        watchJson: null,
        deadline: null,
      });
      // A paused run and an open question each wait on someone; a plain wait does not.
      yield* store.waitOpened({
        runId: "r2",
        name: "ci",
        workflow: "fix",
        key: undefined,
        token: "u",
        schemaJson: "{}",
        requestJson: null,
        watchJson: null,
        deadline: null,
      });
      assert.deepStrictEqual(yield* store.counts, { needsYou: 2, active: 2, total: 3 });

      assert.isNull(yield* store.latestThread("r2"));
      yield* store.stepStarted("r2", "write", "agent");
      yield* store.stepThread("r2", "write", "thread-1", null);
      yield* store.stepStarted("r2", "review", "agent");
      yield* store.stepThread("r2", "review", "thread-2", "env-b");
      assert.deepStrictEqual(yield* store.latestThread("r2"), {
        threadId: "thread-2",
        environmentId: "env-b",
      });
    }),
  ),
);

it.effect("one buffered signal goes to one wait, and a claimed wait keeps what woke it", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const open = (runId: string) =>
        Effect.andThen(
          store.runStarted({
            runId,
            workflow: "gate",
            version: 1,
            engineTag: "gate@1",
            idempotencyKey: runId,
            input: {},
          }),
          store.waitOpened({
            runId,
            name: "go",
            workflow: "gate",
            key: "ready",
            token: `token-${runId}`,
            schemaJson: "{}",
            requestJson: null,
            watchJson: null,
            deadline: null,
          }),
        );
      yield* open("r1");
      yield* open("r2");
      // The parts of an address are kept apart: this one is for another workflow's other key.
      yield* store.mailPut({
        signalId: "other",
        address: { workflow: "gate:ready", key: "x" },
        valueJson: "1",
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
      assert.isUndefined(yield* store.mailNext([{ workflow: "gate", key: "ready:x" }]));

      yield* store.mailPut({
        signalId: "s1",
        address: { workflow: "gate", key: "ready" },
        valueJson: '"yes"',
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
      const woke = { expired: false, value: "yes" };
      assert.equal(yield* store.mailDeliver("s1", "r1", "go", woke), "delivered");
      // The second wait finds the signal gone and stays open for the next one.
      assert.equal(yield* store.mailDeliver("s1", "r2", "go", woke), "gone");
      assert.isDefined(yield* store.waitAt({ runId: "r2", wait: "go" }));
      assert.isTrue(yield* store.signalSeen("s1"));
      // A wait that is already claimed takes no second wake.
      assert.equal(yield* store.mailDeliver("other", "r1", "go", woke), "claimed");

      // Its wake is redone once the claim has gone unanswered for a while.
      assert.deepStrictEqual(yield* store.waitsToWake, []);
      yield* TestClock.adjust("1 minute");
      const again = yield* store.waitsToWake;
      assert.deepStrictEqual(
        again.map((wait) => [wait.run_id, wait.woke_json]),
        [["r1", JSON.stringify(woke)]],
      );
    }),
  ),
);
