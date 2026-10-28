import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalOpenInput,
  ProviderDriverKind,
  ProviderInstanceId,
  TerminalProviderInstanceNotFoundError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { expect, vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "./Manager.ts";
import { terminalOutputStream } from "./OutputProtocol.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

vi.mock("effect/SynchronizedRef", async (importOriginal) => {
  const original = await importOriginal<typeof SynchronizedRef>();
  return { ...original, make: vi.fn(original.make) };
});

// The server omits DOM types, which include TypeScript's WebAssembly declarations.

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  killed = false;
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;
  onKill: ((signal?: string) => void) | undefined;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
    this.onKill?.(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitOnSubscribe) callback(this.exitOnSubscribe);
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    process.exitOnSubscribe = this.exitOnSubscribe;
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

// Publishes 9 MiB of output, past a stream's 8 MiB budget, while nothing pulls.
const publishPastOutputBudget = (
  manager: TerminalManager.TerminalManager["Service"],
  process: FakePtyProcess,
) =>
  Effect.gen(function* () {
    const published = yield* Deferred.make<void>();
    const unsubscribe = yield* manager.subscribe((event) =>
      event.type === "output" && event.data === "last\n"
        ? Deferred.succeed(published, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    for (let index = 0; index < 9; index++) process.emitData("x".repeat(1024 * 1024));
    process.emitData("last\n");
    yield* Deferred.await(published);
    unsubscribe();
  });

// Holds the next spawn, and with it the thread lock, until `release` succeeds.
class GatedPtyAdapter extends FakePtyAdapter {
  gate: {
    readonly spawning: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null = null;

  override spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const gate = this.gate;
    this.gate = null;
    if (!gate) return super.spawn(input);
    return Deferred.succeed(gate.spawning, undefined).pipe(
      Effect.andThen(Deferred.await(gate.release)),
      Effect.andThen(super.spawn(input)),
    );
  }
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

const historyLogPath = (logsDir: string, threadId = "thread-1") =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => join(logsDir, `terminal_${Base64Url.encode(threadId)}.log`)),
  );

interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  processTable?: Effect.Effect<
    ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly name: string }>,
    never
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  registerTerminalProcesses?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["registerTerminalProcesses"];
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
  resolveProviderInstanceEnvironment?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveProviderInstanceEnvironment"];
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
      const logsDir = join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.processTable !== undefined ? { processTable: options.processTable } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.registerTerminalProcesses !== undefined
          ? { registerTerminalProcesses: options.registerTerminalProcesses }
          : {}),
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.resolveProviderInstanceEnvironment !== undefined
          ? { resolveProviderInstanceEnvironment: options.resolveProviderInstanceEnvironment }
          : {}),
        ...(options.managedBinaryCacheDir === undefined
          ? {}
          : {
              managedBinaryCacheDir: options.managedBinaryCacheDir,
              managedBinaryToolsDir: options.managedBinaryToolsDir,
            }),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

const layerWithHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcess.Platform, platform);

