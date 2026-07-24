import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import {
  hasReplyUnawareForegroundProcess,
  sanitizePersistedTerminalHistory,
  sanitizeTerminalHistoryChunk,
  sanitizeTerminalInputChunk,
  stripTerminalResponsesFromInput,
  TERMINAL_SEQUENCE_GRAMMAR,
} from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

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
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
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

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

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

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
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
    Effect.map(({ join }) => join(logsDir, `terminal_${Encoding.encodeBase64Url(threadId)}.log`)),
  );

const multiTerminalHistoryLogPath = (
  logsDir: string,
  threadId = "thread-1",
  terminalId = DEFAULT_TERMINAL_ID,
) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => {
      const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
      return join(
        logsDir,
        terminalId === DEFAULT_TERMINAL_ID
          ? `${threadPart}.log`
          : `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`,
      );
    }),
  );

interface CreateManagerOptions {
  shellResolver?: () => string;
  historyCharLimit?: number;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
    readonly shellForeground?: boolean;
  }>;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  ptyAdapter?: FakePtyAdapter;
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
        ...(options.historyCharLimit !== undefined
          ? { historyCharLimit: options.historyCharLimit }
          : {}),
        ptyAdapter,
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
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

const withHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

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

  it.effect("attaches to running sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      yield* manager.open(openInput());
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 100,
          rows: 40,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.threadId, "thread-1");
      assert.equal(snapshot.snapshot.terminalId, DEFAULT_TERMINAL_ID);
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

  it.effect("attaches to exited sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        openInput({
          env: {
            T3CODE_WORKTREE_PATH: "/tmp/should-not-restart",
          },
          worktreePath: "/tmp/should-not-restart",
        }),
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "exited");
      assert.equal(snapshot.snapshot.worktreePath, null);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("restarts inactive sessions from attach only when requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          ...openInput({
            env: {
              T3CODE_WORKTREE_PATH: "/tmp/restart-requested",
            },
            worktreePath: "/tmp/restart-requested",
          }),
          restartIfNotRunning: true,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "running");
      assert.equal(snapshot.snapshot.worktreePath, "/tmp/restart-requested");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("reports a missing cwd without an artificial cause", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "missing-cwd");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotFoundError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("reports a cwd that is not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "cwd-file");
      yield* writeFileString(cwd, "not a directory");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotDirectoryError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdStatError",
        cwd: blockedCwd,
        cause: {
          _tag: "PlatformError",
        },
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("preserves structured context and causes for PTY I/O failures", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const writeCause = new Error("PTY input handle is unavailable");
      process.writeFailure = writeCause;
      const writeError = yield* Effect.flip(
        manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "secret input that must not be attached to the error",
        }),
      );

      expect(writeError).toMatchObject({
        _tag: "TerminalWriteError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
      });
      expect(writeError.cause).toBe(writeCause);
      expect(writeError).not.toHaveProperty("data");

      const resizeCause = new Error("PTY resize handle is unavailable");
      process.resizeFailure = resizeCause;
      const resizeError = yield* Effect.flip(
        manager.resize({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 132,
          rows: 40,
        }),
      );

      expect(resizeError).toMatchObject({
        _tag: "TerminalResizeError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
        cols: 132,
        rows: 40,
      });
      expect(resizeError.cause).toBe(resizeCause);

      process.resizeFailure = undefined;
      yield* manager.open(openInput({ cols: 132, rows: 40 }));
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);
    }),
  );

  it.effect("ignores delayed resize requests after a terminal closes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
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

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === DEFAULT_TERMINAL_ID,
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal with empty transcript and respawns pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );
    }),
  );

  it.effect("restarts a running session when open is called with a different cwd", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const originalCwd = path.join(baseDir, "original");
      const differentCwd = path.join(baseDir, "different");
      yield* makeDirectory(originalCwd);
      yield* makeDirectory(differentCwd);

      yield* manager.open(openInput({ cwd: originalCwd }));
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;

      firstProcess.emitData("before reopen\n");
      const logPath = yield* historyLogPath(logsDir);
      yield* waitFor(pathExists(logPath));

      const reopened = yield* manager.open(openInput({ cwd: differentCwd }));

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      assert.equal(firstProcess.killed, true);
      assert.equal(reopened.cwd, differentCwd);
      assert.equal(reopened.history, "");
      yield* waitFor(Effect.map(readFileString(logPath), (text) => text === ""));
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("emits exited event and reopens with clean transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
        ),
      ).toBe("");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      const { manager, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      inspect = { hasRunningSubprocess: true, childCommand: "vim", processIds: [100, 101] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      inspect = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === false &&
              event.label === "Terminal 1",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not hold the terminal lock while inspecting subprocesses", () =>
    Effect.gen(function* () {
      const inspectionStarted = yield* Deferred.make<void>();
      const releaseInspection = yield* Deferred.make<void>();
      let blockInspection = false;
      const idleShell = {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [] as ReadonlyArray<number>,
        shellForeground: true,
      };
      const { manager, ptyAdapter } = yield* createManager(5, {
        subprocessInspector: () =>
          blockInspection
            ? Effect.gen(function* () {
                yield* Deferred.succeed(inspectionStarted, undefined);
                yield* Deferred.await(releaseInspection);
                return idleShell;
              })
            : Effect.succeed(idleShell),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      blockInspection = true;
      yield* Deferred.await(inspectionStarted).pipe(Effect.timeout("1200 millis"));

      const writeExit = yield* manager
        .write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "x",
        })
        .pipe(Effect.timeout("100 millis"), Effect.exit);
      yield* Deferred.succeed(releaseInspection, undefined);

      expect(Exit.isSuccess(writeExit)).toBe(true);
      expect(process.writes).toEqual(["x"]);
    }),
  );

  it.effect("discards a periodic inspection superseded by a write refresh", () =>
    Effect.gen(function* () {
      const initialInspectionCompleted = yield* Deferred.make<void>();
      const staleInspectionStarted = yield* Deferred.make<void>();
      const releaseStaleInspection = yield* Deferred.make<void>();
      let initialInspection = true;
      let blockNextInspection = false;
      let freshWriteInspection = true;
      let inspections = 0;
      const foregroundProgram = {
        hasRunningSubprocess: true,
        childCommand: "vim",
        processIds: [100] as ReadonlyArray<number>,
        shellForeground: false,
      };
      const staleActivity = {
        hasRunningSubprocess: true,
        childCommand: "less",
        processIds: [100, 101] as ReadonlyArray<number>,
        shellForeground: false,
      };
      const idleShell = {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [] as ReadonlyArray<number>,
        shellForeground: true,
      };
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () => {
          inspections += 1;
          if (initialInspection) {
            initialInspection = false;
            return Deferred.succeed(initialInspectionCompleted, undefined).pipe(
              Effect.as(foregroundProgram),
            );
          }
          if (blockNextInspection) {
            blockNextInspection = false;
            return Deferred.succeed(staleInspectionStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStaleInspection)),
              Effect.as(staleActivity),
            );
          }
          if (freshWriteInspection) {
            freshWriteInspection = false;
            return Effect.succeed(idleShell);
          }
          return Effect.succeed(foregroundProgram);
        },
        subprocessPollIntervalMs: 100,
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* Deferred.await(initialInspectionCompleted).pipe(Effect.timeout("1200 millis"));
      blockNextInspection = true;
      yield* Deferred.await(staleInspectionStarted).pipe(Effect.timeout("1200 millis"));

      // This on-demand inspection is newer than the blocked periodic poll and
      // observes that the shell owns the PTY again.
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[1;1R",
      });
      yield* Deferred.succeed(releaseStaleInspection, undefined);
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" && event.hasRunningSubprocess && event.label === "less",
          ),
        ),
        "1200 millis",
      );

      // If the stale poll clobbered the refreshed foreground state, this write
      // performs another inspection and relays the reply to the foreground
      // program. Keeping the fresh state strips it at the idle prompt.
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[2;1R",
      });

      expect(inspections).toBe(3);
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect(
    "strips capability replies at an idle prompt but relays them to a foreground program",
    () =>
      Effect.gen(function* () {
        let inspect: {
          readonly hasRunningSubprocess: boolean;
          readonly childCommand: string | null;
          readonly processIds: ReadonlyArray<number>;
          readonly shellForeground?: boolean;
        } = {
          hasRunningSubprocess: false,
          childCommand: null,
          processIds: [],
          shellForeground: true,
        };
        const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
          subprocessInspector: () => Effect.succeed(inspect),
          subprocessPollIntervalMs: 20,
        });
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        // Nested renderers issue cursor queries outside this PTY stream, so an
        // idle shell must drop a CPR-shaped sequence even when the server did
        // not observe the matching query. Otherwise it becomes the `;1RR` loop.
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "\x1b[1;2R",
        });
        expect(process.writes).toEqual([]);

        // Idle prompt (no subprocess): the emulator's CPR auto-reply is dropped
        // because the shell would only echo it back.
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "\x1b[1;1R",
        });
        expect(process.writes).toEqual([]);

        // Transport chunking must not bypass the same filter. Previously the
        // first half reached the shell before the stateless matcher could see
        // the final `R`, leaving `;1R`/`R` residue in the persisted log.
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "\x1b[16",
        });
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: ";1R",
        });
        expect(process.writes).toEqual([]);

        // xterm's default onData path also carries physical keys. A standalone
        // Escape callback is a complete key event, not the first chunk of a
        // capability reply, so it must reach the shell before the next key.
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "\x1b",
        });
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "q",
        });
        expect(process.writes).toEqual(["\x1b", "q"]);

        // Foreground program running (vim): it issued the query and is blocked
        // reading the answer — input must pass through verbatim.
        inspect = {
          hasRunningSubprocess: true,
          childCommand: "vim",
          processIds: [100],
          shellForeground: false,
        };
        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
          ),
          "1200 millis",
        );
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "\x1b[1;1R",
        });
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "\x1b[I",
        });
        expect(process.writes).toEqual(["\x1b", "q", "\x1b[1;1R", "\x1b[I"]);
      }),
  );

  it.effect("strips terminal replies while a nested git diff pager owns the PTY", () =>
    Effect.gen(function* () {
      const inspect = {
        hasRunningSubprocess: true,
        childCommand: "git",
        processIds: [100, 101],
        hasTerminalReplyUnawareSubprocess: true,
        shellForeground: false,
      };
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );

      // Reproduced by feeding the queries emitted around `git diff`/less
      // through xterm and by inspecting the persisted failing PTY log. These
      // These reply-shaped bytes do not belong to the nested less process.
      // Relaying them makes less display `ESC...` and starts the feedback
      // flood. This policy is enforced here in the backend regardless of which
      // terminal client supplied the bytes.
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[?",
      });
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "q",
      });
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[1;2",
      });
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "R",
      });

      for (const data of [
        "\x1b[?",
        "\x1b[?1;2c",
        "\x1b[?69;0$y",
        "\x1b[?2026;2$y",
        "\x1b[?2027;0$y",
        "\x1b[?2031;0$y",
        "\x1b[?2048;0$y",
        "\x1b[?1;2c",
        "\x1b]11;rgb:1616/1616/1616\x1b\\",
        "\x1b[0n",
        "\x1b[I",
      ]) {
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data,
        });
      }

      // Ordinary pager input still passes through xterm's physical-key path.
      // In particular, a bare Escape must not be held as an incomplete reply
      // prefix: keyboard events are already complete units when they arrive
      // in one terminal.write RPC.
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b",
        inputSource: "terminal",
      });
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "q",
        inputSource: "terminal",
      });

      expect(process.writes).toEqual(["q", "\x1b", "q"]);
    }),
  );

  it.effect("refreshes stale pager ownership before routing a terminal reply", () =>
    Effect.gen(function* () {
      let inspect = {
        hasRunningSubprocess: true,
        childCommand: "git",
        processIds: [100, 101],
        hasTerminalReplyUnawareSubprocess: true,
        shellForeground: false,
      };
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );
      inspect = {
        hasRunningSubprocess: true,
        childCommand: "vim",
        processIds: [100, 102],
        hasTerminalReplyUnawareSubprocess: false,
        shellForeground: false,
      };

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[1;2R",
      });

      expect(process.writes).toEqual(["\x1b[1;2R"]);
    }),
  );

  it.effect("serializes overlapping reply writes through the per-thread lock", () =>
    Effect.gen(function* () {
      const inspect = {
        hasRunningSubprocess: true,
        childCommand: "vim",
        processIds: [100],
        shellForeground: false,
      };
      let delayInspections = false;
      let activeInspections = 0;
      let maxActiveInspections = 0;
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () =>
          delayInspections
            ? Effect.gen(function* () {
                activeInspections += 1;
                maxActiveInspections = Math.max(maxActiveInspections, activeInspections);
                yield* Effect.sleep("25 millis");
                activeInspections -= 1;
                return inspect;
              })
            : Effect.succeed(inspect),
        // Leave enough room after the initial ownership poll for the two
        // overlapping writes to exercise only their on-demand refreshes.
        subprocessPollIntervalMs: 200,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );
      delayInspections = true;

      yield* Effect.all(
        [
          manager.write({
            threadId: "thread-1",
            terminalId: DEFAULT_TERMINAL_ID,
            data: "\x1b[1;1R",
          }),
          manager.write({
            threadId: "thread-1",
            terminalId: DEFAULT_TERMINAL_ID,
            data: "\x1b[2;1R",
          }),
        ],
        { concurrency: "unbounded" },
      );

      expect(maxActiveInspections).toBe(1);
      expect(process.writes).toEqual(["\x1b[1;1R", "\x1b[2;1R"]);
    }),
  );

  it.effect("refreshes foreground ownership when a program exits between subprocess polls", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
        readonly shellForeground?: boolean;
      } = {
        hasRunningSubprocess: true,
        childCommand: "claude",
        processIds: [100],
        shellForeground: false,
      };
      let inspections = 0;
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () => {
          inspections += 1;
          return Effect.succeed(inspect);
        },
        subprocessPollIntervalMs: 200,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );
      const inspectionsBeforeExit = inspections;

      // Claude has exited and the shell owns the PTY again, but the periodic
      // snapshot still says the foreground program is active.
      inspect = {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [],
        shellForeground: true,
      };

      // The captured leak commonly splits DA replies across client writes.
      // Neither half may reach the shell during the stale-cache window.
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[?1",
      });
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: ";2c",
      });
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b]11;rgb:1616/1616/1616\x1b\\",
      });

      expect(inspections).toBeGreaterThan(inspectionsBeforeExit);
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("keeps stripping replies while only a BACKGROUND job runs (shell owns the PTY)", () =>
    Effect.gen(function* () {
      // `sleep 100 &` puts a child under the shell, but the shell still owns
      // the PTY's foreground group (tpgid == shell pgid) and is at the prompt —
      // the echo loop is live, so replies must still be stripped. The inspector
      // reports the foreground signal explicitly.
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
        readonly shellForeground?: boolean;
      } = {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [],
        shellForeground: true,
      };
      let inspections = 0;
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () => {
          inspections += 1;
          return Effect.succeed(inspect);
        },
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      inspect = {
        hasRunningSubprocess: true,
        childCommand: "sleep",
        processIds: [100],
        shellForeground: true, // background job — the shell keeps the prompt
      };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );
      // The prompt's cursor query arms the CPR strip (CPR is query-gated).
      process.emitData("\x1b[6n");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data.includes("\x1b[6n")),
        ),
        "1200 millis",
      );
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[1;1R",
      });
      expect(process.writes).toEqual([]); // still stripped — echo loop stays broken

      // The job moves to the foreground (`fg`): tpgid flips to the job's group
      // even though the wire label doesn't change — replies must now pass.
      inspect = {
        hasRunningSubprocess: true,
        childCommand: "sleep",
        processIds: [100],
        shellForeground: false,
      };
      // No activity event fires for a pure fg/bg flip; wait until the poller has
      // demonstrably run with the flipped fixture instead of sleeping blind.
      const inspectionsAtFlip = inspections;
      yield* waitFor(
        Effect.sync(() => inspections >= inspectionsAtFlip + 2),
        "1200 millis",
      );
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[1;1R",
      });
      expect(process.writes).toEqual(["\x1b[1;1R"]);
    }),
  );

  it.effect("treats missing foreground ownership as unknown instead of foreground", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [],
      };
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      inspect = {
        hasRunningSubprocess: true,
        childCommand: "sleep",
        processIds: [100],
      };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[?1;2c",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect(
    "relays replies to a running Windows child when foreground ownership is unavailable",
    () =>
      Effect.gen(function* () {
        const inspect = {
          hasRunningSubprocess: true,
          childCommand: "vim.exe",
          processIds: [100],
        };
        const fixture = yield* createManager(5, {
          subprocessInspector: () => Effect.succeed(inspect),
          subprocessPollIntervalMs: 20,
        }).pipe(Effect.provide(withHostPlatform("win32")));
        const { manager, ptyAdapter, getEvents } = fixture;
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
          ),
          "1200 millis",
        );
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "\x1b[1;2R",
        });

        expect(process.writes).toEqual(["\x1b[1;2R"]);
      }),
  );

  it.effect("drops an idle-shell reply prefix before relaying foreground input", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
        readonly shellForeground?: boolean;
      } = {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [],
        shellForeground: true,
      };
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\x1b[1",
      });
      inspect = {
        hasRunningSubprocess: true,
        childCommand: "vim",
        processIds: [100],
        shellForeground: false,
      };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess),
        ),
        "1200 millis",
      );

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "x",
      });
      expect(process.writes).toEqual(["x"]);
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessInspector: () => {
          checks += 1;
          return Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("caps history by characters when a redraw stream has no newlines", () =>
    Effect.gen(function* () {
      // A full-screen program repainting with synchronized-output frames emits
      // megabytes with almost no newlines — the line cap alone retains all of
      // it (observed: 21 MB at 4,999 lines). The character cap bounds it.
      const { manager, ptyAdapter } = yield* createManager(5_000, { historyCharLimit: 400 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const frame = "\u001b[?2026h\u001b[18;2H\u001b[0m\u001b[49m\u001b[Kframe\u001b[?2026l";
      for (let i = 0; i < 40; i += 1) {
        process.emitData(frame);
      }
      process.emitData("tail-marker");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history.length).toBeLessThanOrEqual(400);
      expect(reopened.history.includes("tail-marker")).toBe(true);
      // The cut lands on an escape boundary, not mid-sequence.
      expect(reopened.history.startsWith("\u001b")).toBe(true);
    }),
  );

  it.effect("does not split a surrogate pair at the history character boundary", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5_000, { historyCharLimit: 2 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      // UTF-16 indices: A=0, emoji high=1, emoji low=2, B=3. A hard cut at
      // length-maxChars (=2) would retain a lone low surrogate followed by B.
      process.emitData("A😀B");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).toBe("😀B");
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      // A colour QUERY is replay-unsafe (the emulator would re-answer it); the
      // rgb SET form is legitimate output and covered by the grammar invariants.
      process.emitData("\u001b]11;?\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect("sanitizes a pre-existing raw history log on load (older builds wrote it dirty)", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const logPath = yield* historyLogPath(logsDir);
      // A log an older build persisted without sanitizing: the exact repeating
      // DECRPM residue from #1238, ESC introducers intact. On load it must be
      // stripped so it cannot replay (and re-trigger) at the prompt.
      const garble = "[?69;0$y[?2026;2$y[?2027;0$y[?2031;0$y[?2048;0$y";
      yield* writeFileString(logPath, `prompt$ ${garble.repeat(15)}done\n`);

      const opened = yield* manager.open(openInput());
      assert.equal(opened.history, "prompt$ done\n");
      // The cleaned history is persisted back, so it stays clean on re-read.
      assert.equal(yield* readFileString(logPath), "prompt$ done\n");
    }),
  );
  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("?\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
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
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      const path = yield* Path.Path;
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("publishes closed events when terminals are explicitly closed", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));

      yield* manager.close({ threadId: "thread-1" });

      const closedEvents = (yield* getEvents).filter(
        (event): event is Extract<TerminalEvent, { type: "closed" }> => event.type === "closed",
      );
      expect(closedEvents.map((event) => event.terminalId).sort()).toEqual(["default", "sidecar"]);
    }),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, "thread-1").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2" }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1" }));

      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "");
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
      const platform = yield* HostProcessPlatform;
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

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
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
      }).pipe(Effect.provide(withHostPlatform("win32")));
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

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      // Arbitrary host env vars must pass through — terminals inherit the
      // user's environment apart from the explicit blocklist.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
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
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      // AppImage runtime markers must never reach the PTY — tools inside the
      // terminal otherwise resolve against the AppImage mount (e.g. PHP_BINARY
      // reporting the AppImage path instead of the real binary).
      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      // PATH/LD_LIBRARY_PATH keep the user's real entries but drop the AppImage
      // mount segments that the runtime prepended.
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      // Unrelated host vars still pass through untouched.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("leaves the environment untouched when not launched from an AppImage", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LD_LIBRARY_PATH: "/home/user/.local/lib",
          // Without APPIMAGE/APPDIR set, OWD is an ordinary variable and must
          // not be stripped — only an AppImage launch gives it special meaning.
          OWD: "/home/user/keep-this",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.OWD).toBe("/home/user/keep-this");
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(
        openInput({
          env: {
            T3CODE_PROJECT_ROOT: "/repo",
            T3CODE_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.T3CODE_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.T3CODE_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("subscribes terminal metadata with an initial snapshot and live deltas", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const metadataEvents = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadataEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const initialEvents = yield* Ref.get(metadataEvents);
      expect(initialEvents[0]).toMatchObject({
        type: "snapshot",
        terminals: [
          {
            threadId: "existing-thread",
            terminalId: DEFAULT_TERMINAL_ID,
          },
        ],
      });

      yield* manager.open(openInput({ threadId: "new-thread" }));

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "upsert" &&
              event.terminal.threadId === "new-thread" &&
              event.terminal.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );

      yield* manager.close({ threadId: "new-thread", terminalId: DEFAULT_TERMINAL_ID });

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "remove" &&
              event.threadId === "new-thread" &&
              event.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );
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

  it.effect(
    "streams attach snapshots followed by live events without duplicate start snapshots",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          ptyAdapter: new FakePtyAdapter("async"),
        });
        const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
        const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
          Ref.update(attachEvents, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        expect(yield* Ref.get(attachEvents)).toMatchObject([
          {
            type: "snapshot",
            snapshot: {
              threadId: "thread-1",
              terminalId: DEFAULT_TERMINAL_ID,
            },
          },
        ]);

        process.emitData("hello from attach\n");

        yield* waitFor(
          Effect.map(Ref.get(attachEvents), (events) =>
            events.some((event) => event.type === "output" && event.data === "hello from attach\n"),
          ),
          "1200 millis",
        );

        const events = yield* Ref.get(attachEvents);
        expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
      }),
  );

  it.effect("buffers attach output delivered during the initial snapshot callback", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      yield* manager.open(openInput());

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Effect.gen(function* () {
          yield* Ref.update(attachEvents, (events) => [...events, event]);
          if (event.type === "snapshot") {
            yield* Effect.sync(() => process.emitData("during snapshot\n"));
            yield* Effect.yieldNow;
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* waitFor(
        Effect.map(Ref.get(attachEvents), (events) =>
          events.some((event) => event.type === "output" && event.data === "during snapshot\n"),
        ),
        "1200 millis",
      );

      expect(yield* Ref.get(attachEvents)).toMatchObject([
        { type: "snapshot" },
        { type: "output", data: "during snapshot\n" },
      ]);
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n", sequence: 2 }),
        expect.objectContaining({ type: "output", data: "second\n", sequence: 3 }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0, sequence: 4 }),
      ]);

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      expect(snapshot.snapshot.sequence).toBe(4);
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("hasReplyUnawareForegroundProcess", () => {
  it("detects a nested pager in the foreground process group", () => {
    expect(
      hasReplyUnawareForegroundProcess({
        platform: "linux",
        foregroundProcessGroupId: 200,
        shellForeground: false,
        childPid: 101,
        childCommand: "git",
        processes: [
          { pid: 101, processGroupId: 200, command: "git" },
          { pid: 102, processGroupId: 200, command: "less" },
        ],
      }),
    ).toBe(true);
  });

  it("ignores a background pager when an interactive app owns the foreground group", () => {
    expect(
      hasReplyUnawareForegroundProcess({
        platform: "linux",
        foregroundProcessGroupId: 300,
        shellForeground: false,
        childPid: 101,
        childCommand: "vim",
        processes: [
          { pid: 101, processGroupId: 300, command: "vim" },
          { pid: 102, processGroupId: 200, command: "less" },
        ],
      }),
    ).toBe(false);
  });

  it("does not use the direct-pager fallback when another foreground group is observed", () => {
    expect(
      hasReplyUnawareForegroundProcess({
        platform: "linux",
        foregroundProcessGroupId: 300,
        shellForeground: false,
        childPid: 101,
        childCommand: "less",
        processes: [
          { pid: 101, processGroupId: undefined, command: "" },
          { pid: 102, processGroupId: 300, command: "vim" },
        ],
      }),
    ).toBe(false);
  });

  it("falls back to a known direct pager when tree metadata is unavailable", () => {
    expect(
      hasReplyUnawareForegroundProcess({
        platform: "linux",
        foregroundProcessGroupId: 200,
        shellForeground: false,
        childPid: 101,
        childCommand: "less",
        processes: [{ pid: 101, processGroupId: undefined, command: "" }],
      }),
    ).toBe(true);
  });
});

describe("sanitizeTerminalHistoryChunk", () => {
  const sanitize = (data: string, pending = "") => sanitizeTerminalHistoryChunk(pending, data);

  it("strips DECRPM mode reports (CSI ? Pm ; Ps $ y) from history", () => {
    const reports = "\x1b[?69;0$y\x1b[?2026;2$y\x1b[?2048;0$y";
    const { visibleText } = sanitize(`before${reports}after`);
    assert.equal(visibleText, "beforeafter");
    // The residue users were seeing must not survive.
    assert.ok(!visibleText.includes("$y"));
    assert.ok(!visibleText.includes("2026"));
  });

  it("strips DECRQM mode queries (CSI ? Pm $ p) so replay can't re-trigger them", () => {
    const { visibleText } = sanitize("x\x1b[?2026$p\x1b[?2048$py");
    assert.equal(visibleText, "xy");
  });

  it("keeps ordinary text and non-report CSI sequences", () => {
    // SGR colour (m) and cursor moves stay; a plain 'p'/'y' without the `$`
    // intermediate is not a mode sequence and must be preserved.
    const { visibleText } = sanitize("\x1b[31mred\x1b[0m \x1b[2Aup happy");
    assert.equal(visibleText, "\x1b[31mred\x1b[0m \x1b[2Aup happy");
  });

  it("drops the flattened mode-reply residue a shell echoes at the prompt", () => {
    // The ESC introducer is already gone (the shell flattened the reply), so the
    // escape-aware strip can't see it. A run of flattened DECRPM / DA / OSC-colour
    // replies is dropped (DSR "n"/BEL/CR may separate them).
    assert.equal(
      sanitize("prompt$ 69;0$y2026;2$y2027;0$y2031;0$y2048;0$y").visibleText,
      "prompt$ ",
    );
    assert.equal(sanitize("a 1;2c11;rgb:1616/1616/1616n1;2c b").visibleText, "a  b");
    // Lone DECRPM / OSC-colour / DECRPSS tokens are distinctive enough on their own.
    assert.equal(sanitize("x 2026;2$y y").visibleText, "x  y");
    assert.equal(sanitize("c 4;0;rgb:1818/1e1e/2626 d").visibleText, "c  d");
    assert.equal(sanitize("c ;0;rgb:1818/1e1e/2626 d").visibleText, "c  d");
    assert.equal(sanitize("c ;rgb:1616/1616/1616 d").visibleText, "c  d");
    assert.equal(sanitize("tail 1$r0m end").visibleText, "tail  end"); // flattened DECRPSS (#1238)
    // Ambiguous lone tokens and ordinary words are preserved.
    assert.equal(sanitize("see commit 1;2c now").visibleText, "see commit 1;2c now");
    assert.equal(sanitize("running a connection").visibleText, "running a connection");
  });

  it("drops a flattened cursor-position-report (CPR) run, keeps a lone one", () => {
    // The `;1RR`/`<row>;<col>R` flood from a prompt's CSI 6n re-query echoing at
    // an idle prompt. Stripped as a run; a lone `<n>;<n>R` is ambiguous and kept.
    assert.equal(sanitize(`prompt$ ${";1RR".repeat(40)}`).visibleText, "prompt$ ");
    assert.equal(sanitize(`x ${"1;1R".repeat(20)} y`).visibleText, "x  y");
    assert.equal(sanitize("at 12;5R done").visibleText, "at 12;5R done"); // lone, kept
  });

  it("drops the BEL-fragmented CPR flood captured from the nested renderer", () => {
    const captured = ";1R\x07R\x07R\x07;1R\x07R\x07R\x07;1R\x07R\x07R\x07";
    assert.equal(sanitize(`prompt$ ${captured}`).visibleText, "prompt$ ");
  });

  it("drops the collapsed palette-reply run captured from the terminal log", () => {
    const captured =
      "6e6e/7878/8888;RR;;;rgb:1616/1616/1616;rgb:f5f5/f5f5/f5f5;" +
      "2;rgb:8686/e7e7/9595;5;rgb:d0d0/b0b0/ffff;RR;;;rgb:1616/1616/1616;" +
      "rgb:f5f5/f5f5/f5f5;2;rgb:8686/e7e7/9595;5;rgb:d0d0/b0b0/ffff";
    assert.equal(sanitize(`prompt$ ${captured}`).visibleText, "prompt$ ");
  });

  it("drops shell caret notation for the captured reply flood", () => {
    const captured = "^[[I^[[I^[[?^[[?^[[?1;2c^[]^[\\^[[0n^[]^[\\^[[0n^[[16;1R^[[1;1R";
    assert.equal(sanitize(`before${captured}after`).visibleText, "beforeafter");
  });

  it("drops a flattened secondary-DA (three-parameter) run", () => {
    // `CSI > Pp;Pv;Pc c` flattens to ">0;276;0c" (the ">" is sometimes kept by
    // the echo); stripped in a run like the two-parameter primary form.
    assert.equal(sanitize("prompt$ >0;276;0c>0;276;0c").visibleText, "prompt$ ");
    assert.equal(sanitize("a 0;276;0c1;2c b").visibleText, "a  b");
    // A lone three-parameter token is ambiguous and kept.
    assert.equal(sanitize("ver 0;276;0c here").visibleText, "ver 0;276;0c here");
  });

  it("does not over-match ordinary text that merely looks reply-shaped", () => {
    // The colour alternative is pinned to OSC 10/11/12 and OSC 4 (`4;<idx>;`), so
    // an arbitrary "<n>;rgb:…" in program output survives.
    assert.equal(sanitize("set 1;rgb:ff/00/00 now").visibleText, "set 1;rgb:ff/00/00 now");
    assert.equal(sanitize("hsl 7;rgb:aabbcc done").visibleText, "hsl 7;rgb:aabbcc done");
    // A DECRPM/DA token immediately followed by a word must not swallow its first
    // letter (regression: a trailing "n?" used to eat the "n" of "next").
    assert.equal(sanitize("v 1;2$ynext").visibleText, "v next");
    // The DECRPSS payload is length-bounded so it can't eat a following number run.
    assert.equal(
      sanitize("tail 1$r0;120;340;Hello there").visibleText,
      "tail 1$r0;120;340;Hello there",
    );
    // A space is ordinary text, not a run separator: an ambiguous lone token next
    // to a genuine one must not be bridged into a deletable run — only the
    // unambiguous DECRPM token goes.
    assert.equal(sanitize("see 1;2c 2026;2$y now").visibleText, "see 1;2c  now");
    assert.equal(
      sanitize("coords 5;10c 6;11c 7;12c here").visibleText,
      "coords 5;10c 6;11c 7;12c here",
    );
  });

  it("strips an OSC 4 palette query from scrollback but relays it live", () => {
    // A replayed OSC 4 query (`OSC 4;<idx>;? ST`) makes the emulator re-answer,
    // and the echoed answer garbles the prompt — so scrollback drops it, while
    // the live stream relays it for the client to answer (the answer is then
    // stripped by the input filter, breaking the loop).
    const query = "\x1b]4;1;?\x07";
    assert.equal(sanitize(`a${query}b`).visibleText, "ab");
    assert.equal(
      sanitizeTerminalHistoryChunk("", `a${query}b`, { responsesOnly: true }).visibleText,
      `a${query}b`,
    );
  });

  it("preserves a framed OSC 4 palette report instead of mangling its inner rgb", () => {
    // The escape walk keeps a framed OSC 4 report (only OSC 10/11/12 are stripped),
    // so the flattened pass must not delete the inner `4;<idx>;rgb:…` and leave a
    // broken `ESC ] … ST` shell — in either view. The flattened (unframed) form is
    // still dropped.
    const framed = "\x1b]4;1;rgb:ff/00/00\x07";
    assert.equal(sanitize(`a ${framed} b`).visibleText, `a ${framed} b`);
    assert.equal(
      sanitizeTerminalHistoryChunk("", `a ${framed} b`, { responsesOnly: true }).visibleText,
      `a ${framed} b`,
    );
    assert.equal(sanitize("echo 4;1;rgb:ff/00/00 here").visibleText, "echo  here");
  });

  it("strips a huge adversarial ';'-run in linear time (no ReDoS)", () => {
    // A program-controlled buffer of many "<digits>;" groups that never reaches
    // "rgb:" used to drive catastrophic backtracking (tens of seconds). The
    // pinned colour alternative makes this fail fast.
    const evil = "1".repeat(20) + ";";
    const start = process.hrtime.bigint();
    sanitize(`${evil.repeat(16000)}rgb`);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 1000, `flattened strip took ${ms}ms — possible ReDoS`);
  });

  it("handles a report split across chunks via the pending buffer", () => {
    const first = sanitize("tail\x1b[?69;0");
    assert.equal(first.visibleText, "tail");
    assert.notEqual(first.pendingControlSequence, "");
    const second = sanitize("$ydone", first.pendingControlSequence);
    assert.equal(second.visibleText, "done");
  });

  it("flushes an over-long unterminated introducer instead of freezing the stream", () => {
    // A stray OSC/DCS introducer with no terminator (binary output, a program
    // killed mid-escape-write) must not swallow all subsequent output into the
    // pending buffer forever — past the cap the remainder flushes verbatim and
    // the stream recovers.
    let pending = "";
    let emitted = "";
    const first = sanitize("before\x1b]0;never-terminated-", pending);
    emitted += first.visibleText;
    pending = first.pendingControlSequence;
    assert.equal(first.visibleText, "before");
    assert.notEqual(pending, "");
    const chunk = "x".repeat(8 * 1024);
    for (let i = 0; i < 12; i += 1) {
      const step = sanitize(chunk, pending);
      emitted += step.visibleText;
      pending = step.pendingControlSequence;
    }
    assert.ok(
      emitted.includes("x".repeat(1024)),
      "stream stayed frozen after an unterminated introducer",
    );
    assert.equal(pending, "");
    // Later output flows normally again.
    assert.equal(sanitize("after", pending).visibleText, "after");
  });

  it("still strips framed replies inside an overflow-recovered tail", () => {
    // The overflow recovery re-sanitizes the remainder after the stuck
    // introducer instead of flushing it raw, so a framed capability reply
    // buried past an unterminated introducer can't land in history and replay.
    const junk = "j".repeat(70 * 1024);
    const result = sanitize(`\x9d${junk}\x1b[?2026;2$yvisible`);
    assert.equal(result.visibleText.includes("2026;2$y"), false);
    assert.equal(result.visibleText.includes("visible"), true);
    assert.equal(result.visibleText.includes(junk.slice(0, 1024)), true); // junk kept (raw text)
  });

  it("preserves scrollback after an unterminated introducer on whole-buffer load", () => {
    // A log written by an older build can contain an introducer with no
    // terminator partway through; everything after it must survive the
    // load-time sanitize verbatim, since the result is persisted back over the
    // log file (dropping the pending tail would be permanent truncation).
    const raw = `early history\n\x1b]0;unterminated${"later content\n".repeat(50)}`;
    assert.equal(sanitizePersistedTerminalHistory(raw), raw);
    // Residue in the terminated portion is still stripped; the tail survives.
    const dirty = "prompt$ \x1b[?2026;2$y rest\x1b]0;tail-without-terminator";
    const cleaned = sanitizePersistedTerminalHistory(dirty);
    assert.equal(cleaned.includes("$y"), false);
    assert.equal(cleaned.includes("tail-without-terminator"), true);
  });

  it("self-heals a flattened token split across PTY chunks on the next reload", () => {
    // A *flattened* reply (ESC introducer already gone) has no escape framing for
    // the pending buffer to hold, so if a PTY read splits it mid-token both halves
    // are written to history live (transient garble). But they land contiguously,
    // so readHistory()'s whole-buffer sanitize rejoins and strips them on restore —
    // the residue does not return after a restart (the persistence concern in the
    // cross-chunk #1238 follow-up).
    const live = sanitize("prompt$ 2026;2").visibleText + sanitize("$y done").visibleText;
    assert.equal(live, "prompt$ 2026;2$y done"); // contiguous in the persisted log
    assert.equal(sanitize(live).visibleText, "prompt$  done"); // stripped on reload
  });

  it("strips the real-world restore residue reported in issue #1238", () => {
    // The exact escape-reply fragments a user saw flood the prompt on terminal
    // restore: "2026;2$y2027;0$y2031;0$y2048;0$y1$r0m" — DECRPM mode reports
    // (CSI ? Pm ; Ps $ y) plus a DECRPSS status reply (DCS Ps $ r D…D ST),
    // reconstructed as the raw sequences the replayed history carried.
    const residue = "\x1b[?2026;2$y\x1b[?2027;0$y\x1b[?2031;0$y\x1b[?2048;0$y\x1bP1$r0m\x1b\\";
    assert.equal(sanitize(`prompt$ ${residue}`).visibleText, "prompt$ ");
  });

  describe("responsesOnly (live stream)", () => {
    const live = (data: string, pending = "") =>
      sanitizeTerminalHistoryChunk(pending, data, { responsesOnly: true });

    it("strips terminal responses (DA, DECRPM, cursor, DSR) that leak as garbage", () => {
      const responses = "\x1b[?1;2c\x1b[?2026;2$y\x1b[2;5R\x1b[0n";
      assert.equal(live(`a${responses}b`).visibleText, "ab");
    });

    it("keeps framed OSC 10/11/12 rgb output — the legitimate set-colour command", () => {
      // In OUTPUT that shape is a host→terminal set (themes), not a response;
      // the reply form only travels as client input, where it is stripped.
      const set = "\x1b]11;rgb:1616/1616/1616\x07";
      assert.equal(live(`a${set}b`).visibleText, `a${set}b`);
      assert.equal(sanitize(`a${set}b`).visibleText, `a${set}b`);
    });

    it("keeps queries the client must still answer (DECRQM, DA, DSR, OSC colour)", () => {
      const queries = "\x1b[?2026$p\x1b[c\x1b[6n\x1b]11;?\x07";
      assert.equal(live(`x${queries}y`).visibleText, `x${queries}y`);
    });

    it("keeps ordinary display sequences", () => {
      assert.equal(live("\x1b[31mred\x1b[0m up").visibleText, "\x1b[31mred\x1b[0m up");
    });

    it("relays a query split across chunks while history strips it", () => {
      // The query (DECRQM `$p`) arrives in two pieces. The live view must relay
      // it across the pending boundary; the scrollback view strips it.
      const liveFirst = live("x\x1b[?2026");
      assert.equal(liveFirst.visibleText, "x");
      assert.notEqual(liveFirst.pendingControlSequence, "");
      assert.equal(live("$py", liveFirst.pendingControlSequence).visibleText, "\x1b[?2026$py");

      const histFirst = sanitize("x\x1b[?2026");
      assert.equal(histFirst.visibleText, "x");
      assert.equal(sanitize("$py", histFirst.pendingControlSequence).visibleText, "y");
    });

    it("diverges within one chunk: strips the response, relays the query", () => {
      // `\x1b[0n` is a DSR *response* (stripped by both views); `\x1b[6n` is the
      // cursor-position *query* the client must answer (relayed live, stripped
      // from scrollback). Same input, two outputs from one parse.
      const data = "A\x1b[0n B\x1b[6n C";
      assert.equal(live(data).visibleText, "A B\x1b[6n C");
      assert.equal(sanitize(data).visibleText, "A B C");
    });
  });

  describe("8-bit C1 introducers", () => {
    it("strips an 8-bit CSI DECRPM report (0x9b … $ y) like its ESC[ form", () => {
      assert.equal(sanitize("a\x9b?2026;2$yb").visibleText, "ab");
      // Live view strips the report too (it is a response, not a query).
      assert.equal(
        sanitizeTerminalHistoryChunk("", "a\x9b?2026;2$yb", { responsesOnly: true }).visibleText,
        "ab",
      );
    });

    it("keeps an 8-bit OSC colour set (0x9d … BEL); relays the query live only", () => {
      // The rgb form in output is the legitimate set-colour command — kept in
      // both views, 8-bit framing included.
      assert.equal(
        sanitize("a\x9d11;rgb:1616/1616/1616\x07b").visibleText,
        "a\x9d11;rgb:1616/1616/1616\x07b",
      );
      // The `?` colour query is relayed live (the client must answer it) but
      // stripped from scrollback so a replay cannot re-trigger it.
      assert.equal(
        sanitizeTerminalHistoryChunk("", "a\x9d11;?\x07b", { responsesOnly: true }).visibleText,
        "a\x9d11;?\x07b",
      );
      assert.equal(sanitize("a\x9d11;?\x07b").visibleText, "ab");
    });

    it("buffers an incomplete 8-bit CSI across chunks", () => {
      const first = sanitize("tail\x9b?69;0");
      assert.equal(first.visibleText, "tail");
      assert.notEqual(first.pendingControlSequence, "");
      assert.equal(sanitize("$ydone", first.pendingControlSequence).visibleText, "done");
    });
  });

  describe("DCS status strings (DECRQSS / DECRPSS)", () => {
    const live = (data: string) => sanitizeTerminalHistoryChunk("", data, { responsesOnly: true });

    it("strips a DECRPSS status reply (DCS Ps $ r D…D ST) from both views", () => {
      assert.equal(sanitize("a\x1bP1$r0m\x1b\\b").visibleText, "ab");
      assert.equal(live("a\x1bP1$r0m\x1b\\b").visibleText, "ab");
    });

    it("relays a DECRQSS query (DCS $ q D…D ST) live but strips it from scrollback", () => {
      assert.equal(live("a\x1bP$qm\x1b\\b").visibleText, "a\x1bP$qm\x1b\\b");
      assert.equal(sanitize("a\x1bP$qm\x1b\\b").visibleText, "ab");
    });

    it("leaves other DCS strings (sixel, DECUDK) untouched", () => {
      const sixel = "\x1bPq#0;2;0;0;0#0~~\x1b\\";
      assert.equal(sanitize(`a${sixel}b`).visibleText, `a${sixel}b`);
      assert.equal(live(`a${sixel}b`).visibleText, `a${sixel}b`);
    });
  });
});

