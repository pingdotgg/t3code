import { fileURLToPath } from "node:url";
import { expect, it } from "@alchemy.run/test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { FileSuite } from "../src/Model.ts";
import {
  Reporter,
  type ReporterService,
  type RunController,
  type RunSummary,
  type TestMeta,
  type TestResult,
} from "../src/Reporter.ts";
import { run } from "../src/Runner.ts";

const api = new URL("../src/index.ts", import.meta.url).href;
const registry = new URL("../src/Registry.ts", import.meta.url).href;
const effect = import.meta.resolve("effect/Effect");

const setup = Effect.fn(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-runner-lifecycle-",
  });
  yield* fs.writeFileString(
    path.join(root, "state.ts"),
    "export const events = []; export const roots = []; export const pids = new Set();",
  );
  for (const [name, body] of Object.entries(files)) {
    yield* fs.writeFileString(
      path.join(root, name),
      `
      import { it, describe, registerHook, registerFileCleanup } from ${JSON.stringify(api)};
      import { currentFileSuite } from ${JSON.stringify(registry)};
      import * as Effect from ${JSON.stringify(effect)};
      import { events, roots, pids } from "./state.ts";
      roots.push(currentFileSuite());
      pids.add(process.pid);
      const mark = (label) => Effect.sync(() => { events.push(label); });
      ${body}
    `,
    );
  }
  const state = yield* Effect.promise(() => import(path.join(root, "state.ts"))) as Effect.Effect<{
    events: string[];
    roots: FileSuite[];
    pids: Set<number>;
  }>;
  return {
    state,
    options: {
      root,
      paths: [root],
      timeout: 1000,
      retry: 0,
      concurrency: 1,
      sequential: true,
      logFile: path.join(root, "run.log"),
    } as const,
  };
});

it.live("interrupts active bodies before cleanup and disposes queued files", () =>
  Effect.gen(function* () {
    const { state, options } = yield* setup({
      "a.test.ts": `
        registerFileCleanup({ body: () => mark("active-clean") });
        registerHook("afterAll", { body: () => mark("after") });
        it.live("active", () => mark("body").pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(mark("body-finalized")),
        ));`,
      "b.test.ts": `
        registerFileCleanup({ body: () => mark("queued-clean") });
        registerHook("afterAll", { body: () => mark("queued-after") });
        it("queued", () => events.push("queued-body"));`,
    });
    const fiber = yield* Effect.scoped(run(options)).pipe(Effect.forkChild);
    const started = yield* Effect.sync(() => state.events.includes("body")).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        times: 100,
        until: (value) => value,
      }),
    );
    expect(started).toBe(true);
    yield* Fiber.interrupt(fiber);
    expect(state.events).toEqual([
      "body",
      "body-finalized",
      "after",
      "active-clean",
      "queued-clean",
    ]);
    expect(state.roots.every((root) => root.children.length === 0)).toBe(true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        Layer.succeed(Reporter, {
          emit: () => Effect.void,
          waitForExit: () => Effect.void,
        }),
      ),
    ),
  ),
);

const silent: ReporterService = {
  emit: () => Effect.void,
  waitForExit: () => Effect.void,
};

