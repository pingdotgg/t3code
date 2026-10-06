import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scheduler from "effect/Scheduler";
import { expect, vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

function makeNativeProcess(pid = 42) {
  const events = new NodeEvents.EventEmitter();
  return {
    pid,
    _socket: new NodeNet.Socket(),
    _agent: { kill: vi.fn() },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((callback: (data: string) => void) => {
      events.on("data", callback);
      return {
        dispose: () => {
          events.off("data", callback);
        },
      };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => {
      events.on("exit", callback);
      return {
        dispose: () => {
          events.off("exit", callback);
        },
      };
    }),
    events,
  };
}

const spawn = vi.fn(() => makeNativeProcess());

function preparePendingProcess() {
  const nativeProcess = makeNativeProcess(0);
  const subscribed = Promise.withResolvers<void>();
  nativeProcess._socket.on("newListener", (event) => {
    if (event === "ready_datapipe") queueMicrotask(() => subscribed.resolve());
  });
  spawn.mockReturnValueOnce(nativeProcess);
  return { nativeProcess, subscribed: Effect.promise(() => subscribed.promise) };
}

const spawnInput = { shell: "powershell.exe", cwd: ".", cols: 80, rows: 24, env: {} };

const fakeNodePty = { spawn } as unknown as typeof import("node-pty");

const makeTestLayer = (platform: NodeJS.Platform = "win32") =>
  NodePtyAdapter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, platform),
        Layer.succeed(HostProcessArchitecture, "x64"),
        Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.resolve(fakeNodePty)),
      ),
    ),
  );

const layerTest = makeTestLayer();

