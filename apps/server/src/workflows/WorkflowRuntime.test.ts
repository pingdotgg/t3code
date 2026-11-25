import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import WorkflowsMigration from "../persistence/Migrations/110_Workflows.ts";
import WorkflowSkippedRunsMigration from "../persistence/Migrations/113_WorkflowSkippedRuns.ts";
import WorkflowRunTagsMigration from "../persistence/Migrations/115_WorkflowRunTags.ts";
import { type AgentResult, WorkflowAgents } from "./WorkflowAgents.ts";
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
  agents?: WorkflowAgents["Service"],
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
    Effect.andThen(WorkflowsMigration, WorkflowSkippedRunsMigration).pipe(
      Effect.andThen(WorkflowRunTagsMigration),
    ),
    database,
  );
  const made = WorkflowRuntime.make(
    Effect.succeed(
      (definitions: ReadonlyArray<WorkflowDefinition>) =>
        engine?.(definitions) ??
        WorkflowEngine.layer(definitions).pipe(
          Layer.provide(
            agents === undefined
              ? Layer.mock(WorkflowAgents)({})
              : Layer.succeed(WorkflowAgents, agents),
          ),
          Layer.provide(database),
          Layer.provide(NodeCrypto.layer),
        ),
    ),
    directory,
    Effect.succeed(true),
  ).pipe(Effect.provideService(FileSystem.FileSystem, wrap(fileSystem)));
  return { fileSystem, at, directory, made, runtime: Layer.effectContext(made) };
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
        const banana = yield* definitions.save(
          "banana.ts",
          'T3.workflow("banana", { version: 1, payload: T3.Tick, triggers: [T3.every("banana")] }, () => Effect.void);\n',
        );
        assert.include(banana.problems[0]?.message ?? "", 'Write one such as "5 minutes"');
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
          Workflows.wholeLists(workflows.watch).pipe(
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
        // A file the folder's naming leaves out says so, instead of never running without a word.
        yield* fileSystem.writeFileString(at("my flow.ts"), other);
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
        assert.deepStrictEqual(
          (yield* definitions.read).problems.map((problem) => problem.file),
          ["my flow.ts"],
        );
        yield* fileSystem.remove(at("my flow.ts"));
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
          Workflows.wholeLists(workflows.watch).pipe(
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
          Stream.runHead(Workflows.wholeLists(workflows.watch)),
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
        yield* Workflows.wholeLists(workflows.watch).pipe(
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
          (yield* Stream.runHead(Workflows.wholeLists(workflows.watch))).pipe(Option.getOrThrow)
            .definition?.problem ?? "",
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

it.effect("a file loads whatever kinds its asks name, and only a malformed `asks` is refused", () =>
  Effect.gen(function* () {
    const { at, fileSystem } = yield* setup();
    const sorter = (asks: string) => `const { workflow, ask } = T3;
workflow("sorter", { version: 1, payload: Schema.Struct({})${asks} }, () =>
  ask("sort", { kind: "feture", title: "Which way?", choices: ["Yes", "No"] }),
);
`;
    // A kind the workflow does not declare, and one on a workflow that declares none.
    for (const asks of [', asks: { feature: "Feature wanted?" }', ""]) {
      yield* fileSystem.writeFileString(at("sorter.ts"), sorter(asks));
      const loaded = yield* WorkflowRuntime.loadDefinitions(at("sorter.ts"), asks.length);
      assert.deepStrictEqual(
        loaded.map((definition) => Object.keys(definition.asks)),
        [asks === "" ? [] : ["feature"]],
      );
    }
    yield* fileSystem.writeFileString(at("sorter.ts"), sorter(', asks: { feature: "" }'));
    const refused = yield* WorkflowRuntime.loadDefinitions(at("sorter.ts"), 1).pipe(Effect.flip);
    assert.include(String(refused.cause), 'asks gives the kind "feature" no label');
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
      import * as Context from "effect/Context";
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

it.effect("a change held back by a run goes in once that run ends, with no further edit", () =>
  Effect.gen(function* () {
    // The folder's changes are told by hand, so the test does not hang on a watcher starting.
    const changed = yield* Queue.unbounded<FileSystem.WatchEvent>();
    const { fileSystem, at, runtime } = yield* setup((fileSystem) => ({
      ...fileSystem,
      watch: () => Stream.fromQueue(changed),
    }));
    yield* Effect.gen(function* () {
      const workflows = yield* Workflows.Workflows;
      const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
      const held = yield* workflows.start("hold", {}, { idempotencyKey: "h" });
      yield* workflows.waitFor(held.runId, (run) => run.status === "waiting");
      const problem = (wanted: boolean) =>
        Workflows.wholeLists(workflows.watch).pipe(
          Stream.filter((snapshot) => (snapshot.definition?.problem != null) === wanted),
          Stream.runHead,
        );
      yield* fileSystem.writeFileString(at("hold.ts"), greet("hello"));
      yield* Queue.offer(changed, { _tag: "Update", path: at("hold.ts") });
      yield* problem(true);
      yield* workflows.signal({ runId: held.runId, wait: "go" }, "go on", { id: "s1" });
      yield* workflows.waitFor(held.runId, (run) => run.status === "completed");
      // Nothing is told of the folder now: the held change goes in on its own.
      yield* problem(false);
      assert.deepStrictEqual(
        (yield* definitions.read).files.map((file) => file.workflows),
        [["greet@1"]],
      );
    }).pipe(
      Effect.provide(runtime),
      Effect.scoped,
      Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a reload does not wait for an agent that is still at work, and its step ends with the turn",
  () =>
    Effect.gen(function* () {
      const ended = yield* Deferred.make<AgentResult>();
      const started = yield* Deferred.make<void>();
      const { fileSystem, at, runtime } = yield* setup(undefined, undefined, {
        start: (input) =>
          Effect.as(Deferred.succeed(started, undefined), {
            threadId: "thread",
            turnId: input.key,
          }),
        result: () => Deferred.await(ended),
        interrupt: () => Effect.succeed("stopped" as const),
      });
      yield* fileSystem.writeFileString(
        at("helper.ts"),
        `T3.workflow("helper", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
  Effect.map(T3.agent("work", { brief: "Do it.", project: "p" }), (done) => done.value),
);
`,
      );
      const ticking = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.raceFirst(effect, Effect.forever(TestClock.adjust("1 second")));
      yield* Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const definitions = yield* WorkflowRuntime.WorkflowDefinitions;
        const helped = yield* ticking(
          Effect.gen(function* () {
            const run = yield* workflows.start("helper", {}, { idempotencyKey: "a" });
            yield* Deferred.await(started);
            yield* workflows.waitFor(run.runId, (row) => row.status === "waiting");
            return run;
          }),
        );

        // The test clock stands still during the save, so an engine that waited for the agent's
        // step to finish would never stop: the step is not given up on, and the turn does not end.
        // The swap cannot be interrupted, so a stuck save is unblocked by ending the turn.
        const saving = yield* Effect.forkChild(definitions.save("greet.ts", greet("hello")));
        const saved = yield* Fiber.await(saving).pipe(
          Effect.timeoutOption("10 seconds"),
          TestClock.withLive,
        );
        if (Option.isNone(saved)) {
          yield* Deferred.succeed(ended, { ending: "completed", detail: "", reply: "late" });
          yield* ticking(Fiber.await(saving));
          assert.fail("The reload waited for the agent's turn to end.");
        }
        assert.isTrue(Exit.isSuccess(saved.value) && saved.value.value.changed);
        assert.equal((yield* workflows.get(helped.runId)).run.status, "waiting");

        // The turn ends after the reload, and the new engine carries its result into the run.
        yield* Deferred.succeed(ended, { ending: "completed", detail: "", reply: "all done" });
        const done = yield* ticking(
          workflows.waitFor(helped.runId, (run) => run.status === "completed"),
        );
        assert.equal(done.result, "all done");
      }).pipe(Effect.provide(runtime), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "workflows are off until turned on, and a run left waiting when they are turned off goes on once they are on again",
  () =>
    Effect.gen(function* () {
      const { fileSystem, at, directory, made } = yield* setup();
      // Its top level counts the times it was loaded.
      yield* fileSystem.writeFileString(
        at("counted.ts"),
        "globalThis.t3GatedLoads = (globalThis.t3GatedLoads ?? 0) + 1;\nexport default [];\n",
      );
      const loads = () => (globalThis as { t3GatedLoads?: number }).t3GatedLoads ?? 0;
      yield* Effect.gen(function* () {
        const { turn, context } = yield* WorkflowRuntime.gate(made, directory);
        const workflows = Context.get(context, Workflows.Workflows);
        const definitions = Context.get(context, WorkflowRuntime.WorkflowDefinitions);
        const start = workflows.start("hold", {}, { idempotencyKey: "h" });

        assert.equal((yield* Effect.flip(start)).message, Workflows.OFF);
        assert.equal((yield* Effect.flip(workflows.list())).message, Workflows.OFF);
        assert.deepStrictEqual((yield* definitions.read).files, []);
        assert.equal(loads(), 0);

        yield* turn(true);
        assert.equal(loads(), 1);
        const held = yield* start;
        yield* workflows.waitFor(held.runId, (run) => run.status === "waiting");

        yield* turn(false);
        const signal = workflows.signal({ runId: held.runId, wait: "go" }, "go on", { id: "s1" });
        assert.equal((yield* Effect.flip(signal)).message, Workflows.OFF);

        yield* turn(true);
        yield* signal;
        const freed = yield* workflows.waitFor(held.runId, (run) => run.status === "completed");
        assert.equal(freed.result, "go on");
      }).pipe(Effect.scoped, Effect.raceFirst(Effect.forever(TestClock.adjust("1 second"))));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
