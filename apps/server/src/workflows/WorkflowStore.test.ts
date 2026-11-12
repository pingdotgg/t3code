import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import Migration0092 from "../persistence/Migrations/092_Workflows.ts";
import Migration0093 from "../persistence/Migrations/093_WorkflowTriggers.ts";
import Migration0094 from "../persistence/Migrations/094_WorkflowStepEnvironment.ts";
import Migration0095 from "../persistence/Migrations/095_WorkflowRunInput.ts";
import Migration0096 from "../persistence/Migrations/096_WorkflowStore.ts";
import Migration0097 from "../persistence/Migrations/097_WorkflowRunParent.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const withStore = <A, E>(use: Effect.Effect<A, E, WorkflowStore.WorkflowStore>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-store-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    const migrated = Layer.effectDiscard(
      Effect.all(
        [Migration0092, Migration0093, Migration0094, Migration0095, Migration0096, Migration0097],
        { discard: true },
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