it.live("preserves duplicate-title failures and the CLI exit code", () => {
  let announced: ReadonlyArray<TestMeta> = [];
  const ended: Array<{ meta: TestMeta; result: TestResult }> = [];
  const reporter: ReporterService = {
    waitForExit: () => Effect.void,
    emit: (event) =>
      Effect.sync(() => {
        if (event._tag === "RunStart") announced = event.tests;
        if (event._tag === "TestEnd") ended.push({ meta: event.test, result: event.result });
      }),
  };
  return Effect.gen(function* () {
    const { state, options } = yield* setup({
      "duplicates.test.ts": `
        it.live("duplicate", () => Effect.log("duplicate-failure-output").pipe(
          Effect.andThen(Effect.fail(new Error("duplicate-failure"))),
        ));
        it("duplicate", () => {});
        it.skip("duplicate", () => {});
        it.todo("duplicate");
        it.each([{ label: "same", fail: true }, { label: "same", fail: false }])(
          "parameter $label",
          ({ fail }) => { if (fail) throw new Error("parameter-failure"); },
        );
        it("filtered", () => { throw new Error("must-not-run"); });`,
    });
    const summary = yield* Effect.scoped(
      run({
        ...options,
        filter: (title) => /duplicate$|parameter same$/.test(title),
      }),
    );
    expect(announced.map((meta) => meta.titlePath)).toEqual([
      ["duplicate"],
      ["duplicate"],
      ["duplicate"],
      ["duplicate"],
      ["parameter same"],
      ["parameter same"],
    ]);
    expect(new Set(announced.map((meta) => meta.id)).size).toBe(6);
    expect(ended.map(({ meta }) => meta.id)).toEqual(announced.map((meta) => meta.id));
    expect(ended.map(({ result }) => result.status)).toEqual([
      "fail",
      "pass",
      "skip",
      "todo",
      "fail",
      "pass",
    ]);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.todo).toBe(1);
    expect(summary.failures.map(({ meta }) => meta.id)).toEqual([
      announced[0]!.id,
      announced[4]!.id,
    ]);
    expect(state.roots[0]!.children.length).toBe(0);
    const fs = yield* FileSystem.FileSystem;
    const log = yield* fs.readFileString(options.logFile);
    expect(log).toContain("[test duplicates.test.ts > duplicate] duplicate-failure-output");

    const executable = yield* Effect.sync(() => process.execPath);
    const cli = yield* Effect.sync(() =>
      fileURLToPath(new URL("../bin/alchemy-test.ts", import.meta.url)),
    );
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* ChildProcess.make(
          executable,
          [
            cli,
            options.root,
            "--retry",
            "0",
            "--concurrency",
            "1",
            "-t",
            "duplicate$|parameter same$",
          ],
          {
            cwd: options.root,
            env: { NO_COLOR: "1" },
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: "1 second",
          },
        );
        return yield* Effect.all(
          {
            code: child.exitCode,
            stdout: child.stdout.pipe(
              Stream.decodeText,
              Stream.runCollect,
              Effect.map((chunks) => chunks.join("")),
            ),
            stderr: child.stderr.pipe(
              Stream.decodeText,
              Stream.runCollect,
              Effect.map((chunks) => chunks.join("")),
            ),
          },
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.timeout("20 seconds")),
    );
    expect(output.code).toBe(1);
    expect(`${output.stdout}\n${output.stderr}`).toContain(
      "Tests: 2 failed | 2 passed | 1 skipped | 1 todo",
    );
    expect(output.stdout).toContain("duplicate-failure");
    expect(output.stdout).toContain("parameter-failure");
    expect(output.stdout).not.toContain("must-not-run");
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Reporter, reporter))));
});

it.live("retries only the selected duplicate-title test", () =>
  Effect.gen(function* () {
    const retried = yield* Deferred.make<void>();
    let controller: RunController | undefined;
    let announced: ReadonlyArray<TestMeta> = [];
    const started: string[] = [];
    const ended: Array<{ meta: TestMeta; result: TestResult }> = [];
    const reporter: ReporterService = {
      waitForExit: () => Effect.void,
      attachController: (value) =>
        Effect.sync(() => {
          controller = value;
        }),
      emit: (event) =>
        Effect.gen(function* () {
          if (event._tag === "RunStart") announced = event.tests;
          if (event._tag === "TestStart") started.push(event.test.id);
          if (event._tag === "TestEnd") {
            ended.push({ meta: event.test, result: event.result });
            if (ended.length === 3) yield* Deferred.succeed(retried, undefined);
          }
        }),
    };
    yield* Effect.gen(function* () {
      const { state, options } = yield* setup({
        "duplicates.test.ts": `
          registerFileCleanup({ body: () => mark("clean") });
          let attempts = 0;
          it("duplicate", () => {
            events.push("first");
            if (++attempts <= 2) throw new Error("first-attempts");
          }, { retry: 1 });
          it("duplicate", () => events.push("second"));`,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const summary = yield* run(options);
          expect(announced).toHaveLength(2);
          expect(announced[0]!.id).not.toBe(announced[1]!.id);
          expect(summary.failed).toBe(1);
          expect(summary.passed).toBe(1);
          expect(ended[0]!.result.retries).toBe(1);
          expect(state.events).toEqual(["first", "first", "second"]);
          yield* Effect.sync(() => controller!.retryTest(announced[0]!.id));
          yield* Deferred.await(retried).pipe(Effect.timeout("5 seconds"));
          const ids = [announced[0]!.id, announced[1]!.id, announced[0]!.id];
          expect(started).toEqual(ids);
          expect(ended.map(({ meta }) => meta.id)).toEqual(ids);
          expect(ended.map(({ result }) => result.status)).toEqual(["fail", "pass", "pass"]);
          expect(state.events).toEqual(["first", "first", "second", "first"]);
          expect(summary.failed).toBe(0);
          expect(summary.passed).toBe(2);
          expect(summary.failures).toHaveLength(0);
        }),
      );
      expect(state.events).toEqual(["first", "first", "second", "first", "clean"]);
      expect(state.roots[0]!.children.length).toBe(0);
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Reporter, reporter))));
  }),
);

