import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import Migration0092 from "../persistence/Migrations/092_Workflows.ts";
import Migration0093 from "../persistence/Migrations/093_WorkflowTriggers.ts";
import Migration0094 from "../persistence/Migrations/094_WorkflowStepEnvironment.ts";
import Migration0095 from "../persistence/Migrations/095_WorkflowRunInput.ts";
import Migration0096 from "../persistence/Migrations/096_WorkflowStore.ts";
import Migration0097 from "../persistence/Migrations/097_WorkflowRunParent.ts";
import Migration0098 from "../persistence/Migrations/098_WorkflowStepResult.ts";
import Migration0099 from "../persistence/Migrations/099_WorkflowStepSaid.ts";
import { WorkflowAgents } from "./WorkflowAgents.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowRuntime from "./WorkflowRuntime.ts";
import * as Workflows from "./Workflows.ts";

/** A definitions file: `hold` waits to be let go, and `extra` is whatever else it defines. */
const file = (
  extra: string,
  hold = true,
) => `export default ({ workflow, wait, Effect, Schema }) => [
${
  hold
    ? `  workflow("hold", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
    Effect.map(wait("go", { returns: Schema.String }), (said) => said.value ?? "nobody"),
  ),`
    : ""
}
${extra}
];
`;
const greet = `  workflow("greet", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
    Effect.succeed("hello"),
  ),`;

it.effect(
  "a saved definitions file is verified first, and one that passes runs without a restart",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-defs-" });
      const module = path.join(directory, "workflows.ts");
      yield* fileSystem.writeFileString(module, file(""));
      const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
      yield* Effect.provide(
        Effect.all(
          [
            Migration0092,
            Migration0093,
            Migration0094,
            Migration0095,
            Migration0096,
            Migration0097,
            Migration0098,
            Migration0099,
          ],
          { discard: true },
        ),
        database,
      );
      const runtime = Layer.effectContext(
        WorkflowRuntime.make(
          Effect.succeed((definitions) =>
            WorkflowEngine.layer(definitions).pipe(
              Layer.provide(Layer.mock(WorkflowAgents)({})),
              Layer.provide(database),
              Layer.provide(NodeCrypto.layer),
            ),
          ),
        ),
      ).pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ T3CODE_WORKFLOWS: module })),
        ),
      );

      yield* Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
        const held = yield* workflows.start("hold", {}, { idempotencyKey: "h" });
        yield* workflows.waitFor(held.runId, (run) => run.status === "waiting");

        // A file that does not parse is not written, and says where it breaks.
        const broken = yield* definitions.save(
          "export default ({ workflow }) => [\n  workflow(\n];\n",
        );
        assert.equal(broken.length, 1);
        assert.equal(broken[0]?.line, 3);
        // Nor is one that drops a version a run still needs.
        const dropped = yield* definitions.save(file(greet, false));
        assert.include(
          dropped[0]?.message ?? "",
          "hold@1 is gone from the file, and 1 of its runs",
        );
        assert.equal(yield* fileSystem.readFileString(module), file(""));
        assert.isNull((yield* definitions.read)?.problem);

        // One that passes is the file from now on, and what it defines can be started.
        assert.deepStrictEqual(yield* definitions.save(file(greet)), []);
        assert.equal((yield* definitions.read)?.source, file(greet));
        const greeted = yield* workflows.start("greet", {}, { idempotencyKey: "g" });
        const done = yield* workflows.waitFor(greeted.runId, (run) => run.status === "completed");
        assert.equal(done.result, "hello");
        // The run that was waiting came through the reload and can still be let go.
        yield* workflows.signal({ runId: held.runId, wait: "go" }, "go on", { id: "s1" });
        const let_go = yield* workflows.waitFor(held.runId, (run) => run.status === "completed");
        assert.equal(let_go.result, "go on");

        // Someone edits the file outside the app and breaks it: the last good one keeps running.
        const problem = (wanted: boolean) =>
          workflows.watch.pipe(
            Stream.filter((snapshot) => (snapshot.definition?.problem != null) === wanted),
            Stream.runHead,
          );
        yield* fileSystem.writeFileString(module, "export default 1;\n");
        yield* problem(true);
        assert.include((yield* definitions.read)?.problem ?? "", "does not export an array");
        const still = yield* workflows.start("greet", {}, { idempotencyKey: "g2" });
        yield* workflows.waitFor(still.runId, (run) => run.status === "completed");
        // And fixes it.
        yield* fileSystem.writeFileString(module, file(""));
        yield* problem(false);
        const gone = yield* workflows
          .start("greet", {}, { idempotencyKey: "g3" })
          .pipe(Effect.flip);
        assert.equal(gone._tag, "WorkflowNotRegisteredError");
      }).pipe(
        Effect.provide(runtime),
        Effect.scoped,
        Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
