import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import Migration0100 from "../persistence/Migrations/106_Workflows.ts";
import Migration0101 from "../persistence/Migrations/107_WorkflowTriggers.ts";
import Migration0102 from "../persistence/Migrations/108_WorkflowStepEnvironment.ts";
import Migration0103 from "../persistence/Migrations/109_WorkflowRunInput.ts";
import Migration0104 from "../persistence/Migrations/110_WorkflowStore.ts";
import Migration0105 from "../persistence/Migrations/111_WorkflowRunParent.ts";
import Migration0106 from "../persistence/Migrations/112_WorkflowStepResult.ts";
import Migration0107 from "../persistence/Migrations/113_WorkflowWaitWatch.ts";
import Migration0108 from "../persistence/Migrations/114_WorkflowStepTurn.ts";
import Migration0109 from "../persistence/Migrations/115_WorkflowRunKey.ts";
import { WorkflowAgents } from "./WorkflowAgents.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowRuntime from "./WorkflowRuntime.ts";
import { engineTag, type WorkflowDefinition } from "./workflow.ts";
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

/**
 * A folder holding `hold.ts`, and the workflow runtime over it on a fresh database. `engine`
 * stands in for the real one, which needs the clock to run for as long as it is up.
 */
const setup = Effect.fn("setup")(function* (
  wrap: (fileSystem: FileSystem.FileSystem) => FileSystem.FileSystem = (fileSystem) => fileSystem,
  engine?: (definitions: ReadonlyArray<WorkflowDefinition>) => Layer.Layer<Workflows.Workflows>,
) {
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
        Migration0100,
        Migration0101,
        Migration0102,
        Migration0103,
        Migration0104,
        Migration0105,
        Migration0106,
        Migration0107,
        Migration0108,
        Migration0109,
      ],
      { discard: true },
    ),
    database,
  );
  const runtime = Layer.effectContext(
    WorkflowRuntime.make(
      Effect.succeed(
        (definitions: ReadonlyArray<WorkflowDefinition>) =>
          engine?.(definitions) ??
          WorkflowEngine.layer(definitions).pipe(
            Layer.provide(Layer.mock(WorkflowAgents)({})),
            Layer.provide(database),
            Layer.provide(NodeCrypto.layer),
          ),
      ),
      directory,
      Effect.succeed(true),
    ).pipe(Effect.provideService(FileSystem.FileSystem, wrap(fileSystem))),
  );
  return { fileSystem, at, runtime };
});