describe("stripTerminalResponsesFromInput", () => {
  it("drops the browser's auto-replies that drive the echo loop", () => {
    const flood =
      "\x1b[?69;0$y\x1b[?2026;2$y\x1b[?1;2c\x1b]11;rgb:1616/1616/1616\x1b\\\x1b[0n\x1bP1$r0m\x1b\\\x1b[>0;276;0c";
    assert.equal(stripTerminalResponsesFromInput(flood), "");
  });

  it("accepts the 8-bit ST (0x9c) terminator for OSC/DCS replies", () => {
    assert.equal(stripTerminalResponsesFromInput("\x1b]11;rgb:1616/1616/1616\x9c"), "");
    assert.equal(stripTerminalResponsesFromInput("\x1bP1$r0m\x9c"), "");
  });

  it("strips OSC 4 palette colour replies so they can't re-arm the echo loop", () => {
    assert.equal(stripTerminalResponsesFromInput("\x1b]4;1;rgb:1616/1616/1616\x07"), "");
    assert.equal(stripTerminalResponsesFromInput("\x1b]4;255;rgb:ffff/0000/0000\x1b\\"), "");
  });

  it("strips replies that use 8-bit C1 introducers (0x9b CSI, 0x9d OSC, 0x90 DCS)", () => {
    assert.equal(stripTerminalResponsesFromInput("\x9b?69;0$y"), ""); // C1 CSI DECRPM
    assert.equal(stripTerminalResponsesFromInput("\x9b>0;276;0c"), ""); // C1 CSI secondary DA
    assert.equal(stripTerminalResponsesFromInput("\x9d4;1;rgb:1616/1616/1616\x9c"), ""); // C1 OSC 4 + C1 ST
    assert.equal(stripTerminalResponsesFromInput("\x901$r0m\x9c"), ""); // C1 DCS DECRPSS
  });

  it("strips focus events before they redraw an idle prompt", () => {
    assert.equal(stripTerminalResponsesFromInput("\x1b[I"), ""); // focus in
    assert.equal(stripTerminalResponsesFromInput("\x1b[O"), ""); // focus out
  });

  it("strips empty OSC/DCS frames left by a fragmented response", () => {
    assert.equal(stripTerminalResponsesFromInput("\x1b]\x1b\\"), "");
    assert.equal(stripTerminalResponsesFromInput("\x1bP\x1b\\"), "");
  });

  it("strips cursor-position report (CPR) replies that drive the prompt redraw flood", () => {
    assert.equal(stripTerminalResponsesFromInput("\x1b[1;1R"), ""); // CPR reply
    assert.equal(stripTerminalResponsesFromInput("\x1b[;1R"), ""); // empty-row CPR
    assert.equal(stripTerminalResponsesFromInput("\x1b[1;1R\x1b[1;1R\x1b[1;1R"), ""); // flood
    assert.equal(stripTerminalResponsesFromInput("\x9b5;10R"), ""); // 8-bit C1 CPR
    // DEC-private CPR (`CSI ? r;c R`, the DECXCPR answer to `CSI ? 6 n`) —
    // matches the output strip so neither form can feed the echo loop.
    assert.equal(stripTerminalResponsesFromInput("\x1b[?1;1R"), "");
    assert.equal(stripTerminalResponsesFromInput("\x9b?5;10R"), "");
  });

  it("strips CPR-shaped bytes without requiring an observable query", () => {
    // `CSI 1;2R` also encodes Shift+F3, but the idle-shell filter cannot know
    // about queries issued by an outer renderer. Foreground programs bypass the
    // filter and still receive the same bytes verbatim.
    assert.equal(stripTerminalResponsesFromInput("\x1b[1;2R"), "");
    assert.equal(stripTerminalResponsesFromInput("\x1b[?2026;2$y\x1b[1;2R"), "");
  });

  it("keeps real user input, cursor moves, and bare query forms", () => {
    assert.equal(stripTerminalResponsesFromInput("ls -la\r"), "ls -la\r"); // keystrokes
    assert.equal(
      stripTerminalResponsesFromInput("\x1b[A\x1b[B\x1b[C\x1b[D"),
      "\x1b[A\x1b[B\x1b[C\x1b[D",
    ); // arrows
    assert.equal(stripTerminalResponsesFromInput("\x03"), "\x03"); // Ctrl-C
    assert.equal(stripTerminalResponsesFromInput("\x1b[1;5H"), "\x1b[1;5H"); // cursor-move (H, not CPR)
    assert.equal(stripTerminalResponsesFromInput("\x1b[c"), "\x1b[c"); // bare DA query kept
    assert.equal(stripTerminalResponsesFromInput("\x1b[>c"), "\x1b[>c"); // bare secondary DA query kept
    assert.equal(stripTerminalResponsesFromInput("\x1b[6n"), "\x1b[6n"); // DSR query kept
  });
});