function retainedHistory(text: string, maxLines: number, maxBytes = Infinity): string {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const retained = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  const capped = terminated ? `${retained}\n` : retained;
  if (Buffer.byteLength(capped) <= maxBytes) return capped;
  const points = Array.from(capped);
  let start = points.length;
  let bytes = 0;
  while (start > 0) {
    const next = Buffer.byteLength(points[start - 1]!);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return points.slice(start).join("");
}

it("preserves line and byte limits across arbitrary chunks, Unicode, ANSI sequences, and clear", () => {
  let randomSeed = 0x20260904;
  const fragments = [
    "",
    "a",
    "\n",
    "\n\n",
    "\r",
    "\r\n",
    "café",
    "名",
    "🚀",
    "\u001b[31m",
    "\u001b[0m",
    "\u001b]8;;url\u0007",
    "\ud83d",
    "\ude80",
  ];
  const nextFragment = () => {
    randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
    return fragments[randomSeed % fragments.length]!;
  };

  for (const maxBytes of [0, 3, 8, 64, Infinity]) {
    for (const maxLines of [0, 1, 3, 5, 5_000]) {
      let expected = retainedHistory("before\ninitial\n", maxLines, maxBytes);
      const history = new TerminalManager.BoundedTerminalHistory(
        maxLines,
        "before\ninitial\n",
        maxBytes,
      );
      expect(history.value()).toBe(expected);

      for (let step = 0; step < 300; step += 1) {
        if (step % 73 === 0) {
          history.clear();
          expected = "";
          expect(history.value()).toBe(expected);
        }
        const chunk = nextFragment() + nextFragment();
        history.append(chunk);
        expected = retainedHistory(expected + chunk, maxLines, maxBytes);
        expect(history.value()).toBe(expected);
      }
    }
  }
});

it("bounds long partial lines and joins surrogate pairs across chunk boundaries", () => {
  const maxBytes = 65_539;
  let expected = "";
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", maxBytes);
  const writes = [
    "a".repeat(16_383) + "😀" + "b".repeat(70_000),
    "\r" + "c".repeat(70_000) + "\ud83d",
    "\ude80" + "d".repeat(100),
    "\uFEFF" + "名".repeat(30_000),
  ];
  for (const text of writes) {
    history.append(text);
    expected = retainedHistory(expected + text, 5_000, maxBytes);
    expect(history.value()).toBe(expected);
    expect(Buffer.byteLength(history.value())).toBeLessThanOrEqual(maxBytes);
  }
});

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
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

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
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

  it.effect("bounds persisted and attached history without truncating live output", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, { historyByteLimit: 10 });
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const writes = ["a".repeat(32), "😀\rEND"];
      const process = ptyAdapter.processes[0]!;
      for (const text of writes) process.emitData(text);
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe("aa😀\rEND");

      const reopened = yield* manager.open(openInput());
      const events = yield* Ref.get(attachEvents);
      expect(events.filter((event) => event.type === "output").map((event) => event.data)).toEqual(
        writes,
      );
      const snapshot = events.filter((event) => event.type === "snapshot").at(-1)?.snapshot;
      expect(snapshot?.history).toBe("aa😀\rEND");
      expect(snapshot?.sequence).toBe(reopened.sequence);
    }),
  );

  it.effect("retains plain Unicode and control characters around a split query", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const before = "café\t界🙂\u0007\u009c\u0085";
      const after = "e\u0301\r\n";

      process.emitData(before);
      process.emitData("\u001b[5");
      process.emitData(`n${after}`);
      yield* manager.close({ threadId: "thread-1" });

      expect((yield* manager.open(openInput())).history).toBe(before + after);
    }),
  );

  it.effect("strips replayable CSI and DCS traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history.startsWith('prompt \u001b[!p\u001b["p\u001b[4 q\u001b[udone\n')).toBe(
        true,
      );
    }),
  );

  it.effect("handles CSI and DCS query sequences split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      process.emitData("\u001bP$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u009b?3");
      process.emitData("1uafter ");
      process.emitData("\u0090+q544e");
      process.emitData("\u009cafter\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );

  it.effect("preserves large chunked OSC 52 and DCS strings across reopen", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const outputSeen = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" && event.data === "done\n"
          ? Deferred.succeed(outputSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const sequences = [
        { prefix: `\u001b]52;c;${"YWJj".repeat(16_384)}\u001b`, terminator: "\\" },
        { prefix: `\u0090q${"?".repeat(65_536)}`, terminator: "\u009c" },
      ];
      const stripped = "\u001b]11;?\u0007\u0090$q m\u009c";
      const preserved = "\u001b[31m\u009d52;c;YWJj\u009c";
      const expected =
        sequences.map(({ prefix, terminator }) => prefix + terminator + preserved).join("") +
        "done\n";

      // Counts reads of strings larger than one emitted chunk, so rescanning the
      // pending prefix on every chunk shows up as quadratic work.
      const charCodeAt = String.prototype.charCodeAt;
      let largeStringReads = 0;
      yield* Effect.gen(function* () {
        // eslint-disable-next-line no-extend-native -- Count reads without retaining millions of spy call records.
        String.prototype.charCodeAt = function (this: string, index: number) {
          if (this.length > 4_096) largeStringReads += 1;
          return charCodeAt.call(this, index);
        };
        for (const { prefix, terminator } of sequences) {
          for (let offset = 0; offset < prefix.length; offset += 4_096) {
            process.emitData(prefix.slice(offset, offset + 4_096));
          }
          process.emitData(terminator + stripped + preserved);
        }
        process.emitData("done\n");
        yield* Deferred.await(outputSeen);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // eslint-disable-next-line no-extend-native -- Restore the counting hook even when the test fails.
            String.prototype.charCodeAt = charCodeAt;
          }),
        ),
      );
      yield* manager.close({ threadId: "thread-1" });

      expect(largeStringReads).toBeLessThan(2 * expected.length);
      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe(expected);
      expect((yield* manager.open(openInput())).history.startsWith(expected)).toBe(true);
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        expect(reopened.history.startsWith("before \u001b(Bafter\n")).toBe(true);
      }),
  );

  it.effect.each([
    {
      label: "subagent",
      threadId:
        "thread:provider:claudeAgent:native-thread:provider-thread%3Aprovider%3AclaudeAgent%3Anative-thread%3Apending%253Arun%253Athread%253A9175fb53-52d7-4d4d-9be7-25a76cf84b91%253Aordinal%253A7%3Aad899ae84c7a131b0",
    },
    // Also too long for the legacy `<sanitized id>.log` lookup.
    { label: "300-character", threadId: "x".repeat(300) },
  ])("persists history for a $label thread id too long to encode into a filename", ({ threadId }) =>
    Effect.gen(function* () {
      const terminalId = "t".repeat(128);
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      const fs = yield* FileSystem.FileSystem;
      yield* manager.open(openInput({ threadId }));
      yield* manager.open(openInput({ threadId, terminalId }));
      ptyAdapter.processes[0]!.emitData("default\n");
      ptyAdapter.processes[1]!.emitData("long\n");
      yield* manager.close({ threadId });

      expect((yield* manager.open(openInput({ threadId }))).history).toBe("default\n");
      expect((yield* manager.open(openInput({ threadId, terminalId }))).history).toBe("long\n");

      yield* manager.close({ threadId, deleteHistory: true });
      expect(yield* fs.readDirectory(logsDir)).toEqual([]);
    }),
  );

  it.effect("keeps reading and deleting history at an encoded path that already fit", () =>
    Effect.gen(function* () {
      const threadId = "x".repeat(120);
      const { manager, logsDir } = yield* createManager();
      const fs = yield* FileSystem.FileSystem;
      const logPath = yield* historyLogPath(logsDir, threadId);
      yield* fs.makeDirectory(logsDir, { recursive: true });
      yield* fs.writeFileString(logPath, "before upgrade\n");

      expect((yield* manager.open(openInput({ threadId }))).history).toBe("before upgrade\n");
      // A long terminal id pushes only this terminal's name past the limit, so the thread's
      // history is split across both forms and deleting the thread must remove both.
      yield* manager.open(openInput({ threadId, terminalId: "t".repeat(128) }));

      yield* manager.close({ threadId, deleteHistory: true });
      expect(yield* fs.exists(logPath)).toBe(false);
      expect(yield* fs.readDirectory(logsDir)).toEqual([]);
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("preserves Windows Path casing when appending managed ACP binaries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-terminal-acp-path-",
      });
      const installBin = path.join(
        cacheDir,
        "tools",
        "example-agent",
        "1.2.3",
        "windows-x86_64",
        "bin",
      );
      yield* fileSystem.makeDirectory(installBin, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(cacheDir, "acp-registry"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cacheDir, "acp-registry", "registry.json"),
        encodeUnknownJson({
          version: "1.0.0",
          agents: [
            {
              id: "example-agent",
              name: "Example Agent",
              version: "1.2.3",
              description: "ACP Registry test agent",
              distribution: {
                binary: {
                  "windows-x86_64": {
                    archive: "https://registry.test/example-agent.zip",
                    cmd: "bin/example-agent.exe",
                  },
                },
              },
            },
          ],
        }),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        managedBinaryCacheDir: cacheDir,
        managedBinaryToolsDir: path.join(cacheDir, "tools"),
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          Path: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerWithHostPlatform("win32"),
            Layer.succeed(HostProcess.Architecture, "x64"),
          ),
        ),
      );

      yield* manager.open(openInput());

      const spawnEnv = ptyAdapter.spawnInputs[0]?.env;
      expect(spawnEnv?.PATH).toBeUndefined();
      expect(spawnEnv?.Path).toBe(`C:\\Windows\\System32;${installBin}`);
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );

  it.effect("turns off fish terminal queries unless the user chose query-term", () =>
    Effect.gen(function* () {
      for (const [platform, env, runtimeEnv, expected] of [
        ["linux", {}, {}, { fish_features: "no-query-term" }],
        [
          "linux",
          { fish_features: "qmark-noglob" },
          {},
          { fish_features: "qmark-noglob,no-query-term" },
        ],
        [
          "linux",
          { fish_features: "qmark-noglob,query-term" },
          {},
          { fish_features: "qmark-noglob,query-term" },
        ],
        [
          "linux",
          { fish_features: "qmark-noglob,no-query-term" },
          {},
          { fish_features: "qmark-noglob,no-query-term" },
        ],
        [
          "linux",
          { fish_features: "query-term" },
          { fish_features: "qmark-noglob" },
          { fish_features: "qmark-noglob,no-query-term" },
        ],
        [
          "win32",
          { FISH_FEATURES: "qmark-noglob" },
          {},
          { FISH_FEATURES: "qmark-noglob,no-query-term" },
        ],
        [
          "win32",
          { Fish_Features: "qmark-noglob,query-term" },
          {},
          { Fish_Features: "qmark-noglob,query-term" },
        ],
        [
          "win32",
          { FISH_FEATURES: "qmark-noglob,no-query-term" },
          {},
          { FISH_FEATURES: "qmark-noglob,no-query-term" },
        ],
        [
          "win32",
          { Fish_Features: "query-term" },
          { fish_features: "qmark-noglob" },
          { Fish_Features: "qmark-noglob,no-query-term" },
        ],
        [
          "win32",
          { FISH_FEATURES: "no-query-term" },
          { fish_features: "qmark-noglob,query-term" },
          { FISH_FEATURES: "qmark-noglob,query-term" },
        ],
      ] as const) {
        const { manager, ptyAdapter } = yield* createManager(5, {
          env,
        }).pipe(Effect.provide(layerWithHostPlatform(platform)));
        yield* manager.open(openInput({ env: runtimeEnv }));
        const fishFeatures = Object.fromEntries(
          Object.entries(ptyAdapter.spawnInputs[0]!.env).filter(
            ([key]) => key.toLowerCase() === "fish_features",
          ),
        );
        expect.soft(fishFeatures, JSON.stringify({ platform, env, runtimeEnv })).toEqual(expected);
      }
    }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
          TMUX: "/tmp/tmux-1000/default,1234,0",
          TMUX_PANE: "%3",
          ZELLIJ_SESSION_NAME: "work",
          ZELLIJ_CONFIG_DIR: "/home/user/.config/zellij",
        },
      });
      yield* manager.open(openInput());
      yield* manager.open(openInput({ terminalId: "explicit", env: { TMUX_PANE: "%9" } }));
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
      expect(spawnInput.env.TMUX).toBeUndefined();
      expect(spawnInput.env.TMUX_PANE).toBeUndefined();
      expect(spawnInput.env.ZELLIJ_SESSION_NAME).toBeUndefined();
      expect(spawnInput.env.ZELLIJ_CONFIG_DIR).toBe("/home/user/.config/zellij");
      expect(ptyAdapter.spawnInputs[1]?.env.TMUX_PANE).toBe("%9");
    }),
  );

  it.effect("strips AppImage runtime env from terminal sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_T3Codeabc123";
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          APPIMAGE: "/home/user/T3-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/T3-Code.AppImage",
          OWD: "/home/user/project",
          PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
          XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
      expect(spawnInput.env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("resolves a provider instance environment before spawning", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { T3CODE_SECRET: "server-only" },
        resolveProviderInstanceEnvironment: (requestedId, env) =>
          Effect.succeed({
            ...env,
            PROVIDER_SECRET: requestedId === providerInstanceId ? "secret-value" : "wrong",
            CODEX_HOME: "/accounts/codex-work",
          }),
      });

      const snapshot = yield* manager.open(
        openInput({ providerInstanceId, env: { CLIENT_FLAG: "1" } }),
      );

      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("secret-value");
      expect(ptyAdapter.spawnInputs[0]?.env.CODEX_HOME).toBe("/accounts/codex-work");
      expect(ptyAdapter.spawnInputs[0]?.env.CLIENT_FLAG).toBe("1");
      expect(ptyAdapter.spawnInputs[0]?.env.T3CODE_SECRET).toBeUndefined();
      expect(snapshot).not.toHaveProperty("env");
      expect(snapshot).not.toHaveProperty("providerInstanceId");
    }),
  );

  it.effect("fails closed when a provider instance is missing", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager.open(openInput({ providerInstanceId })).pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect.each([
    {
      name: "Codex home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex" },
      expectedHome: "/configured/codex",
    },
    {
      name: "Codex shadow home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex", shadowHomePath: "/configured/codex-shadow" },
      expectedHome: "/configured/codex-shadow",
    },
    {
      name: "Claude home",
      driver: "claudeAgent",
      variable: "CLAUDE_CONFIG_DIR",
      config: { homePath: "/configured/claude" },
      expectedHome: "/configured/claude",
    },
  ])("prefers $name over the instance environment", ({ driver, variable, config, expectedHome }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "configured_home",
        env: undefined,
      });

      expect(environment[variable]).toBe(path.resolve(expectedHome));
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("configured_home")]: {
              driver: ProviderDriverKind.make(driver),
              environment: [{ name: variable, value: "~/.environment-account", sensitive: false }],
              config,
            },
          },
        }),
      ),
    ),
  );

  it.effect("restarts a running terminal when the resolved provider environment changes", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerSecret = "first-secret";
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: () =>
          Effect.succeed({ PROVIDER_SECRET: providerSecret }),
      });

      yield* manager.open(openInput({ providerInstanceId }));
      providerSecret = "second-secret";
      yield* manager.open(openInput({ providerInstanceId }));

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env.PROVIDER_SECRET).toBe("second-secret");
    }),
  );

  it.effect("attaches to a running provider terminal without resolving the provider again", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerAvailable = true;
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          providerAvailable
            ? Effect.succeed({ PROVIDER_SECRET: "secret-value" })
            : Effect.fail(
                new TerminalProviderInstanceNotFoundError({
                  providerInstanceId: ProviderInstanceId.make(requestedId),
                }),
              ),
      });
      yield* manager.open(openInput({ providerInstanceId }));
      providerAvailable = false;
      const events: TerminalAttachStreamEvent[] = [];

      const unsubscribe = yield* manager.attachStream(
        { ...openInput({ providerInstanceId }), restartIfNotRunning: true },
        (event) => Effect.sync(() => events.push(event)),
      );
      unsubscribe();

      expect(events[0]?.type).toBe("snapshot");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes[0]?.killed).toBe(false);
    }),
  );

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
});
