import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import WorkflowsMigration from "../persistence/Migrations/110_Workflows.ts";
import WorkflowSkippedRunsMigration from "../persistence/Migrations/113_WorkflowSkippedRuns.ts";
import WorkflowRunTagsMigration from "../persistence/Migrations/115_WorkflowRunTags.ts";
import WorkflowMailSenderMigration from "../persistence/Migrations/117_WorkflowMailSender.ts";
import WorkflowPoolsMigration from "../persistence/Migrations/118_WorkflowPools.ts";
import WorkflowRunSubjectMigration from "../persistence/Migrations/119_WorkflowRunSubject.ts";
import { workflow } from "./workflow.ts";
import { WorkflowAgents } from "./WorkflowAgents.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import { unavailable, WorkflowForge } from "./WorkflowForge.ts";
import * as Workflows from "./Workflows.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const echo = workflow(
  "echo",
  {
    version: 1,
    payload: Schema.Struct({ item: Schema.String }),
    returns: Schema.String,
  },
  (payload) => Effect.succeed(payload.item),
);

it.effect("same-version retry after a cut-off start executes the stored input", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-retry-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    yield* Effect.provide(
      Effect.andThen(WorkflowsMigration, WorkflowSkippedRunsMigration).pipe(
        Effect.andThen(WorkflowRunTagsMigration),
        Effect.andThen(WorkflowMailSenderMigration),
        Effect.andThen(WorkflowPoolsMigration),
        Effect.andThen(WorkflowRunSubjectMigration),
      ),
      database,
    );

    let crashOnce = true;
    const storeLayer = Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.map(WorkflowStore.make, (real) =>
        WorkflowStore.WorkflowStore.of({
          ...real,
          runStarted: (run) =>
            real.runStarted(run).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (!crashOnce) return Effect.void;
                  crashOnce = false;
                  return Effect.die(new Error("simulated crash before engine.execute"));
                }),
              ),
            ),
        }),
      ),
    );

    const engineLayer = WorkflowEngine.layer([echo], storeLayer).pipe(
      Layer.provide(
        Layer.succeed(
          WorkflowAgents,
          WorkflowAgents.of({
            start: () => Effect.never,
            result: () => Effect.never,
            interrupt: () => Effect.succeed("ended"),
          }),
        ),
      ),
      Layer.provide(Layer.succeed(WorkflowForge, unavailable)),
      Layer.provide(database),
      Layer.provide(NodeCrypto.layer),
    );

    const clock = yield* Latch.make(true);
    yield* Effect.raceFirst(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const workflows = yield* Workflows.Workflows;
            const cut = yield* Effect.exit(
              workflows.start("echo", { item: "first" }, { idempotencyKey: "one" }),
            );
            assert.isTrue(Exit.isFailure(cut));

            const { runId } = yield* workflows.start(
              "echo",
              { item: "second" },
              { idempotencyKey: "one" },
            );
            const done = yield* workflows.waitFor(runId, (run) => run.status === "completed");
            assert.strictEqual(done.result, "first");
            const persisted = yield* WorkflowStore.make.pipe(
              Effect.flatMap((store) => store.run(runId)),
              Effect.provide(database),
            );
            assert.deepStrictEqual(
              persisted?.input_json ? WorkflowStore.jsonValue(persisted.input_json) : undefined,
              { item: "first" },
            );
          }),
          engineLayer,
        ),
      ),
      Effect.forever(Effect.andThen(clock.await, TestClock.adjust("1 second"))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("concurrent same-version starts execute the winning stored input", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-race-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    yield* Effect.provide(
      Effect.andThen(WorkflowsMigration, WorkflowSkippedRunsMigration).pipe(
        Effect.andThen(WorkflowRunTagsMigration),
        Effect.andThen(WorkflowMailSenderMigration),
        Effect.andThen(WorkflowPoolsMigration),
        Effect.andThen(WorkflowRunSubjectMigration),
      ),
      database,
    );

    const bothMissed = yield* Deferred.make<void>();
    const winnerInserted = yield* Deferred.make<void>();
    const loserCanReadHolder = yield* Deferred.make<void>();
    const loserExecuted = yield* Deferred.make<void>();
    let initialMisses = 0;

    const storeLayer = Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.map(WorkflowStore.make, (real) =>
        WorkflowStore.WorkflowStore.of({
          ...real,
          runByKey: (workflowName, key) =>
            Effect.gen(function* () {
              const row = yield* real.runByKey(workflowName, key);
              if (row === undefined) {
                initialMisses += 1;
                if (initialMisses === 2) {
                  yield* Deferred.succeed(bothMissed, undefined);
                } else {
                  yield* Deferred.await(bothMissed);
                }
              }
              return row;
            }),
          runStarted: (run) =>
            Effect.gen(function* () {
              const input = run.input as { readonly item: string };
              if (input.item === "second") {
                yield* Deferred.await(winnerInserted);
                yield* real.runStarted(run);
                yield* Deferred.succeed(loserCanReadHolder, undefined);
                return;
              }
              yield* real.runStarted(run);
              yield* Deferred.succeed(winnerInserted, undefined);
              yield* Deferred.await(loserExecuted);
            }),
        }),
      ),
    );

    const engineLayer = WorkflowEngine.layer([echo], storeLayer).pipe(
      Layer.provide(
        Layer.succeed(
          WorkflowAgents,
          WorkflowAgents.of({
            start: () => Effect.never,
            result: () => Effect.never,
            interrupt: () => Effect.succeed("ended"),
          }),
        ),
      ),
      Layer.provide(Layer.succeed(WorkflowForge, unavailable)),
      Layer.provide(database),
      Layer.provide(NodeCrypto.layer),
    );

    const clock = yield* Latch.make(true);
    yield* Effect.raceFirst(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const workflows = yield* Workflows.Workflows;
            const first = yield* Effect.forkChild(
              workflows.start("echo", { item: "first" }, { idempotencyKey: "race" }),
            );
            const second = yield* Effect.forkChild(
              workflows.start("echo", { item: "second" }, { idempotencyKey: "race" }),
            );
            yield* Deferred.await(loserCanReadHolder);
            const { runId } = yield* Fiber.join(second);
            yield* Deferred.succeed(loserExecuted, undefined);
            const firstResult = yield* Fiber.join(first);
            assert.strictEqual(firstResult.runId, runId);

            const done = yield* workflows.waitFor(runId, (run) => run.status === "completed");
            assert.strictEqual(done.result, "first");
          }),
          engineLayer,
        ),
      ),
      Effect.forever(Effect.andThen(clock.await, TestClock.adjust("1 second"))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