it.live("persists full output while keeping reporter previews bounded", () =>
  Effect.gen(function* () {
    const { options } = yield* setup({
      "a.test.ts": `it.live("large-output", () => Effect.log("START-OF-OUTPUT:" + "x".repeat(600000) + ":END-OF-OUTPUT"));`,
    });
    let preview = "";
    const reporter: ReporterService = {
      waitForExit: () => Effect.void,
      emit: (event) =>
        Effect.sync(() => {
          if (event._tag === "TestEnd")
            preview = event.result.logs.map((entry) => entry.message).join("\n");
        }),
    };
    yield* Effect.scoped(run(options).pipe(Effect.provide(Layer.succeed(Reporter, reporter))));
    const fs = yield* FileSystem.FileSystem;
    const full = yield* fs.readFileString(options.logFile);
    expect(full).toContain("START-OF-OUTPUT:" + "x".repeat(600000) + ":END-OF-OUTPUT");
    expect(preview.length).toBeLessThan(256 * 1024);
    expect(preview).toContain("omitted from preview");
    expect(preview).toContain(":END-OF-OUTPUT");
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("finishes all file cleanups when interrupted during disposal", () =>
  Effect.gen(function* () {
    const { state, options } = yield* setup({
      "a.test.ts": `
        registerFileCleanup({ body: () => mark("cleanup-start").pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.andThen(mark("first-clean"))) });
        registerFileCleanup({ body: () => mark("second-clean") });
        it("body", () => {});`,
    });
    const fiber = yield* Effect.scoped(run(options)).pipe(Effect.forkChild);
    yield* Effect.sync(() => state.events.includes("cleanup-start")).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 millis"),
        times: 100,
        until: (value) => value,
      }),
    );
    yield* Fiber.interrupt(fiber);
    expect(state.events).toEqual(["cleanup-start", "first-clean", "second-clean"]);
    expect(state.roots[0]!.children.length).toBe(0);
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Reporter, silent)))),
);

