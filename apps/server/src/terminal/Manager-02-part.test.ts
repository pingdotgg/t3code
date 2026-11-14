import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalOpenInput,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  TerminalProviderInstanceNotFoundError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "./Manager.ts";
import { terminalOutputStream } from "./OutputProtocol.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { FakePtyAdapter, GatedPtyAdapter, createManager, encodeUnknownJson, historyLogPath, layerWithHostPlatform, openInput, publishPastOutputBudget } from "./Manager-part2.testkit.ts";

vi.mock("effect/SynchronizedRef", async (importOriginal) => {
  const original = await importOriginal<typeof SynchronizedRef>();
  return { ...original, make: vi.fn(original.make) };
});

// The server omits DOM types, which include TypeScript's WebAssembly declarations.




import { retainedHistory } from "./Manager-fixtures.testkit.ts";
it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, DEFAULT_TERMINAL_ID);
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );
  it.effect("keeps attach streams live when a terminal id is closed and reopened", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.open(openInput());

      const events = yield* Ref.get(attachEvents);
      expect(events.map((event) => event.type)).toEqual(["snapshot", "closed", "snapshot"]);
      expect(
        events.filter((event) => event.type === "snapshot").map((event) => event.snapshot.status),
      ).toEqual(["running", "running"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );
  it.effect("tells every attached stream the shared PTY size when attaches disagree", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const wideEvents: TerminalAttachStreamEvent[] = [];
      const narrowEvents: TerminalAttachStreamEvent[] = [];
      const stopWide = yield* manager.attachStream(openInput({ cols: 130, rows: 15 }), (event) =>
        Effect.sync(() => {
          wideEvents.push(event);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopWide));
      const stopNarrow = yield* manager.attachStream(openInput({ cols: 54, rows: 15 }), (event) =>
        Effect.sync(() => {
          narrowEvents.push(event);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopNarrow));

      const spawned = ptyAdapter.spawnInputs[0]!;
      const ptySize = ptyAdapter.processes[0]!.resizeCalls.at(-1) ?? {
        cols: spawned.cols,
        rows: spawned.rows,
      };
      const lastReportedSize = (events: ReadonlyArray<TerminalAttachStreamEvent>) => {
        for (const event of events.toReversed()) {
          const source: Record<string, unknown> =
            event.type === "snapshot" ? event.snapshot : event;
          if (typeof source.cols === "number" && typeof source.rows === "number") {
            return { cols: source.cols, rows: source.rows };
          }
        }
        return null;
      };

      expect({
        wide: lastReportedSize(wideEvents),
        narrow: lastReportedSize(narrowEvents),
      }).toEqual({ wide: ptySize, narrow: ptySize });
    }),
  );
  it.effect("gives the PTY back to the remaining viewer when the narrowest one detaches", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const restored = yield* Deferred.make<void>();
      const stopWide = yield* manager.attachStream(
        openInput({ cols: 130, rows: 15 }),
        (event) =>
          event.type === "activity" && event.cols === 130 && event.rows === 15
            ? Deferred.succeed(restored, undefined).pipe(Effect.asVoid)
            : Effect.void,
        undefined,
        "wide",
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopWide));
      const stopNarrow = yield* manager.attachStream(
        openInput({ cols: 54, rows: 15 }),
        () => Effect.void,
        undefined,
        "narrow",
      );
      const process = ptyAdapter.processes[0]!;

      yield* manager.resize(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 80, rows: 12 },
        "narrow",
      );
      // A resize from a client with no attached stream cannot override attached viewers.
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 200,
        rows: 50,
      });
      expect(process.resizeCalls.at(-1)).toEqual({ cols: 80, rows: 12 });

      stopNarrow();
      yield* Deferred.await(restored);
      expect(process.resizeCalls.at(-1)).toEqual({ cols: 130, rows: 15 });
    }),
  );
  it.effect("keeps a viewer's resized grid when the same viewer attaches again", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const restored = yield* Deferred.make<void>();
      const stopWide = yield* manager.attachStream(
        openInput({ cols: 130, rows: 15 }),
        (event) =>
          event.type === "activity" && event.cols === 130 && event.rows === 15
            ? Deferred.succeed(restored, undefined).pipe(Effect.asVoid)
            : Effect.void,
        undefined,
        "wide",
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopWide));
      const stopFirst = yield* manager.attachStream(
        openInput({ cols: 54, rows: 15 }),
        () => Effect.void,
        undefined,
        "phone",
      );
      const process = ptyAdapter.processes[0]!;
      yield* manager.resize(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 100, rows: 15 },
        "phone",
      );

      const stopRetry = yield* manager.attachStream(
        { ...openInput({ cols: 54, rows: 15 }), resume: true },
        () => Effect.void,
        undefined,
        "phone",
      );
      expect(process.resizeCalls.at(-1)).toEqual({ cols: 100, rows: 15 });

      stopRetry();
      stopFirst();
      yield* Deferred.await(restored);
      expect(process.resizeCalls.at(-1)).toEqual({ cols: 130, rows: 15 });
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );
  it.effect("resumed attaches after close never respawn until the terminal is reopened", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        { ...openInput(), restartIfNotRunning: true, resume: true },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      expect((yield* Ref.get(attachEvents)).map((event) => event.type)).toEqual(["closed"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);

      yield* manager.open(openInput());
      const events = yield* Ref.get(attachEvents);
      expect(events.map((event) => event.type)).toEqual(["closed", "snapshot"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );
  it.effect("resumed attaches respect closes before this server has seen a terminal", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        { ...openInput(), restartIfNotRunning: true, resume: true },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      expect((yield* Ref.get(attachEvents)).map((event) => event.type)).toEqual(["closed"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );
  it.effect("resumed attaches leave exited and evicted terminals stopped", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });
      const exited = yield* Deferred.make<void>();
      const unsubscribeEvents = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeEvents));
      yield* manager.open(openInput());
      ptyAdapter.processes[0]?.emitExit({ exitCode: 0, signal: 0 });
      yield* Deferred.await(exited);

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        { ...openInput(), restartIfNotRunning: true, resume: true },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      expect(yield* Ref.get(attachEvents)).toEqual([
        { type: "snapshot", snapshot: expect.objectContaining({ status: "exited" }) },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);

      // Opening another terminal completes eviction before the next resumed attach.
      yield* manager.open(openInput({ threadId: "thread-2" }));
      const unsubscribeEvicted = yield* manager.attachStream(
        { ...openInput(), restartIfNotRunning: true, resume: true },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeEvicted));
      expect((yield* Ref.get(attachEvents)).map((event) => event.type)).toEqual([
        "snapshot",
        "closed",
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );
  it.effect("resumed attaches recreate terminals this server has never seen", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream({ ...openInput(), resume: true }, (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      expect(yield* Ref.get(attachEvents)).toEqual([
        { type: "snapshot", snapshot: expect.objectContaining({ status: "running" }) },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );
  it.effect("handles an exit replayed during subscription after publishing startup", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.exitOnSubscribe = { exitCode: 7, signal: null };
      const { manager, getEvents } = yield* createManager(5, { ptyAdapter });
      const exited = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      yield* Deferred.await(exited);
      const events = yield* getEvents;
      expect(events.map((event) => event.type)).toEqual(["started", "exited"]);
      expect(events[1]).toMatchObject({ exitCode: 7 });
      const attached: TerminalAttachStreamEvent[] = [];
      const stopAttach = yield* manager.attachStream(openInput(), (event) =>
        Effect.sync(() => {
          attached.push(event);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopAttach));
      expect(attached.find((event) => event.type === "snapshot")).toMatchObject({
        snapshot: { status: "exited", exitCode: 7 },
      });
    }),
  );
  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );
  it.effect("closes only a thread's idle shells, ignoring a helper forked from the shell", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "zsh" },
          { pid: 100, ppid: 9000, name: "zsh" },
          { pid: 9001, ppid: 1, name: "zsh" },
          { pid: 200, ppid: 9001, name: "node" },
          { pid: 9002, ppid: 1, name: "zsh" },
          { pid: 300, ppid: 9002, name: "zsh" },
          { pid: 301, ppid: 300, name: "sleep" },
          { pid: 9003, ppid: 1, name: "zsh" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput({ terminalId: "idle" }));
      yield* manager.open(openInput({ terminalId: "dev-server" }));
      yield* manager.open(openInput({ terminalId: "subshell" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
        true,
        false,
        false,
        false,
      ]);
    }),
  );
  it.effect("labels a running command by its whole process name, spaces included", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        processKillGraceMs: 0,
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "zsh" },
          { pid: 200, ppid: 9000, name: "Google Chrome" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("darwin")));
      const label = yield* Deferred.make<string>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "activity"
          ? Deferred.succeed(label, event.label).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      yield* TestClock.adjust("1 second");

      expect(yield* Deferred.await(label)).toBe("Google Chrome");
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect.each(["linux", "win32"] as const)(
    "reports activity from a slow but successful %s process-table query",
    (platform) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const queries: Array<{ start: number; end?: number }> = [];
        const { manager, getEvents } = yield* createFallbackManager(
          platform,
          slowProcessTable(platform, "5 seconds", queries, [started]),
        );

        yield* manager.open(openInput());
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");

        expect(
          (yield* getEvents).some(
            (event) =>
              event.type === "activity" && event.hasRunningSubprocess && event.label === "node",
          ),
        ).toBe(true);
        yield* manager.close({ threadId: "thread-1" });
      }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("idles at least as long as a slow process-table query took before the next", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const queries: Array<{ start: number; end?: number }> = [];
      const { manager } = yield* createFallbackManager(
        "linux",
        slowProcessTable("linux", "5 seconds", queries, [started]),
      );

      yield* manager.open(openInput());
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust(Duration.millis(19_999));

      expect(queries).toHaveLength(1);
      yield* TestClock.adjust("1 millis");
      const [slow, next] = queries;
      expect(next?.start).toBe(slow!.end! + 20_000);
      yield* manager.close({ threadId: "thread-1" });
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("ends a hung process-table query and paces the retry", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const queries: Array<{ start: number; end?: number }> = [];
      const { manager } = yield* createFallbackManager(
        "win32",
        slowProcessTable("win32", "1 day", queries, [started]),
      );

      yield* manager.open(openInput());
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(started);
      yield* TestClock.adjust("2 minutes");
      yield* TestClock.adjust("2 minutes");

      const [hung, next] = queries;
      expect(hung!.end! - hung!.start).toBe(15_000);
      expect(next!.start - hung!.end!).toBe(60_000);
      yield* manager.close({ threadId: "thread-1" });
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect.each([
    ["linux", 1_000],
    ["win32", 1_500],
  ] as const)(
    "bounds closeIdle's %s query so other operations on the thread still run",
    ([platform, budgetMs]) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const queries: Array<{ start: number; end?: number }> = [];
        const { manager, ptyAdapter } = yield* createFallbackManager(
          platform,
          slowProcessTable(platform, "1 day", queries, [started]),
        );
        yield* manager.open(openInput());

        const closing = yield* manager
          .closeIdle({ threadId: "thread-1" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        const resizing = yield* manager
          .resize({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 80, rows: 30 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(Duration.millis(budgetMs));

        expect(closing.pollUnsafe()).toBeDefined();
        expect(resizing.pollUnsafe()).toBeDefined();
        expect(queries[0]!.end! - queries[0]!.start).toBe(budgetMs);
        expect(ptyAdapter.processes[0]!.resizeCalls).toEqual([{ cols: 80, rows: 30 }]);
        expect(ptyAdapter.processes[0]!.killed).toBe(false);
        yield* manager.close({ threadId: "thread-1" });
      }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("keeps terminals that get input or output while closeIdle checks them", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      let duringCheck: (pid: number) => Effect.Effect<void> = () => Effect.void;
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        subprocessPollIntervalMs: 60_000,
        subprocessInspector: (pid) =>
          duringCheck(pid).pipe(
            Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
          ),
      });
      const outputSeen = yield* Deferred.make<void>();
      const unsubscribeOutput = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(outputSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeOutput));
      yield* manager.open(openInput({ terminalId: "typed" }));
      yield* manager.open(openInput({ terminalId: "echoed" }));
      const [typed, echoed] = ptyAdapter.processes;
      duringCheck = (pid) =>
        pid === typed!.pid
          ? manager
              .write({ threadId: "thread-1", terminalId: "typed", data: "make build\r" })
              .pipe(Effect.orDie)
          : Effect.gen(function* () {
              echoed!.emitData("make build\r\n");
              yield* Deferred.await(outputSeen);
            }).pipe(Effect.orDie);

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([false, false]);
    }),
  );
  it.effect("caps incrementally appended history without losing partial or empty lines", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\n");
      process.emitData("\n");
      process.emitData("line3");
      process.emitData("-continued\nline4");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).toBe("\nline3-continued\nline4");
    }),
  );


  // Which client owns the shared PTY size is left open by the issue, so this only asserts
  // that every attached renderer is told the grid the PTY actually has.


  // Client retries resend the first attach's size, which a later resize may have replaced.





  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );





  // Answers process-table queries after `queryDuration`, honoring the caller's
  // timeout the way ProcessRunner's `timedOutResult` mode does.
  const slowProcessTable = (
    platform: "linux" | "win32",
    queryDuration: Duration.Input,
    queries: Array<{ start: number; end?: number }>,
    started: ReadonlyArray<Deferred.Deferred<void>>,
  ): ProcessRunner.ProcessRunner["Service"] => ({
    run: (input) =>
      Effect.gen(function* () {
        const query: { start: number; end?: number } = { start: yield* Clock.currentTimeMillis };
        queries.push(query);
        const deferred = started[queries.length - 1];
        if (deferred) yield* Deferred.succeed(deferred, undefined);
        const completed = yield* Effect.sleep(queryDuration).pipe(
          Effect.timeoutOption(input.timeout ?? "1 hour"),
        );
        query.end = yield* Clock.currentTimeMillis;
        return {
          stdout: Option.isNone(completed)
            ? ""
            : platform === "win32"
              ? "100|9000|node.exe\n"
              : "  100  9000 node\n",
          stderr: "",
          code: Option.isSome(completed) ? ChildProcessSpawner.ExitCode(0) : null,
          timedOut: Option.isNone(completed),
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

  const createFallbackManager = (
    platform: "linux" | "win32",
    runner: ProcessRunner.ProcessRunner["Service"],
  ) =>
    createManager(5, { subprocessPollIntervalMs: 1_000, processKillGraceMs: 0 }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(layerWithHostPlatform(platform)),
    );










































});