it.effect("waits for the Windows PID without requiring output", () =>
  Effect.gen(function* () {
    const { nativeProcess, subscribed } = preparePendingProcess();
    const adapter = yield* PtyAdapter.PtyAdapter;
    let completed = false;
    const fiber = yield* adapter.spawn(spawnInput).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          completed = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* subscribed;
    assert.isFalse(completed);
    nativeProcess.pid = 12345;
    nativeProcess._socket.emit("ready_datapipe");
    const process = yield* Fiber.join(fiber);
    assert.equal(process.pid, 12345);
    assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 1);

    const output: string[] = [];
    const exits: PtyAdapter.PtyExitEvent[] = [];
    const stopData = process.onData((data) => output.push(data));
    const stopExit = process.onExit((event) => exits.push(event));
    nativeProcess.events.emit("data", "first output");
    nativeProcess.events.emit("exit", { exitCode: 0 });
    assert.deepEqual(output, ["first output"]);
    assert.deepEqual(exits, [{ exitCode: 0, signal: null }]);
    stopData();
    stopExit();
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["exit", "close", "error", "invalid-pid"] as const)(
  "fails Windows startup on %s and cleans up",
  (failure) =>
    Effect.gen(function* () {
      const { nativeProcess, subscribed } = preparePendingProcess();
      const adapter = yield* PtyAdapter.PtyAdapter;
      const fiber = yield* adapter.spawn(spawnInput).pipe(Effect.result, Effect.forkChild);
      yield* subscribed;
      if (failure === "exit") nativeProcess.events.emit("exit", { exitCode: 1 });
      else if (failure === "error") nativeProcess._socket.emit("error", new Error("pipe failed"));
      else nativeProcess._socket.emit(failure === "close" ? "close" : "ready_datapipe");
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, PtyAdapter.PtySpawnError);
      assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
      assert.equal(nativeProcess._socket.listenerCount("error"), 0);
      assert.equal(nativeProcess._socket.listenerCount("close"), 0);
      assert.equal(nativeProcess.events.listenerCount("exit"), 0);
      assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("cancels the Windows connection without waiting for output", () =>
  Effect.gen(function* () {
    const { nativeProcess, subscribed } = preparePendingProcess();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const fiber = yield* adapter.spawn(spawnInput).pipe(Effect.forkChild);
    yield* subscribed;
    yield* Fiber.interrupt(fiber);
    assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
    assert.equal(nativeProcess.kill.mock.calls.length, 0);
    assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports an incompatible Windows readiness API instead of hanging", () =>
  Effect.gen(function* () {
    const nativeProcess = makeNativeProcess(0);
    Reflect.deleteProperty(nativeProcess, "_socket");
    spawn.mockReturnValueOnce(nativeProcess);
    const adapter = yield* PtyAdapter.PtyAdapter;
    const error = yield* adapter.spawn(spawnInput).pipe(Effect.flip);
    assert.instanceOf(error, PtyAdapter.PtySpawnError);
    assert.instanceOf(error.cause, Error);
    assert.equal(error.cause.message, "Windows PTY readiness socket is unavailable.");
    assert.equal(nativeProcess._agent.kill.mock.calls.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["win32", "linux", "darwin"] as const)(
  "terminates through node-pty using %s semantics",
  (platform) =>
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      const process = yield* adapter.spawn({
        shell: "test-shell",
        cwd: ".",
        cols: 80,
        rows: 24,
        env: {},
      });
      const nativeProcess = spawn.mock.results.at(-1)!.value;
      nativeProcess.kill.mockImplementation((signal?: string) => {
        if (platform === "win32" && signal) {
          throw new Error("Signals not supported on windows.");
        }
      });

      process.kill("SIGTERM");
      process.kill("SIGKILL");
      process.kill();

      assert.deepEqual(
        nativeProcess.kill.mock.calls,
        platform === "win32"
          ? [[undefined], [undefined], [undefined]]
          : [["SIGTERM"], ["SIGKILL"], [undefined]],
      );
    }).pipe(Effect.provide(makeTestLayer(platform))),
);

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make().pipe(
      Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.reject(cause)),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);

it.effect.each([2048, 8])(
  "preserves an exit during readiness handoff with scheduler budget %s",
  (budget) =>
    Effect.gen(function* () {
      const { nativeProcess, subscribed } = preparePendingProcess();
      const adapter = yield* PtyAdapter.PtyAdapter;
      const exits: PtyAdapter.PtyExitEvent[] = [];
      const fiber = yield* Effect.gen(function* () {
        const process = yield* adapter.spawn(spawnInput);
        process.onExit((event) => exits.push(event));
      }).pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
        Effect.provideService(Scheduler.PreventSchedulerYield, false),
        Effect.forkChild,
      );
      yield* subscribed;
      nativeProcess.pid = 12345;
      nativeProcess._socket.emit("ready_datapipe");
      nativeProcess.events.emit("exit", { exitCode: 0 });
      yield* Fiber.join(fiber);
      assert.equal(exits.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("replays an exit to late subscribers and respects unsubscription", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn(spawnInput);
    const nativeProcess = spawn.mock.results.at(-1)!.value;
    const removed = vi.fn();
    process.onExit(removed)();
    nativeProcess.events.emit("exit", { exitCode: 7, signal: 2 });
    const late = vi.fn();
    process.onExit(late);
    nativeProcess.events.emit("exit", { exitCode: 9 });
    assert.equal(removed.mock.calls.length, 0);
    assert.deepEqual(late.mock.calls, [[{ exitCode: 7, signal: 2 }]]);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["spawn", "interrupt"] as const)(
  "logs cleanup failures without replacing %s",
  (failure) =>
    Effect.gen(function* () {
      const { nativeProcess, subscribed } = preparePendingProcess();
      const killError = new Error("native kill failed");
      nativeProcess._agent.kill.mockImplementation(() => {
        throw killError;
      });
      const messages: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      const adapter = yield* PtyAdapter.PtyAdapter;
      const fiber = yield* adapter
        .spawn(spawnInput)
        .pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.forkChild,
        );
      yield* subscribed;
      const spawnError = new Error("pipe failed");
      if (failure === "interrupt") yield* Fiber.interrupt(fiber);
      else nativeProcess._socket.emit("error", spawnError);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        if (failure === "interrupt") assert.isTrue(Cause.hasInterrupts(exit.cause));
        else {
          const error = Cause.squash(exit.cause);
          assert.instanceOf(error, PtyAdapter.PtySpawnError);
          assert.equal(error.cause, spawnError);
        }
      }
      assert.equal(messages.length, 1);
      expect(messages[0]).toMatchObject([
        "failed to cancel Windows terminal startup",
        { terminalPid: 0, cause: { cause: killError } },
      ]);
      assert.equal(nativeProcess.events.listenerCount("exit"), 0);
      assert.equal(nativeProcess._socket.listenerCount("ready_datapipe"), 0);
    }).pipe(Effect.provide(layerTest)),
);