describe("sanitizeTerminalInputChunk", () => {
  it("reassembles and strips replies split across client writes", () => {
    const cprPrefix = sanitizeTerminalInputChunk("", "\x1b[16");
    assert.equal(cprPrefix.data, "");
    assert.equal(cprPrefix.pendingControlSequence, "\x1b[16");
    assert.deepEqual(sanitizeTerminalInputChunk(cprPrefix.pendingControlSequence, ";1R"), {
      data: "",
      pendingControlSequence: "",
    });

    const oscPrefix = sanitizeTerminalInputChunk("", "\x1b]11;rgb:1616");
    assert.equal(oscPrefix.data, "");
    assert.deepEqual(
      sanitizeTerminalInputChunk(oscPrefix.pendingControlSequence, "/1616/1616\x07"),
      { data: "", pendingControlSequence: "" },
    );
  });

  it("strips CPR split immediately after ESC while keeping complete real keys", () => {
    const prefix = sanitizeTerminalInputChunk("", "\x1b[1");
    assert.deepEqual(sanitizeTerminalInputChunk(prefix.pendingControlSequence, ";2R"), {
      data: "",
      pendingControlSequence: "",
    });
    assert.deepEqual(sanitizeTerminalInputChunk("", "\x1b"), {
      data: "",
      pendingControlSequence: "\x1b",
    });
    assert.deepEqual(sanitizeTerminalInputChunk("\x1b", "[1;2R"), {
      data: "",
      pendingControlSequence: "",
    });
    assert.deepEqual(sanitizeTerminalInputChunk("", "\x1b[A"), {
      data: "\x1b[A",
      pendingControlSequence: "",
    });
  });

  it("bounds an unterminated string instead of growing session state forever", () => {
    const malformed = `\x1b]11;rgb:${"a".repeat(64 * 1024)}`;
    assert.deepEqual(sanitizeTerminalInputChunk("", malformed), {
      data: malformed,
      pendingControlSequence: "",
    });
  });

  it("drops the captured focus and abandoned private-CSI flood", () => {
    const captured =
      "\x1b[I\x1b[I" +
      "\x1b[?\x1b[?\x1b[?\x1b[?\x1b[?\x1b[?1;2c" +
      "\x1b]\x1b\\\x1b[0n\x1b]\x1b\\\x1b[0n\x1b[I\x1b[?1;2c";

    assert.deepEqual(sanitizeTerminalInputChunk("", captured), {
      data: "",
      pendingControlSequence: "",
    });
  });

  it("drops abandoned CPR and DA prefixes before a fresh response", () => {
    for (const abandoned of ["\x1b[1;", "\x1b[>0;", "\x9b12;", "\x1b[?2026;"]) {
      assert.deepEqual(sanitizeTerminalInputChunk("", `${abandoned}\x1b[1;2R`), {
        data: "",
        pendingControlSequence: "",
      });
    }
  });
});