it.effect(
  "every file in the folder defines workflows, and a saved file is verified before it runs",
  () =>
    Effect.gen(function* () {
      const { fileSystem, at, runtime } = yield* setup();

      yield* Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
        const held = yield* workflows.start("hold", {}, { idempotencyKey: "h" });
        yield* workflows.waitFor(held.runId, (run) => run.status === "waiting");

        // A file that does not parse is not written, and says where it breaks.
        const broken = yield* definitions.save("greet.ts", "T3.workflow(\n  'x',\n];\n");
        assert.isFalse(broken.changed);
        assert.deepStrictEqual(
          broken.problems.map((problem) => [problem.file, problem.line]),
          [["greet.ts", 3]],
        );
        // Nor is one that defines what another file already does, or drops what a run needs.
        const twice = yield* definitions.save("again.ts", hold);
        assert.include(
          twice.problems[0]?.message ?? "",
          "hold@1 is defined twice, in again.ts and hold.ts",
        );
        const dropped = yield* definitions.save("hold.ts", greet("hello"));
        assert.include(
          dropped.problems[0]?.message ?? "",
          "hold@1 is no longer defined, and 1 of its runs",
        );
        // Nor one that exports something shaped like a workflow without what the engine walks.
        const shaped = yield* definitions.save(
          "shaped.ts",
          'export default [{ name: "shaped", version: 1, body: () => Effect.void }];\n',
        );
        assert.include(shaped.problems[0]?.message ?? "", "is not a workflow");
        // Nor one with an option nothing reads, or a time a schedule cannot fire at.
        const misspelt = yield* definitions.save(
          "misspelt.ts",
          'T3.workflow("misspelt", { version: 1, payload: Schema.Struct({}), retries: 2 }, () => Effect.void);\n',
        );
        assert.include(misspelt.problems[0]?.message ?? "", "does not take `retries`");
        const late = yield* definitions.save(
          "late.ts",
          'T3.workflow("late", { version: 1, payload: T3.Tick, triggers: [T3.daily("9am")] }, () => Effect.void);\n',
        );
        assert.include(late.problems[0]?.message ?? "", "24-hour time");
        const twoHooks = yield* definitions.save(
          "hooks.ts",
          'T3.workflow("hooks", { version: 1, payload: T3.WebhookRequest, triggers: [T3.webhook("in"), T3.webhook("in")] }, () => Effect.void);\n',
        );
        assert.include(twoHooks.problems[0]?.message ?? "", 'two hooks named "in"');
        assert.include((yield* definitions.remove("hold.ts")).problems[0]?.message ?? "", "hold@1");
        assert.deepStrictEqual(
          (yield* definitions.read).files.map((file) => file.name),
          ["hold.ts"],
        );
        // The same change made outside the app is refused as a whole: the file still reads as the
        // version that runs, until it is put back.
        const told = (wanted: boolean) =>
          workflows.watch.pipe(
            Stream.filter((snapshot) => (snapshot.definition?.problem != null) === wanted),
            Stream.runHead,
          );
        yield* fileSystem.writeFileString(at("hold.ts"), greet("hello"));
        yield* told(true);
        assert.deepStrictEqual(
          (yield* definitions.read).files.map((file) => file.workflows),
          [["hold@1"]],
        );
        // Only that file is held back: another file's change still runs, and the held one says why.
        const other =
          'T3.workflow("other", { version: 1, payload: Schema.Struct({}) }, () => Effect.void);\n';
        assert.deepStrictEqual(yield* definitions.save("other.ts", other), {
          changed: true,
          problems: [],
        });
        yield* workflows.start("other", {}, { idempotencyKey: "o" });
        assert.deepStrictEqual(
          (yield* definitions.read).files.map((file) => [file.name, file.problems.length]),
          [
            ["hold.ts", 1],
            ["other.ts", 0],
          ],
        );
        assert.deepStrictEqual(yield* definitions.remove("other.ts"), {
          changed: true,
          problems: [],
        });
        yield* fileSystem.writeFileString(at("hold.ts"), hold);
        yield* told(false);

        // A new file that passes is there from now on, and what it defines can be started.
        const saved = { changed: true, problems: [] };
        assert.deepStrictEqual(yield* definitions.save("greet.ts", greet("hello")), saved);
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
        // And fixes it, saying something else, this time as the file's one default export.
        yield* fileSystem.writeFileString(
          at("greet.ts"),
          greet("hi").replace("\nworkflow(", "\nexport default workflow("),
        );
        yield* problem(false);
        const fixed = yield* workflows.start("greet", {}, { idempotencyKey: "g3" });
        assert.equal(
          (yield* workflows.waitFor(fixed.runId, (run) => run.status === "completed")).result,
          "hi",
        );
        // A file taken away takes its workflows with it.
        assert.deepStrictEqual(yield* definitions.remove("greet.ts"), saved);
        const gone = yield* workflows
          .start("greet", {}, { idempotencyKey: "g4" })
          .pipe(Effect.flip);
        assert.equal(gone._tag, "WorkflowNotRegisteredError");
        // With no file left, nothing runs, and the runs that ended can still be read.
        assert.deepStrictEqual(yield* definitions.remove("hold.ts"), saved);
        assert.equal((yield* workflows.get(held.runId)).run.status, "completed");
        assert.includeMembers(
          (yield* workflows.list()).map((run) => run.runId),
          [held.runId, greeted.runId],
        );
      }).pipe(
        Effect.provide(runtime),
        Effect.scoped,
        Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a folder that cannot be listed keeps its workflows and is looked at again, and an engine that cannot start leaves the last one running",
  () =>
    Effect.gen(function* () {
      let refuse = false;
      // What each engine was built to run. One that registers `broken` does not come up.
      const builds: Array<ReadonlyArray<string>> = [];
      // No file events: only the runtime's own retry can pick up what changed.
      const { at, fileSystem, runtime } = yield* setup(
        (real) => ({
          ...real,
          exists: (target) =>
            refuse
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "exists",
                    pathOrDescriptor: target,
                  }),
                )
              : real.exists(target),
          watch: () => Stream.never,
        }),
        (definitions) =>
          definitions.some((definition) => definition.name === "broken")
            ? Layer.effect(Workflows.Workflows, Effect.die(new Error("broken took it down")))
            : Layer.sync(Workflows.Workflows, () => {
                builds.push(definitions.map(engineTag));
                return Workflows.disabled;
              }),
      );

      yield* Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
        const revision = Effect.map(
          Stream.runHead(workflows.watch),
          (snapshot) => Option.getOrThrow(snapshot).definition?.revision ?? 0,
        );
        refuse = true;
        // Written, but the folder could not be listed, so it is not said to run.
        const unlisted = yield* definitions.save("greet.ts", greet("hi"));
        assert.isTrue(unlisted.changed);
        assert.include(unlisted.problems[0]?.message ?? "", "could not be read");
        // What was loaded stays, and greet is not taken in yet.
        assert.deepStrictEqual(builds, [["hold@1"]]);
        const before = yield* revision;
        refuse = false;
        yield* TestClock.adjust("30 seconds");
        yield* workflows.watch.pipe(
          Stream.filter((snapshot) => (snapshot.definition?.revision ?? 0) > before),
          Stream.runHead,
        );
        assert.deepStrictEqual(builds.at(-1), ["greet@1", "hold@1"]);

        // A definition that passes the checks but takes the engine down at start changes nothing.
        yield* fileSystem.writeFileString(
          at("broken.ts"),
          'T3.workflow("broken", { version: 1, payload: Schema.Struct({}) }, () => Effect.void);\n',
        );
        const fellBack = yield* definitions.save("greet.ts", greet("hello"));
        assert.isTrue(fellBack.changed);
        assert.include(fellBack.problems[0]?.message ?? "", "did not start");
        assert.deepStrictEqual(builds.slice(1), [
          ["greet@1", "hold@1"],
          ["greet@1", "hold@1"],
        ]);
        assert.include(
          (yield* Stream.runHead(workflows.watch)).pipe(Option.getOrThrow).definition?.problem ??
            "",
          "did not start",
        );
      }).pipe(Effect.provide(runtime), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a file that never finishes loading is given up on, and later files still load", () =>
  Effect.gen(function* () {
    const { at, fileSystem } = yield* setup();
    yield* fileSystem.writeFileString(at("stuck.ts"), "await new Promise(() => {});\n");
    yield* fileSystem.writeFileString(at("greet.ts"), greet("hi"));
    const stuck = yield* WorkflowRuntime.loadDefinitions(at("stuck.ts"), 0, 50).pipe(Effect.flip);
    assert.include(String(stuck.cause), "did not finish loading");
    const loaded = yield* WorkflowRuntime.loadDefinitions(at("greet.ts"));
    assert.deepStrictEqual(
      loaded.map((definition) => definition.name),
      ["greet"],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a file given up on registers nothing into the file that loads after it", () =>
  Effect.gen(function* () {
    const { at, fileSystem } = yield* setup();
    yield* fileSystem.writeFileString(
      at("slow.ts"),
      'await new Promise((resolve) => { globalThis.t3TestResume = resolve; });\nT3.workflow("slow", { version: 1, payload: Schema.Struct({}) }, () => Effect.void);\n',
    );
    // The second file goes on loading until the first one's top level has run to its end.
    yield* fileSystem.writeFileString(
      at("next.ts"),
      `${greet("hi")}globalThis.t3TestResume();\nawait new Promise((resolve) => setImmediate(resolve));\n`,
    );
    yield* WorkflowRuntime.loadDefinitions(at("slow.ts"), 0, 50).pipe(Effect.flip);
    const loaded = yield* WorkflowRuntime.loadDefinitions(at("next.ts"));
    assert.deepStrictEqual(
      loaded.map((definition) => definition.name),
      ["greet"],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

// Vitest's module runner loads a file its own way; only Node keeps a CommonJS file by its path.
it.live("a file without imports or exports loads again after it changes", () =>
  Effect.gen(function* () {
    const { at, fileSystem } = yield* setup();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* fileSystem.writeFileString(at("greet.ts"), greet("hi"));
    const twice = `
      import * as NodeFS from "node:fs";
      import * as NodeServices from "@effect/platform-node/NodeServices";
      import * as Effect from "effect/Effect";
      import { loadDefinitions } from ${JSON.stringify(new URL("./WorkflowRuntime.ts", import.meta.url).href)};
      const file = process.argv.at(-1);
      const program = Effect.gen(function* () {
        const first = yield* loadDefinitions(file, 1);
        NodeFS.writeFileSync(file, NodeFS.readFileSync(file, "utf8").replace('"hi"', '"hello"'));
        const second = yield* loadDefinitions(file, 2);
        return [first.length, second.length];
      });
      console.log(JSON.stringify(await Effect.runPromise(Effect.provide(program, NodeServices.layer))));
    `;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        ["--input-type=module", "--eval", twice, at("greet.ts")],
        { cwd: import.meta.dirname },
      ),
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(stdout.trim(), "[1,1]", stderr);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
