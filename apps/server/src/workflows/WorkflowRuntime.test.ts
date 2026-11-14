import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
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

/** Waits to be let go. */
const hold = `T3.workflow("hold", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
  Effect.map(T3.wait("go", { returns: Schema.String }), (said) => Option.getOrElse(said, () => "nobody")),
);
`;
const greet = (says: string) => `const { workflow } = T3;
workflow("greet", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
  Effect.succeed(${JSON.stringify(says)}),
);
`;

it.effect(
  "every file in the folder defines workflows, and a saved file is verified before it runs",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-defs-" });
      const directory = path.join(home, "workflows");
      const at = (name: string) => path.join(directory, name);
      yield* fileSystem.makeDirectory(directory);
      yield* fileSystem.writeFileString(at("hold.ts"), hold);
      const database = NodeSqliteClient.layer({ filename: path.join(home, "state.sqlite") });
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
          directory,
        ),
      );

      yield* Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
        const held = yield* workflows.start("hold", {}, { idempotencyKey: "h" });
        yield* workflows.waitFor(held.runId, (run) => run.status === "waiting");

        // A file that does not parse is not written, and says where it breaks.
        const broken = yield* definitions.save("greet.ts", "T3.workflow(\n  'x',\n];\n");
        assert.deepStrictEqual(
          broken.map((problem) => [problem.file, problem.line]),
          [["greet.ts", 3]],
        );
        // Nor is one that defines what another file already does, or drops what a run needs.
        const twice = yield* definitions.save("again.ts", hold);
        assert.include(twice[0]?.message ?? "", "hold@1 is defined twice, in again.ts and hold.ts");
        const dropped = yield* definitions.save("hold.ts", greet("hello"));
        assert.include(dropped[0]?.message ?? "", "hold@1 is no longer defined, and 1 of its runs");
        assert.include((yield* definitions.remove("hold.ts"))[0]?.message ?? "", "hold@1");
        assert.deepStrictEqual(
          (yield* definitions.read).files.map((file) => file.name),
          ["hold.ts"],
        );

        // A new file that passes is there from now on, and what it defines can be started.
        assert.deepStrictEqual(yield* definitions.save("greet.ts", greet("hello")), []);
        assert.equal(yield* fileSystem.readFileString(at("greet.ts")), greet("hello"));
        const greeted = yield* workflows.start("greet", {}, { idempotencyKey: "g" });
        const done = yield* workflows.waitFor(greeted.runId, (run) => run.status === "completed");
        assert.equal(done.result, "hello");
        // The run that was waiting came through the reload and can still be let go.
        yield* workflows.signal({ runId: held.runId, wait: "go" }, "go on", { id: "s1" });
        const freed = yield* workflows.waitFor(held.runId, (run) => run.status === "completed");
        assert.equal(freed.result, "go on");

        // Someone breaks a file outside the app: its last good version keeps running, and the
        // other files go on changing.
        const problem = (wanted: boolean) =>
          workflows.watch.pipe(
            Stream.filter((snapshot) => (snapshot.definition?.problem != null) === wanted),
            Stream.runHead,
          );
        yield* fileSystem.writeFileString(at("greet.ts"), "T3.workflow(");
        yield* problem(true);
        const read = yield* definitions.read;
        assert.deepStrictEqual(
          read.files.map((file) => [file.name, file.problems.length]),
          [
            ["greet.ts", 1],
            ["hold.ts", 0],
          ],
        );
        const still = yield* workflows.start("greet", {}, { idempotencyKey: "g2" });
        assert.equal(
          (yield* workflows.waitFor(still.runId, (run) => run.status === "completed")).result,
          "hello",
        );
        // And fixes it, saying something else.
        yield* fileSystem.writeFileString(at("greet.ts"), greet("hi"));
        yield* problem(false);
        const fixed = yield* workflows.start("greet", {}, { idempotencyKey: "g3" });
        assert.equal(
          (yield* workflows.waitFor(fixed.runId, (run) => run.status === "completed")).result,
          "hi",
        );
        // A file taken away takes its workflows with it.
        assert.deepStrictEqual(yield* definitions.remove("greet.ts"), []);
        const gone = yield* workflows
          .start("greet", {}, { idempotencyKey: "g4" })
          .pipe(Effect.flip);
        assert.equal(gone._tag, "WorkflowNotRegisteredError");
      }).pipe(
        Effect.provide(runtime),
        Effect.scoped,
        Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