it.live("queues interactive retries until the original file finishes user teardown", () =>
  Effect.gen(function* () {
    const { state, options } = yield* setup({
      "a.test.ts": `
        registerHook("afterAll", { body: () => mark("after") });
        registerFileCleanup({ body: () => mark("clean") });
        it("a", () => events.push("a"));
        it.live("b", () => mark("b").pipe(Effect.andThen(Effect.sleep("50 millis"))));`,
    });
    const retried = yield* Deferred.make<void>();
    let controller: RunController | undefined;
    let completions = 0;
    const reporter: ReporterService = {
      waitForExit: () => Effect.void,
      attachController: (value) =>
        Effect.sync(() => {
          controller = value;
        }),
      emit: (event) =>
        Effect.gen(function* () {
          if (event._tag === "TestEnd" && event.test.name === "a") {
            if (++completions === 1) controller!.retryTest(event.test.id);
            else yield* Deferred.succeed(retried, undefined);
          }
        }),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const summary = yield* run(options);
        yield* Deferred.await(retried).pipe(Effect.timeout("5 seconds"));
        expect(summary.passed).toBe(2);
      }).pipe(Effect.provide(Layer.succeed(Reporter, reporter))),
    );
    expect(state.events).toEqual(["a", "b", "after", "a", "clean"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("cleans every file, including skipped, empty, filtered and failed imports", () =>
  Effect.gen(function* () {
    const { state, options } = yield* setup({
      "a.test.ts": `
        registerFileCleanup({ body: () => mark("a-clean") });
        registerHook("afterAll", { body: () => mark("a-after") });
        it("runs", () => events.push("a-body"));`,
      "b.test.ts": `
        registerFileCleanup({ body: () => mark("b-clean") });
        registerHook("afterAll", { body: () => mark("b-after") });
        it.skip("skipped", () => {});`,
      "c.test.ts": `registerFileCleanup({ body: () => mark("c-clean") }); it.todo("todo");`,
      "d.test.ts": `registerFileCleanup({ body: () => mark("d-clean") });`,
      "e.test.ts": `
        registerFileCleanup({ body: () => mark("e-clean") });
        registerHook("afterAll", { body: () => mark("e-after") });
        it.only("partial", () => events.push("partial-body"));
        throw new Error("import-sentinel");`,
      "f.test.ts": `
        registerFileCleanup({ body: () => Effect.fail(new Error("cleanup-sentinel")) });
        registerFileCleanup({ body: () => mark("f-clean") });
        it("filtered", () => events.push("filtered-body"));`,
    });
    let summary: RunSummary | undefined;
    yield* Effect.scoped(
      Effect.gen(function* () {
        summary = yield* run({
          ...options,
          filter: (title) => !title.includes("filtered"),
        });
      }),
    ).pipe(Effect.exit);
    expect(state.events).toEqual([
      "a-body",
      "a-after",
      "a-clean",
      "b-clean",
      "c-clean",
      "d-clean",
      "e-clean",
      "f-clean",
    ]);
    expect(
      state.roots.every((root) => root.children.length === 0 && root.cleanups.length === 0),
    ).toBe(true);
    expect(summary?.passed).toBe(1);
    expect(summary?.skipped).toBe(1);
    expect(summary?.todo).toBe(1);
    expect(summary?.fileFailures.length).toBe(2);
    expect(state.pids.size).toBe(1);
    expect(state.events.filter((event) => event.endsWith("clean")).length).toBe(6);
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Reporter, silent)))),
);

it.live("preserves global only selection while disposing excluded file roots", () =>
  Effect.gen(function* () {
    const { state, options } = yield* setup({
      "a.test.ts": `registerFileCleanup({ body: () => mark("a-clean") }); it("excluded", () => events.push("excluded"));`,
      "b.test.ts": `registerFileCleanup({ body: () => mark("b-clean") }); it.only("selected", () => events.push("selected"));`,
    });
    const summary = yield* Effect.scoped(run(options));
    expect(summary.passed).toBe(1);
    expect(state.events).toEqual(["a-clean", "selected", "b-clean"]);
    expect(state.roots.every((root) => root.children.length === 0)).toBe(true);
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Reporter, silent)))),
);

it.live("keeps interactive retries alive until scope exit and then releases their roots", () =>
  Effect.gen(function* () {
    const { state, options } = yield* setup({
      "a.test.ts": `registerFileCleanup({ body: () => mark("clean") }); it("retryable", () => { events.push("body"); if (events.length === 1) throw new Error("first-attempt"); });`,
    });
    const retried = yield* Deferred.make<void>();
    let controller: RunController | undefined;
    let id = "";
    let ends = 0;
    const reporter: ReporterService = {
      waitForExit: () => Effect.void,
      attachController: (value) =>
        Effect.sync(() => {
          controller = value;
        }),
      emit: (event) =>
        Effect.gen(function* () {
          if (event._tag === "TestEnd") {
            id = event.test.id;
            if (++ends === 2) yield* Deferred.succeed(retried, undefined);
          }
        }),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const summary = yield* run(options);
        expect(summary.failed).toBe(1);
        expect(state.events).toEqual(["body"]);
        yield* Effect.sync(() => controller!.retryTest(id));
        yield* Deferred.await(retried).pipe(Effect.timeout("5 seconds"));
        expect(state.events).toEqual(["body", "body"]);
        expect(summary.failed).toBe(0);
        expect(summary.passed).toBe(1);
        expect(summary.failures.length).toBe(0);
      }).pipe(Effect.provide(Layer.succeed(Reporter, reporter))),
    );
    expect(state.events).toEqual(["body", "body", "clean"]);
    expect(state.roots[0]!.children.length).toBe(0);
    yield* Effect.sync(() => controller!.retryTest(id));
    expect(state.events).toEqual(["body", "body", "clean"]);
  }).pipe(Effect.provide(BunServices.layer)),
);