// ─── Cross-layer grammar invariants ──────────────────────────────────────────
// Every sample in TERMINAL_SEQUENCE_GRAMMAR is exercised against every layer in
// every framing. These encode the consistency laws the individual layers must
// obey — the class of defect earlier review rounds kept finding ("handled in
// layer X, missed in layer Y") fails here instead of shipping.
describe("terminal sequence grammar invariants", () => {
  const historyView = (data: string) => sanitizeTerminalHistoryChunk("", data).visibleText;
  const liveView = (data: string) =>
    sanitizeTerminalHistoryChunk("", data, { responsesOnly: true }).visibleText;

  type Kind = (typeof TERMINAL_SEQUENCE_GRAMMAR)[number]["kind"];
  // 7-bit, 8-bit-C1, and (for string sequences) alternate-terminator framings.
  const framings = (kind: Kind, body: string): ReadonlyArray<[label: string, framed: string]> => {
    switch (kind) {
      case "csi":
        return [
          ["7-bit", `\x1b[${body}`],
          ["8-bit", `\x9b${body}`],
        ];
      case "osc":
        return [
          ["7-bit BEL", `\x1b]${body}\x07`],
          ["7-bit ST", `\x1b]${body}\x1b\\`],
          ["8-bit", `\x9d${body}\x9c`],
        ];
      case "dcs":
        return [
          ["7-bit ST", `\x1bP${body}\x1b\\`],
          ["7-bit BEL", `\x1bP${body}\x07`],
          ["8-bit", `\x90${body}\x9c`],
        ];
    }
  };
  const strippedBy = (view: (data: string) => string, framed: string) =>
    view(`a${framed}b`) === "ab";
  const keptBy = (view: (data: string) => string, framed: string) =>
    view(`a${framed}b`) === `a${framed}b`;

  for (const descriptor of TERMINAL_SEQUENCE_GRAMMAR) {
    describe(descriptor.name, () => {
      const response = descriptor.response;
      if (response) {
        it("response: output views obey stripFromOutput in every framing", () => {
          for (const sample of response.samples) {
            for (const [label, framed] of framings(descriptor.kind, sample)) {
              if (response.stripFromOutput) {
                assert.equal(
                  strippedBy(historyView, framed),
                  true,
                  `history keeps ${label} ${sample}`,
                );
                assert.equal(strippedBy(liveView, framed), true, `live keeps ${label} ${sample}`);
              } else {
                assert.equal(
                  keptBy(historyView, framed),
                  true,
                  `history strips ${label} ${sample}`,
                );
                assert.equal(keptBy(liveView, framed), true, `live strips ${label} ${sample}`);
              }
            }
          }
        });

        it("response: input filter obeys `input` in every framing", () => {
          for (const sample of response.samples) {
            for (const [label, framed] of framings(descriptor.kind, sample)) {
              const filtered = stripTerminalResponsesFromInput(`a${framed}b`);
              if (response.input !== null) {
                assert.equal(filtered, "ab", `input relays ${label} ${sample}`);
              } else {
                assert.equal(filtered, `a${framed}b`, `input strips ${label} ${sample}`);
              }
            }
          }
        });

        it("law: a response stripped from input is stripped from scrollback (OSC 4 rgb is the one documented exception)", () => {
          // Replay safety: if the input filter drops the emulator reply, the
          // persisted scrollback must never carry the framed reply either —
          // except OSC 4 rgb, whose output shape is the legitimate set-palette
          // command and MUST survive output.
          const exception = !response.stripFromOutput;
          for (const sample of response.samples) {
            for (const [label, framed] of framings(descriptor.kind, sample)) {
              if (response.input !== null && !exception) {
                assert.equal(
                  strippedBy(historyView, framed),
                  true,
                  `input-stripped ${label} ${sample} survives scrollback`,
                );
              }
            }
          }
        });
      }

      const query = descriptor.query;
      if (query) {
        it("query: stripped from scrollback, relayed live, untouched in input", () => {
          for (const sample of query.samples) {
            for (const [label, framed] of framings(descriptor.kind, sample)) {
              assert.equal(
                strippedBy(historyView, framed),
                true,
                `history keeps query ${label} ${sample}`,
              );
              assert.equal(keptBy(liveView, framed), true, `live strips query ${label} ${sample}`);
              assert.equal(
                stripTerminalResponsesFromInput(`a${framed}b`),
                `a${framed}b`,
                `input strips query ${label} ${sample}`,
              );
            }
          }
        });
      }

      const flattened = descriptor.flattened;
      if (flattened) {
        it("flattened: a run always strips; a lone token strips iff loneStrippable", () => {
          for (const sample of flattened.samples) {
            const run = `${sample}${sample}`;
            assert.equal(historyView(`a ${run} b`), "a  b", `run survives history: ${sample}`);
            assert.equal(liveView(`a ${run} b`), "a  b", `run survives live: ${sample}`);
            if (flattened.loneStrippable) {
              assert.equal(historyView(`a ${sample} b`), "a  b", `lone token survives: ${sample}`);
            } else {
              assert.equal(
                historyView(`a ${sample} b`),
                `a ${sample} b`,
                `ambiguous lone token stripped: ${sample}`,
              );
            }
          }
        });
      }

      it("law: 7-bit and 8-bit framings behave identically in every layer", () => {
        const bodies = [...(response?.samples ?? []), ...(query?.samples ?? [])];
        for (const sample of bodies) {
          const framed = framings(descriptor.kind, sample);
          const reference = framed[0];
          if (!reference) continue;
          for (const [label, form] of framed.slice(1)) {
            for (const [layer, view] of [
              ["history", historyView],
              ["live", liveView],
              ["input", (data: string) => stripTerminalResponsesFromInput(data)],
            ] as const) {
              assert.equal(
                view(`a${form}b`) === "ab",
                view(`a${reference[1]}b`) === "ab",
                `${layer} disagrees between ${reference[0]} and ${label} for ${sample}`,
              );
            }
          }
        }
      });

      it("law: sanitizing is idempotent over every framed sample", () => {
        const bodies = [...(response?.samples ?? []), ...(query?.samples ?? [])];
        for (const sample of bodies) {
          for (const [label, framed] of framings(descriptor.kind, sample)) {
            const once = historyView(`a${framed}b`);
            assert.equal(historyView(once), once, `history not idempotent for ${label} ${sample}`);
            const live = liveView(`a${framed}b`);
            assert.equal(liveView(live), live, `live not idempotent for ${label} ${sample}`);
          }
        }
      });
    });
  }
});
