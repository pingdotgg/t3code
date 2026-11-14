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
  it.effect("removes terminal metadata subscriptions when initial delivery fails", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const leakedLiveEvents = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        manager.subscribeMetadata((event) =>
          event.type === "snapshot"
            ? Effect.die("snapshot listener failed")
            : Ref.update(leakedLiveEvents, (count) => count + 1),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      yield* manager.open(openInput({ threadId: "new-thread" }));
      expect(yield* Ref.get(leakedLiveEvents)).toBe(0);
    }),
  );
  it.effect("finishes shell startup when its creating attachment is cancelled", () =>
    Effect.gen(function* () {
      const ptyAdapter = new GatedPtyAdapter();
      const { manager } = yield* createManager(5, { ptyAdapter });
      const input = openInput();
      const gate = {
        spawning: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      ptyAdapter.gate = gate;
      const consumer = yield* Stream.runDrain(
        terminalOutputStream(
          (listener, registerCleanup) => manager.attachStream(input, listener, registerCleanup),
          (listener, registerCleanup) => manager.resyncStream(input, listener, registerCleanup),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(gate.spawning);
      const cancelled = yield* Fiber.interrupt(consumer).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(cancelled);

      const snapshots: TerminalAttachStreamEvent[] = [];
      const stop = yield* manager.attachStream(input, (event) =>
        Effect.sync(() => {
          snapshots.push(event);
        }),
      );
      stop();
      expect(snapshots).toMatchObject([
        { type: "snapshot", snapshot: { status: "running", pid: ptyAdapter.processes[0]?.pid } },
      ]);
      expect(ptyAdapter.processes).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
  it.effect("resyncs bounded history and follows close/reopen across a stalled stream", () =>
    Effect.gen(function* () {
      const ptyAdapter = new GatedPtyAdapter();
      const historyByteLimit = 64 * 1024;
      const { manager } = yield* createManager(5, { ptyAdapter, historyByteLimit });
      const input = openInput();
      const pull = yield* Stream.toPull(
        terminalOutputStream(
          (listener, registerCleanup) => manager.attachStream(input, listener, registerCleanup),
          (listener, registerCleanup) => manager.resyncStream(input, listener, registerCleanup),
        ),
      );
      expect(yield* pull).toMatchObject([{ type: "snapshot", snapshot: { history: "" } }]);
      const process = ptyAdapter.processes[0]!;
      yield* publishPastOutputBudget(manager, process);

      const resumed = yield* pull;
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.type).toBe("snapshot");
      if (resumed[0]?.type !== "snapshot") throw new Error("Expected a recovery snapshot");
      expect(Buffer.byteLength(resumed[0].snapshot.history)).toBeLessThanOrEqual(historyByteLimit);
      expect(resumed[0].snapshot.history.endsWith("last\n")).toBe(true);
      process.emitData("after recovery\n");
      expect(yield* pull).toMatchObject([{ type: "output", data: "after recovery\n" }]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);

      yield* publishPastOutputBudget(manager, process);
      yield* manager.close(input);
      expect(yield* pull).toEqual([
        { type: "closed", threadId: input.threadId, terminalId: input.terminalId },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      yield* manager.open(input);
      expect(yield* pull).toMatchObject([
        { type: "snapshot", snapshot: { status: "running", pid: ptyAdapter.processes[1]!.pid } },
      ]);
      const reopenedProcess = ptyAdapter.processes[1]!;
      reopenedProcess.emitData("after reopen\n");
      expect(yield* pull).toMatchObject([{ type: "output", data: "after reopen\n" }]);

      yield* publishPastOutputBudget(manager, reopenedProcess);
      // Queue close/reopen ahead of recovery while another spawn owns the thread lock.
      const gate = {
        spawning: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      ptyAdapter.gate = gate;
      const holder = yield* manager
        .open(openInput({ terminalId: "other" }))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(gate.spawning);
      const closed = yield* manager.close(input).pipe(Effect.forkChild({ startImmediately: true }));
      const reopened = yield* manager
        .open(input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const recovery = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
      reopenedProcess.emitData("old session\n");
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(closed);
      yield* Fiber.join(reopened);

      const batch = yield* Fiber.join(recovery);
      expect(batch).toHaveLength(1);
      expect(batch[0]).toMatchObject({
        type: "snapshot",
        snapshot: { status: "running", pid: ptyAdapter.processes.at(-1)!.pid },
      });
      ptyAdapter.processes.at(-1)!.emitData("new session only\n");
      expect(yield* pull).toMatchObject([{ type: "output", data: "new session only\n" }]);
      expect(ptyAdapter.spawnInputs).toHaveLength(4);
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    { recovered: true, label: "after recovery" },
    { recovered: false, label: "when cancelled before recovery" },
  ])("keeps a stalled viewer's size until its attach stream ends ($label)", ({ recovered }) =>
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
      const process = ptyAdapter.processes[0]!;

      yield* Effect.gen(function* () {
        const pull = yield* Stream.toPull(
          manager.attachOutputStream(openInput({ cols: 54, rows: 15 }), "narrow"),
        );
        expect(yield* pull).toMatchObject([{ type: "snapshot" }]);
        expect(process.resizeCalls.at(-1)).toEqual({ cols: 54, rows: 15 });
        // Overflow releases the inner subscription before any recovery pull.
        yield* publishPastOutputBudget(manager, process);
        yield* manager.resize(
          { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 50, rows: 12 },
          "narrow",
        );
        expect(process.resizeCalls.at(-1)).toEqual({ cols: 50, rows: 12 });
        if (!recovered) return;

        expect(yield* pull).toMatchObject([{ type: "snapshot" }]);
        yield* manager.resize(
          { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 48, rows: 12 },
          "narrow",
        );
        expect(process.resizeCalls.at(-1)).toEqual({ cols: 48, rows: 12 });
      }).pipe(Effect.scoped);

      yield* Deferred.await(restored);
      expect(process.resizeCalls.at(-1)).toEqual({ cols: 130, rows: 15 });
    }).pipe(Effect.scoped),
  );
  it.effect("does not replay in-flight output already included in an observer snapshot", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const input = openInput();
      yield* manager.open(input);
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      // The snapshot sees history before this earlier fanout listener releases it.
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" && event.data === "in flight\n"
          ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      ptyAdapter.processes[0]!.emitData("in flight\n");
      yield* Deferred.await(reached);
      const observed: TerminalAttachStreamEvent[] = [];
      const stopObserving = yield* manager.observeStream(input, (event) =>
        Effect.gen(function* () {
          observed.push(event);
          if (event.type === "output" && event.data === "after\n") {
            yield* Deferred.succeed(delivered, undefined);
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopObserving));
      expect(observed).toMatchObject([{ type: "snapshot", snapshot: { history: "in flight\n" } }]);
      yield* Deferred.succeed(release, undefined);
      ptyAdapter.processes[0]!.emitData("after\n");
      yield* Deferred.await(delivered);
      expect(observed.filter((event) => event.type === "output")).toMatchObject([
        { data: "after\n" },
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("observes terminal history and live output without changing the process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput({ env: { OBSERVER_TEST: "original" } }));
      const process = ptyAdapter.processes[0]!;
      const historyReceived = yield* Deferred.make<void>();
      const unsubscribeHistory = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(historyReceived, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitData("existing history\n");
      yield* Deferred.await(historyReceived);
      unsubscribeHistory();

      const observed = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const liveReceived = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.observeStream(
        { threadId: opened.threadId, terminalId: opened.terminalId },
        (event) =>
          Ref.update(observed, (events) => [...events, event]).pipe(
            Effect.andThen(
              event.type === "output"
                ? Deferred.succeed(liveReceived, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      process.emitData("live output\n");
      yield* Deferred.await(liveReceived);

      expect(yield* Ref.get(observed)).toMatchObject([
        {
          type: "snapshot",
          snapshot: {
            cwd: opened.cwd,
            worktreePath: opened.worktreePath,
            pid: opened.pid,
            history: "existing history\n",
          },
        },
        { type: "output", data: "live output\n" },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.spawnInputs[0]?.env.OBSERVER_TEST).toBe("original");
      expect(process.resizeCalls).toEqual([]);
      expect(process.writes).toEqual([]);
      expect(process.killSignals).toEqual([]);
    }),
  );
  it.effect("observes exited terminals without restarting and rejects missing sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const missingEvents: TerminalAttachStreamEvent[] = [];
      const missing = yield* manager
        .observeStream({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }, (event) =>
          Effect.sync(() => {
            missingEvents.push(event);
          }),
        )
        .pipe(Effect.flip);
      expect(missing._tag).toBe("TerminalSessionLookupError");
      expect(ptyAdapter.spawnInputs).toEqual([]);

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const exited = yield* Deferred.make<void>();
      const unsubscribeExit = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitExit({ exitCode: 7, signal: 0 });
      yield* Deferred.await(exited);
      unsubscribeExit();

      const events: TerminalAttachStreamEvent[] = [];
      const unsubscribe = yield* manager.observeStream(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      );
      unsubscribe();
      expect(events).toMatchObject([
        { type: "snapshot", snapshot: { status: "exited", exitCode: 7, pid: null } },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(process.resizeCalls).toEqual([]);
      expect(process.writes).toEqual([]);
      expect(process.killSignals).toEqual([]);
      expect(missingEvents).toEqual([]);
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
