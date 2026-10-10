import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  TerminalProviderInstanceNotFoundError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Data from "effect/Data";
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
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;
  exitOnKill: string | undefined;

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
    if (this.exitOnKill !== undefined && signal === this.exitOnKill) {
      this.emitExit({ exitCode: 0, signal: signal === "SIGKILL" ? 9 : null });
    }
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
    Effect.map(({ join }) => join(logsDir, `terminal_${Base64Url.encode(threadId)}.log`)),
  );

const multiTerminalHistoryLogPath = (
  logsDir: string,
  threadId = "thread-1",
  terminalId = DEFAULT_TERMINAL_ID,
) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => {
      const threadPart = `terminal_${Base64Url.encode(threadId)}`;
      return join(
        logsDir,
        terminalId === DEFAULT_TERMINAL_ID
          ? `${threadPart}.log`
          : `${threadPart}_${Base64Url.encode(terminalId)}.log`,
      );
    }),
  );

interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (
    terminalPid: number,
    spawnedShellName: string | null,
  ) => Effect.Effect<{
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
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
  resolveProviderInstanceEnvironment?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveProviderInstanceEnvironment"];
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
  registerTerminalProcesses?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["registerTerminalProcesses"];
  unregisterTerminal?: Parameters<typeof TerminalManager.makeWithOptions>[0]["unregisterTerminal"];
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
        ...(options.registerTerminalProcesses !== undefined
          ? { registerTerminalProcesses: options.registerTerminalProcesses }
          : {}),
        ...(options.unregisterTerminal !== undefined
          ? { unregisterTerminal: options.unregisterTerminal }
          : {}),
        ...(options.processTable !== undefined ? { processTable: options.processTable } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
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

// Apply the existing line policy, then find the longest code-point-aligned byte tail.
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

it("preserves retained lines as older storage is compacted", () => {
  for (const maxLines of [3, 5_000]) {
    let expected = "";
    const history = new TerminalManager.BoundedTerminalHistory(maxLines, expected);
    for (let batch = 0; batch < 40; batch += 1) {
      const chunk = Array.from({ length: 300 }, (_, line) => `${batch}:${line}\n`).join("");
      history.append(chunk);
      expected = retainedHistory(expected + chunk, maxLines);
      expect(history.value()).toBe(expected);
    }
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
      if ((yield* HostProcess.Platform) === "win32") return;

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

  it.effect("derives subprocess activity for every terminal from one shared process snapshot", () =>
    Effect.gen(function* () {
      const runCalls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      // FakePtyAdapter assigns pids starting at 9000, so the two terminals
      // opened below run as pids 9000 and 9001.
      const psStdout = ["  100  9000 vim", "  101   100 git", "  200  9001 /usr/bin/python3"].join(
        "\n",
      );
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.sync(() => {
            runCalls.push({ command: input.command, args: input.args });
            return {
              stdout: psStdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) =>
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "vim",
            ) &&
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "python3",
            ),
        ),
        "1200 millis",
      );
      yield* waitFor(
        Effect.sync(() => runCalls.length >= 3),
        "1200 millis",
      );

      // Every spawn is the shared table snapshot — no per-terminal `pgrep`
      // or per-child `ps -p` invocations.
      expect(runCalls.every((call) => call.args.join(" ") === "-eo pid=,ppid=,comm=")).toBe(true);
    }),
  );

  const exitSnapshotTestProcesses = Effect.fnUntraced(function* (
    manager: ManagerFixture["manager"],
    ptyAdapter: FakePtyAdapter,
    terminals: ReadonlyArray<Pick<TerminalOpenInput, "threadId" | "terminalId">>,
  ) {
    const remainingTerminals = new Set(
      terminals.map(({ threadId, terminalId }) => JSON.stringify([threadId, terminalId])),
    );
    const exited = yield* Deferred.make<void>();
    const unsubscribe = yield* manager.subscribe((event) =>
      Effect.gen(function* () {
        if (
          event.type === "exited" &&
          remainingTerminals.delete(JSON.stringify([event.threadId, event.terminalId])) &&
          remainingTerminals.size === 0
        ) {
          yield* Deferred.succeed(exited, undefined);
        }
      }),
    );
    // Restarted processes have no live manager listener; wait for one exit
    // per current terminal rather than counting every historical fake process.
    for (const process of ptyAdapter.processes) process.emitExit({ exitCode: 0, signal: null });
    yield* Deferred.await(exited);
    unsubscribe();
  });

  const createSnapshotBoundaryManager = (
    source: "native" | "fallback",
    ptyAdapter: FakePtyAdapter,
    processTable: NonNullable<CreateManagerOptions["processTable"]>,
    options: CreateManagerOptions = {},
  ) => {
    const processRunner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) =>
        processTable.pipe(
          Effect.map((entries) => {
            expect(input.args).toEqual(["-eo", "pid=,ppid=,comm="]);
            return {
              stdout: entries.map(({ pid, ppid, name }) => `${pid} ${ppid} ${name}`).join("\n"),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
        ),
    };
    return createManager(5, {
      ptyAdapter,
      shellResolver: () => "/opt/tools/my-shell",
      subprocessPollIntervalMs: 60_000,
      ...options,
      ...(source === "native" ? { processTable } : {}),
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.provide(layerWithHostPlatform("linux")),
    );
  };

  it.effect.each(["native", "fallback"] as const)(
    "forwards first input at 100 ms while the same thread's %s idle snapshot is stalled",
    (source) =>
      Effect.gen(function* () {
        const inspectionEntered = yield* Deferred.make<void>();
        const finishInspection = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextSnapshot = false;
        const processTable = Effect.gen(function* () {
          const entries = ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: process.writes.includes("exec node\r") ? "node" : "zsh",
          }));
          if (holdNextSnapshot) {
            holdNextSnapshot = false;
            yield* Deferred.succeed(inspectionEntered, undefined);
            yield* Deferred.await(finishInspection);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        holdNextSnapshot = true;
        const closing = yield* manager.closeIdle(terminal).pipe(Effect.forkScoped);
        yield* Deferred.await(inspectionEntered);
        const writing = yield* manager
          .write({ ...terminal, data: "exec node\r" })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("100 millis");
        const writesAtDeadline = [...process.writes];
        const writerFinishedAtDeadline = writing.pollUnsafe() !== undefined;
        const cleanupStillPending = closing.pollUnsafe() === undefined;
        // Release and retire every fake before assertions, including when the
        // old locking behavior prevents input from reaching the PTY on time.
        yield* Deferred.succeed(finishInspection, undefined);
        yield* Fiber.join(writing);
        yield* Fiber.join(closing);
        const killedByStaleCleanup = process.killed;
        yield* manager.closeIdle(terminal);
        const killedByFreshCleanup = process.killed;
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);

        expect(writesAtDeadline).toEqual(["exec node\r"]);
        expect(writerFinishedAtDeadline).toBe(true);
        expect(cleanupStillPending).toBe(true);
        expect(killedByStaleCleanup).toBe(false);
        expect(killedByFreshCleanup).toBe(false);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback", "custom"] as const)(
    "keeps newly active input after a same-thread %s idle inspection returns its stale result",
    (source) =>
      Effect.gen(function* () {
        const inspectionEntered = yield* Deferred.make<void>();
        const finishInspection = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextInspection = false;
        const gateInspection = Effect.gen(function* () {
          if (holdNextInspection) {
            holdNextInspection = false;
            yield* Deferred.succeed(inspectionEntered, undefined);
            yield* Deferred.await(finishInspection);
          }
        });
        const processTable = Effect.gen(function* () {
          const entries = ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: process.writes.includes("exec node\r") ? "node" : "zsh",
          }));
          yield* gateInspection;
          return entries;
        });
        const { manager } = yield* source === "custom"
          ? createManager(5, {
              ptyAdapter,
              subprocessPollIntervalMs: 60_000,
              subprocessInspector: () =>
                gateInspection.pipe(
                  Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
                ),
            })
          : createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        // Capture the actual shell before the scan, so its stale idle result
        // really would close this PTY unless successful input invalidates it.
        yield* manager.write({ ...terminal, data: "prepare\r" });
        holdNextInspection = true;
        const closing = yield* manager.closeIdle(terminal).pipe(Effect.forkScoped);
        yield* Deferred.await(inspectionEntered);
        yield* manager.write({ ...terminal, data: "exec node\r" });
        yield* Deferred.succeed(finishInspection, undefined);
        yield* Fiber.join(closing);
        const killSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(process.writes).toEqual(["prepare\r", "exec node\r"]);
        expect(killSignals).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    { source: "native", replacement: "restart" },
    { source: "fallback", replacement: "restart" },
    { source: "custom", replacement: "restart" },
    { source: "native", replacement: "close and reopen" },
    { source: "fallback", replacement: "close and reopen" },
    { source: "custom", replacement: "close and reopen" },
  ] as const)(
    "keeps the replacement PTY after $replacement during a same-thread $source idle inspection",
    ({ source, replacement }) =>
      Effect.gen(function* () {
        const inspectionEntered = yield* Deferred.make<void>();
        const finishInspection = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextInspection = false;
        const gateInspection = Effect.gen(function* () {
          if (holdNextInspection) {
            holdNextInspection = false;
            yield* Deferred.succeed(inspectionEntered, undefined);
            yield* Deferred.await(finishInspection);
          }
        });
        const processTable = Effect.gen(function* () {
          const entries = ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: "zsh",
          }));
          yield* gateInspection;
          return entries;
        });
        const fs = yield* FileSystem.FileSystem;
        const cwdStat = yield* fs.stat(process.cwd());
        // Restart/reopen should suspend only on the held inspection, rather
        // than real filesystem promises outside TestClock's scheduler.
        const replacementFileSystem = {
          ...fs,
          stat: (path: string) =>
            path === process.cwd() ? Effect.succeed(cwdStat) : fs.stat(path),
          exists: () => Effect.succeed(false),
          remove: () => Effect.void,
          writeFileString: () => Effect.void,
        };
        const { manager } = yield* (
          source === "custom"
            ? createManager(5, {
                ptyAdapter,
                subprocessPollIntervalMs: 60_000,
                subprocessInspector: () =>
                  gateInspection.pipe(
                    Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
                  ),
              })
            : createSnapshotBoundaryManager(source, ptyAdapter, processTable)
        ).pipe(Effect.provideService(FileSystem.FileSystem, replacementFileSystem));
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        ptyAdapter.processes[0]!.exitOnKill = "SIGTERM";
        yield* manager.write({ ...terminal, data: "prepare\r" });
        holdNextInspection = true;
        const closing = yield* manager.closeIdle(terminal).pipe(Effect.forkScoped);
        yield* Deferred.await(inspectionEntered);
        const replacing = yield* (
          replacement === "restart"
            ? manager.restart(restartInput())
            : manager.close(terminal).pipe(Effect.andThen(manager.open(terminal)))
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("100 millis");
        const replacedWhileInspectionPending = ptyAdapter.processes.length === 2;
        yield* Deferred.succeed(finishInspection, undefined);
        yield* Fiber.join(replacing);
        yield* Fiber.join(closing);
        const replacementProcess = ptyAdapter.processes[1]!;
        const replacementKillSignals = [...replacementProcess.killSignals];
        if (!replacementProcess.killed) {
          yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        }
        expect(replacedWhileInspectionPending).toBe(true);
        expect(replacementKillSignals).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  const readIdleInspectionMetadata = Effect.fnUntraced(function* (
    manager: ManagerFixture["manager"],
  ) {
    const events: TerminalMetadataStreamEvent[] = [];
    const unsubscribe = yield* manager.subscribeMetadata((event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );
    unsubscribe();
    const initial = events[0];
    return initial?.type === "snapshot" ? initial.terminals : [];
  });

  it.effect.each([
    { source: "native", operation: "open" },
    { source: "fallback", operation: "open" },
    { source: "custom", operation: "open" },
    { source: "native", operation: "attach" },
    { source: "fallback", operation: "attach" },
    { source: "custom", operation: "attach" },
  ] as const)(
    "keeps the existing PTY after active $operation during a same-thread $source idle inspection",
    ({ source, operation }) =>
      Effect.gen(function* () {
        const inspectionEntered = yield* Deferred.make<void>();
        const finishInspection = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextInspection = false;
        const gateInspection = Effect.gen(function* () {
          if (holdNextInspection) {
            holdNextInspection = false;
            yield* Deferred.succeed(inspectionEntered, undefined);
            yield* Deferred.await(finishInspection);
          }
        });
        const processTable = gateInspection.pipe(Effect.as([{ pid: 9000, ppid: 1, name: "zsh" }]));
        const fs = yield* FileSystem.FileSystem;
        const cwdStat = yield* fs.stat(process.cwd());
        const activeOpenFileSystem = {
          ...fs,
          stat: (path: string) =>
            path === process.cwd() ? Effect.succeed(cwdStat) : fs.stat(path),
        };
        const { manager } = yield* (
          source === "custom"
            ? createManager(5, {
                ptyAdapter,
                subprocessPollIntervalMs: 60_000,
                subprocessInspector: () =>
                  gateInspection.pipe(
                    Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
                  ),
              })
            : createSnapshotBoundaryManager(source, ptyAdapter, processTable)
        ).pipe(Effect.provideService(FileSystem.FileSystem, activeOpenFileSystem));
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const originalProcess = ptyAdapter.processes[0]!;
        originalProcess.exitOnKill = "SIGTERM";
        yield* manager.write({ ...terminal, data: "prepare\r" });
        const originalMetadata = yield* readIdleInspectionMetadata(manager);
        holdNextInspection = true;
        const closing = yield* manager.closeIdle(terminal).pipe(Effect.forkScoped);
        yield* Deferred.await(inspectionEntered);
        let returnedPid: number | null = null;
        const listener = (event: TerminalAttachStreamEvent) =>
          Effect.sync(() => {
            if (event.type === "snapshot") returnedPid = event.snapshot.pid;
          });
        const activeOpening = yield* (
          operation === "open"
            ? manager.open(terminal).pipe(
                Effect.tap((snapshot) =>
                  Effect.sync(() => {
                    returnedPid = snapshot.pid;
                  }),
                ),
                Effect.asVoid,
              )
            : manager
                .attachStream(terminal, listener)
                .pipe(
                  Effect.flatMap((unsubscribe) =>
                    Effect.addFinalizer(() => Effect.sync(unsubscribe)),
                  ),
                )
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("100 millis");
        const completedBeforeInspection = activeOpening.pollUnsafe() !== undefined;
        const pidBeforeInspection = returnedPid;
        const spawnCountBeforeInspection = ptyAdapter.processes.length;
        const cleanupStillPending = closing.pollUnsafe() === undefined;
        yield* Deferred.succeed(finishInspection, undefined);
        yield* Fiber.join(activeOpening);
        yield* Fiber.join(closing);
        const staleKillSignals = [...originalProcess.killSignals];
        const metadataAfterStaleInspection = yield* readIdleInspectionMetadata(manager);
        // A successful open/attach invalidates this scan only; it must not
        // permanently protect a shell from the next explicit idle cleanup.
        for (const process of ptyAdapter.processes) process.exitOnKill = "SIGTERM";
        yield* manager.closeIdle(terminal);
        const metadataAfterFreshInspection = yield* readIdleInspectionMetadata(manager);
        if (metadataAfterFreshInspection.some((terminal) => terminal.status === "running")) {
          yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        }
        expect(completedBeforeInspection).toBe(true);
        expect(pidBeforeInspection).toBe(originalProcess.pid);
        expect(spawnCountBeforeInspection).toBe(1);
        expect(cleanupStillPending).toBe(true);
        expect(staleKillSignals).toEqual([]);
        expect(metadataAfterStaleInspection).toEqual(originalMetadata);
        expect(originalProcess.killSignals).toEqual(["SIGTERM"]);
        expect(metadataAfterFreshInspection).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback", "custom"] as const)(
    "closes an idle PTY after passive observation and metadata reads during its %s inspection",
    (source) =>
      Effect.gen(function* () {
        const inspectionEntered = yield* Deferred.make<void>();
        const finishInspection = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextInspection = false;
        const gateInspection = Effect.gen(function* () {
          if (holdNextInspection) {
            holdNextInspection = false;
            yield* Deferred.succeed(inspectionEntered, undefined);
            yield* Deferred.await(finishInspection);
          }
        });
        const processTable = gateInspection.pipe(Effect.as([{ pid: 9000, ppid: 1, name: "zsh" }]));
        const { manager } = yield* source === "custom"
          ? createManager(5, {
              ptyAdapter,
              subprocessPollIntervalMs: 60_000,
              subprocessInspector: () =>
                gateInspection.pipe(
                  Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
                ),
            })
          : createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        yield* manager.write({ ...terminal, data: "prepare\r" });
        holdNextInspection = true;
        const closing = yield* manager.closeIdle(terminal).pipe(Effect.forkScoped);
        yield* Deferred.await(inspectionEntered);
        const observedEvents: TerminalAttachStreamEvent[] = [];
        const observing = yield* manager
          .observeStream(terminal, (event) =>
            Effect.sync(() => {
              observedEvents.push(event);
            }),
          )
          .pipe(
            Effect.flatMap((unsubscribe) => Effect.addFinalizer(() => Effect.sync(unsubscribe))),
            Effect.result,
            Effect.forkScoped({ startImmediately: true }),
          );
        yield* TestClock.adjust("100 millis");
        const metadataDuringInspection = yield* readIdleInspectionMetadata(manager);
        yield* Deferred.succeed(finishInspection, undefined);
        yield* Fiber.join(observing);
        yield* Fiber.join(closing);
        const metadataAfterInspection = yield* readIdleInspectionMetadata(manager);
        const killSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(metadataDuringInspection).toEqual([
          expect.objectContaining({ pid: process.pid, status: "running" }),
        ]);
        expect(observedEvents[0]).toEqual(
          expect.objectContaining({
            type: "snapshot",
            snapshot: expect.objectContaining({ pid: process.pid }),
          }),
        );
        expect(killSignals).toEqual(["SIGTERM"]);
        expect(metadataAfterInspection).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    { source: "native", boundary: "open" },
    { source: "fallback", boundary: "open" },
    { source: "native", boundary: "restart" },
    { source: "fallback", boundary: "restart" },
  ] as const)(
    "captures the actual wrapper shell after $boundary during an older $source snapshot",
    ({ source, boundary }) =>
      Effect.gen(function* () {
        const staleSnapshotStarted = yield* Deferred.make<void>();
        const releaseStaleSnapshot = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextSnapshot = false;
        const processTable = Effect.gen(function* () {
          // Freeze the table before suspending so a newly spawned PID is absent.
          const entries = ptyAdapter.processes
            .filter((process) => !process.killed)
            .map((process) => ({
              pid: process.pid,
              ppid: 1,
              name: process.writes.includes("exec command\r") ? "node" : "zsh",
            }));
          if (holdNextSnapshot) {
            holdNextSnapshot = false;
            yield* Deferred.succeed(staleSnapshotStarted, undefined);
            yield* Deferred.await(releaseStaleSnapshot);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const holder = { threadId: "snapshot-holder", terminalId: "idle" };
        const idle = { threadId: "thread-1", terminalId: "idle" };
        const exec = { threadId: "thread-1", terminalId: "exec" };
        yield* manager.open(openInput(holder));
        ptyAdapter.processes.at(-1)!.exitOnKill = "SIGTERM";
        yield* manager.open(openInput(exec));
        yield* manager.write({ ...exec, data: "exec command\r" });
        const execProcess = ptyAdapter.processes.at(-1)!;
        if (boundary === "restart") {
          yield* manager.open(openInput(idle));
          ptyAdapter.processes.at(-1)!.exitOnKill = "SIGTERM";
        }
        holdNextSnapshot = true;
        const checkingHolder = yield* manager.closeIdle(holder).pipe(Effect.forkScoped);
        yield* Deferred.await(staleSnapshotStarted);

        if (boundary === "restart") yield* manager.restart(restartInput(idle));
        else yield* manager.open(openInput(idle));
        const idleProcess = ptyAdapter.processes.at(-1)!;
        idleProcess.exitOnKill = "SIGTERM";
        const writing = yield* manager.write({ ...idle, data: "noop\r" }).pipe(Effect.forkScoped);
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(releaseStaleSnapshot, undefined);
        yield* Fiber.join(writing);
        yield* Fiber.join(checkingHolder);
        yield* manager.closeIdle({ threadId: "thread-1" });

        const remaining = [
          { terminal: idle, process: idleProcess },
          { terminal: exec, process: execProcess },
        ]
          .filter(({ process }) => !process.killed)
          .map(({ terminal }) => terminal);
        if (remaining.length > 0) {
          yield* exitSnapshotTestProcesses(manager, ptyAdapter, remaining);
        }
        expect(idleProcess.writes).toEqual(["noop\r"]);
        expect(idleProcess.killSignals).toEqual(["SIGTERM"]);
        expect(execProcess.killSignals).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback"] as const)(
    "retains a childless exec after input succeeds during an older %s snapshot",
    (source) =>
      Effect.gen(function* () {
        const staleSnapshotStarted = yield* Deferred.make<void>();
        const releaseStaleSnapshot = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextSnapshot = false;
        const processTable = Effect.gen(function* () {
          // The held scan observes an idle shell before its next successful write.
          const entries = ptyAdapter.processes
            .filter((process) => !process.killed)
            .map((process) => ({
              pid: process.pid,
              ppid: 1,
              name: process.writes.includes("exec command\r") ? "node" : "zsh",
            }));
          if (holdNextSnapshot) {
            holdNextSnapshot = false;
            yield* Deferred.succeed(staleSnapshotStarted, undefined);
            yield* Deferred.await(releaseStaleSnapshot);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const holder = { threadId: "snapshot-holder", terminalId: "idle" };
        const exec = { threadId: "thread-1", terminalId: "exec" };
        const idle = { threadId: "thread-1", terminalId: "idle" };
        yield* manager.open(openInput(holder));
        ptyAdapter.processes.at(-1)!.exitOnKill = "SIGTERM";
        yield* manager.open(openInput(exec));
        const execProcess = ptyAdapter.processes.at(-1)!;
        yield* manager.open(openInput(idle));
        const idleProcess = ptyAdapter.processes.at(-1)!;
        execProcess.exitOnKill = "SIGTERM";
        idleProcess.exitOnKill = "SIGTERM";
        // Finish identity capture before starting the stale scan, so the next
        // write forwards immediately while the old process table is pending.
        yield* manager.write({ ...exec, data: "prepare\r" });
        holdNextSnapshot = true;
        const checkingHolder = yield* manager.closeIdle(holder).pipe(Effect.forkScoped);
        yield* Deferred.await(staleSnapshotStarted);
        yield* manager.write({ ...exec, data: "exec command\r" });
        expect(execProcess.writes).toEqual(["prepare\r", "exec command\r"]);

        const checkingThread = yield* manager
          .closeIdle({ threadId: "thread-1" })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(releaseStaleSnapshot, undefined);
        yield* Fiber.join(checkingThread);
        yield* Fiber.join(checkingHolder);

        const remaining = [
          { terminal: idle, process: idleProcess },
          { terminal: exec, process: execProcess },
        ]
          .filter(({ process }) => !process.killed)
          .map(({ terminal }) => terminal);
        if (remaining.length > 0) {
          yield* exitSnapshotTestProcesses(manager, ptyAdapter, remaining);
        }
        expect(execProcess.killSignals).toEqual([]);
        expect(idleProcess.killSignals).toEqual(["SIGTERM"]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback"] as const)(
    "retains exec roots and child commands after output invalidates a held post-write %s poll",
    (source) =>
      Effect.gen(function* () {
        const staleSnapshotStarted = yield* Deferred.make<void>();
        const releaseStaleSnapshot = yield* Deferred.make<void>();
        const outputsProcessed = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextSnapshot = false;
        let commandsStarted = false;
        let snapshotCalls = 0;
        const processTable = Effect.gen(function* () {
          snapshotCalls += 1;
          // The poll sees the submitted commands before either shell runs them.
          const entries = [
            { pid: 9000, ppid: 1, name: commandsStarted ? "node" : "zsh" },
            { pid: 9001, ppid: 1, name: "zsh" },
            ...(commandsStarted ? [{ pid: 9100, ppid: 9001, name: "node" }] : []),
          ];
          if (holdNextSnapshot) {
            holdNextSnapshot = false;
            yield* Deferred.succeed(staleSnapshotStarted, undefined);
            yield* Deferred.await(releaseStaleSnapshot);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const terminals = ["exec", "child"].map((terminalId) => ({
          threadId: "thread-1",
          terminalId,
        }));
        yield* Effect.forEach(terminals, (terminal) => manager.open(openInput(terminal)));
        for (const process of ptyAdapter.processes) process.exitOnKill = "SIGTERM";
        yield* manager.write({ ...terminals[0]!, data: "exec node\r" });
        yield* manager.write({ ...terminals[1]!, data: "node child\r" });
        holdNextSnapshot = true;
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(staleSnapshotStarted);
        const callsBeforeOutput = snapshotCalls;
        const pendingOutputs = new Set(terminals.map(({ terminalId }) => terminalId));
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "output" &&
          pendingOutputs.delete(event.terminalId) &&
          pendingOutputs.size === 0
            ? Deferred.succeed(outputsProcessed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        commandsStarted = true;
        for (const process of ptyAdapter.processes) process.emitData("command started\n");
        // Await the drained output, including its activity counter update,
        // before closeIdle captures candidates. Its counter guard alone can
        // no longer reject the old table at this point.
        yield* Deferred.await(outputsProcessed);
        const closing = yield* manager
          .closeIdle({ threadId: "thread-1" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("100 millis");
        const finishedBeforeStaleRelease = closing.pollUnsafe() !== undefined;
        const callsAfterOutput = snapshotCalls;
        yield* Deferred.succeed(releaseStaleSnapshot, undefined);
        yield* Fiber.join(closing);
        const killSignals = ptyAdapter.processes.map((process) => [...process.killSignals]);
        const remainingPids = (yield* readIdleInspectionMetadata(manager))
          .map(({ pid }) => pid)
          .sort();
        const remaining = terminals.filter((_, index) => !ptyAdapter.processes[index]!.killed);
        if (remaining.length > 0) yield* exitSnapshotTestProcesses(manager, ptyAdapter, remaining);
        expect(finishedBeforeStaleRelease).toBe(true);
        expect(callsAfterOutput).toBe(callsBeforeOutput + 1);
        expect(killSignals).toEqual([[], []]);
        expect(remainingPids).toEqual([9000, 9001]);
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      (["output", "write"] as const).map((boundary) => ({ source, boundary })),
    ),
  )(
    "retains exec activity after $boundary invalidates a held $source poll",
    ({ source, boundary }) =>
      Effect.gen(function* () {
        const active = yield* Deferred.make<void>();
        const staleSnapshotStarted = yield* Deferred.make<void>();
        const releaseStaleSnapshot = yield* Deferred.make<void>();
        const freshSnapshotStarted = yield* Deferred.make<void>();
        const releaseFreshSnapshot = yield* Deferred.make<void>();
        const freshOwned = yield* Deferred.make<void>();
        const freshActivity = yield* Deferred.make<void>();
        const outputProcessed = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextSnapshot = false;
        let holdFreshSnapshot = false;
        let commandStarted = false;
        let ownedProcessIds: ReadonlyArray<number> = [];
        let awaitFreshOwnership = false;
        const ownershipUpdates: Array<ReadonlyArray<number>> = [];
        const terminal = openInput();
        const processTable = Effect.gen(function* () {
          const entries = ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: process.pid === 9000 && commandStarted ? "node" : "zsh",
          }));
          if (holdNextSnapshot) {
            holdNextSnapshot = false;
            yield* Deferred.succeed(staleSnapshotStarted, undefined);
            yield* Deferred.await(releaseStaleSnapshot);
          } else if (holdFreshSnapshot) {
            holdFreshSnapshot = false;
            yield* Deferred.succeed(freshSnapshotStarted, undefined);
            yield* Deferred.await(releaseFreshSnapshot);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          registerTerminalProcesses: ({ threadId, terminalId, processIds }) =>
            Effect.gen(function* () {
              if (threadId !== terminal.threadId || terminalId !== terminal.terminalId) return;
              ownedProcessIds = [...processIds];
              ownershipUpdates.push(ownedProcessIds);
              if (awaitFreshOwnership && processIds.includes(9000)) {
                yield* Deferred.succeed(freshOwned, undefined);
              }
            }),
        });
        yield* TestClock.adjust(0);
        const unsubscribe = yield* manager.subscribe((event) =>
          Effect.gen(function* () {
            if (event.type === "output") yield* Deferred.succeed(outputProcessed, undefined);
            if (event.type === "activity" && event.hasRunningSubprocess && event.label === "node") {
              yield* Deferred.succeed(active, undefined);
              if (awaitFreshOwnership) yield* Deferred.succeed(freshActivity, undefined);
            }
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        yield* manager.write({ ...terminal, data: "prepare\r" });
        commandStarted = true;
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(active);
        const initialOwned = [...ownedProcessIds];
        // A transient shell observation becomes obsolete when the same PID
        // starts its next command before the pending poll applies the table.
        commandStarted = false;
        holdNextSnapshot = true;
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(staleSnapshotStarted);
        commandStarted = true;
        if (boundary === "output") {
          process.emitData("command started\n");
          yield* Deferred.await(outputProcessed);
        } else {
          yield* manager.write({ ...terminal, data: "exec node\r" });
        }
        const metadataBeforeOldCompletion = yield* readIdleInspectionMetadata(manager);
        const updatesBeforeOldCompletion = ownershipUpdates.length;
        holdFreshSnapshot = true;
        yield* Deferred.succeed(releaseStaleSnapshot, undefined);
        yield* TestClock.adjust("60 seconds");
        // The single background worker cannot begin its next scan until the
        // old poll has finished applying ownership and activity.
        yield* Deferred.await(freshSnapshotStarted);
        const metadataAfterOldCompletion = yield* readIdleInspectionMetadata(manager);
        const ownershipAfterOldCompletion = [...ownedProcessIds];
        const updatesAfterOldCompletion = ownershipUpdates.slice(updatesBeforeOldCompletion);
        awaitFreshOwnership = true;
        yield* Deferred.succeed(releaseFreshSnapshot, undefined);
        yield* Deferred.await(freshOwned);
        if (
          !metadataAfterOldCompletion.some(
            (entry) => entry.pid === process.pid && entry.hasRunningSubprocess,
          )
        ) {
          yield* Deferred.await(freshActivity);
        }
        const freshMetadata = yield* readIdleInspectionMetadata(manager);
        const freshProcessIds = [...ownedProcessIds];
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(initialOwned).toEqual([process.pid]);
        expect({
          processIds: ownershipAfterOldCompletion,
          metadata: metadataAfterOldCompletion,
        }).toEqual({
          processIds: boundary === "output" ? [] : [process.pid],
          metadata: metadataBeforeOldCompletion,
        });
        expect(updatesAfterOldCompletion).toEqual(boundary === "output" ? [[]] : []);
        expect(freshProcessIds).toEqual([process.pid]);
        expect(freshMetadata).toContainEqual(
          expect.objectContaining({ pid: process.pid, hasRunningSubprocess: true, label: "node" }),
        );
        expect(process.killSignals).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      (["exec", "descendant"] as const).map((command) => ({ source, command })),
    ),
  )(
    "tracks an active $command and prunes exited or reused child PIDs through successive output-invalidated $source polls",
    ({ source, command }) =>
      Effect.gen(function* () {
        const scans = yield* Effect.forEach([0, 1, 2, 3, 4], () =>
          Effect.all({ started: Deferred.make<void>(), release: Deferred.make<void>() }),
        );
        const outputs = yield* Effect.forEach([0, 1, 2, 3], () => Deferred.make<void>());
        const ptyAdapter = new FakePtyAdapter();
        const terminal = openInput();
        const root = { pid: 9000, ppid: 1, name: command === "exec" ? "node" : "zsh" };
        const initial = [
          root,
          ...(command === "descendant" ? [{ pid: 9100, ppid: 9000, name: "node" }] : []),
        ];
        const expanded = [
          ...initial,
          {
            pid: command === "exec" ? 9100 : 9101,
            ppid: command === "exec" ? 9000 : 9100,
            name: "worker",
          },
        ];
        const smaller = initial.map((entry) => ({
          ...entry,
          name: entry.name === "node" ? "python" : entry.name,
        }));
        const reused = [
          ...initial,
          { pid: command === "exec" ? 9100 : 9101, ppid: 1, name: "unrelated" },
          { pid: 9200, ppid: command === "exec" ? 9000 : 9100, name: "worker" },
        ];
        let observed = [{ pid: 9000, ppid: 1, name: "zsh" }];
        let heldScan = 0;
        let holdPolling = false;
        let ownedProcessIds: ReadonlyArray<number> = [];
        const ownershipUpdates: Array<ReadonlyArray<number>> = [];
        const processTable = Effect.gen(function* () {
          const entries = observed.map((entry) => ({ ...entry }));
          if (holdPolling) {
            const scan = scans[heldScan++];
            if (scan !== undefined) {
              yield* Deferred.succeed(scan.started, undefined);
              yield* Deferred.await(scan.release);
            }
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          registerTerminalProcesses: ({ processIds }) =>
            Effect.sync(() => {
              ownedProcessIds = [...processIds].sort((left, right) => left - right);
              ownershipUpdates.push(ownedProcessIds);
            }),
        });
        yield* TestClock.adjust(0);
        const unsubscribe = yield* manager.subscribe((event) => {
          const output =
            event.type === "output"
              ? outputs.find((_, index) => event.data === `scan ${index}\n`)
              : undefined;
          return output !== undefined
            ? Deferred.succeed(output, undefined).pipe(Effect.asVoid)
            : Effect.void;
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        yield* manager.write({ ...terminal, data: "prepare\r" });
        holdPolling = true;
        observed = initial;
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(scans[0]!.started);
        process.emitData("scan 0\n");
        yield* Deferred.await(outputs[0]!);
        yield* Deferred.succeed(scans[0]!.release, undefined);
        observed = expanded;
        yield* TestClock.adjust("60 seconds");
        // The next held scan proves the previous background poll has applied
        // its result. Output must not hide a positive process observation.
        yield* Deferred.await(scans[1]!.started);
        const firstOwned = [...ownedProcessIds];
        const firstMetadata = yield* readIdleInspectionMetadata(manager);
        process.emitData("scan 1\n");
        yield* Deferred.await(outputs[1]!);
        yield* Deferred.succeed(scans[1]!.release, undefined);
        observed = smaller;
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(scans[2]!.started);
        const expandedOwned = [...ownedProcessIds];
        const expandedMetadata = yield* readIdleInspectionMetadata(manager);
        process.emitData("scan 2\n");
        yield* Deferred.await(outputs[2]!);
        const metadataBeforeSmallerCompletion = yield* readIdleInspectionMetadata(manager);
        const updatesBeforeSmallerCompletion = ownershipUpdates.length;
        yield* Deferred.succeed(scans[2]!.release, undefined);
        observed = reused;
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(scans[3]!.started);
        const ownershipAfterSmallerCompletion = [...ownedProcessIds];
        const metadataAfterSmallerCompletion = yield* readIdleInspectionMetadata(manager);
        const updatesAfterSmallerCompletion = ownershipUpdates.slice(
          updatesBeforeSmallerCompletion,
        );
        // A formerly owned PID can now belong to an unrelated process. The
        // next output-invalidated table must exclude it and include new work.
        process.emitData("scan 3\n");
        yield* Deferred.await(outputs[3]!);
        const metadataBeforeReusedCompletion = yield* readIdleInspectionMetadata(manager);
        yield* Deferred.succeed(scans[3]!.release, undefined);
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(scans[4]!.started);
        const ownershipAfterReusedCompletion = [...ownedProcessIds];
        const metadataAfterReusedCompletion = yield* readIdleInspectionMetadata(manager);
        yield* Deferred.succeed(scans[4]!.release, undefined);
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);

        const expectedInitial = initial.map(({ pid }) => pid).sort((left, right) => left - right);
        const expectedExpanded = expanded.map(({ pid }) => pid).sort((left, right) => left - right);
        expect(firstOwned).toEqual(expectedInitial);
        expect(firstMetadata).toContainEqual(
          expect.objectContaining({ pid: process.pid, hasRunningSubprocess: true, label: "node" }),
        );
        expect(expandedOwned).toEqual(expectedExpanded);
        expect(expandedMetadata).toContainEqual(
          expect.objectContaining({ pid: process.pid, hasRunningSubprocess: true, label: "node" }),
        );
        expect({
          processIds: ownershipAfterSmallerCompletion,
          metadata: metadataAfterSmallerCompletion,
        }).toEqual({ processIds: expectedInitial, metadata: metadataBeforeSmallerCompletion });
        expect(updatesAfterSmallerCompletion).toEqual([expectedInitial]);
        expect({
          processIds: ownershipAfterReusedCompletion,
          metadata: metadataAfterReusedCompletion,
        }).toEqual({
          processIds: [...expectedInitial, 9200],
          metadata: metadataBeforeReusedCompletion,
        });
        expect(process.killSignals).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback"] as const)(
    "keeps a quiet terminal's exec ownership and activity when another terminal invalidates a held %s poll",
    (source) =>
      Effect.gen(function* () {
        const snapshotStarted = yield* Deferred.make<void>();
        const releaseSnapshot = yield* Deferred.make<void>();
        const nextSnapshotStarted = yield* Deferred.make<void>();
        const releaseNextSnapshot = yield* Deferred.make<void>();
        const outputProcessed = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextSnapshot = false;
        let holdCompletionWitness = false;
        let commandStarted = false;
        let quietOwnedProcessIds: ReadonlyArray<number> = [];
        const quiet = openInput({ terminalId: "quiet" });
        const noisy = openInput({ terminalId: "noisy" });
        const processTable = Effect.gen(function* () {
          const entries = ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: process.pid === 9000 && commandStarted ? "node" : "zsh",
          }));
          if (holdNextSnapshot) {
            holdNextSnapshot = false;
            yield* Deferred.succeed(snapshotStarted, undefined);
            yield* Deferred.await(releaseSnapshot);
          } else if (holdCompletionWitness) {
            holdCompletionWitness = false;
            yield* Deferred.succeed(nextSnapshotStarted, undefined);
            yield* Deferred.await(releaseNextSnapshot);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          registerTerminalProcesses: ({ terminalId, processIds }) =>
            Effect.sync(() => {
              if (terminalId === quiet.terminalId) quietOwnedProcessIds = [...processIds];
            }),
        });
        yield* TestClock.adjust(0);
        yield* manager.open(quiet);
        yield* manager.open(noisy);
        yield* manager.write({ ...quiet, data: "exec node\r" });
        commandStarted = true;
        holdNextSnapshot = true;
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(snapshotStarted);
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "output" && event.terminalId === noisy.terminalId
            ? Deferred.succeed(outputProcessed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        ptyAdapter.processes[1]!.emitData("background output\n");
        yield* Deferred.await(outputProcessed);
        holdCompletionWitness = true;
        yield* Deferred.succeed(releaseSnapshot, undefined);
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(nextSnapshotStarted);
        // The next scan stays held, proving these values came from the old
        // poll's still-valid observation of the quiet terminal.
        const metadata = yield* readIdleInspectionMetadata(manager);
        const processIds = [...quietOwnedProcessIds];
        yield* Deferred.succeed(releaseNextSnapshot, undefined);
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [quiet, noisy]);
        expect(processIds).toEqual([ptyAdapter.processes[0]!.pid]);
        expect(metadata).toContainEqual(
          expect.objectContaining({
            terminalId: quiet.terminalId,
            pid: ptyAdapter.processes[0]!.pid,
            status: "running",
            hasRunningSubprocess: true,
            label: "node",
          }),
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      (["quiet exec", "idle shell"] as const).map((state) => ({ source, state })),
    ),
  )(
    "takes independent fresh $source cleanup snapshots after an older idle poll before $state",
    ({ source, state }) =>
      Effect.gen(function* () {
        const oldPollStarted = yield* Deferred.make<void>();
        const releaseOldPoll = yield* Deferred.make<void>();
        const freshScanStarted = yield* Deferred.make<void>();
        const releaseFreshScans = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let nextScan: "startup" | "old poll" | "cleanup" = "startup";
        let commandStarted = false;
        let snapshotCalls = 0;
        const freshNames: string[] = [];
        const processTable = Effect.gen(function* () {
          snapshotCalls += 1;
          // Freeze this scan's table before the quiet command begins.
          const name = commandStarted ? "sleep" : "zsh";
          const entries = [{ pid: 9000, ppid: 1, name }];
          if (nextScan === "old poll") {
            nextScan = "cleanup";
            yield* Deferred.succeed(oldPollStarted, undefined);
            yield* Deferred.await(releaseOldPoll);
          } else if (nextScan === "cleanup") {
            freshNames.push(name);
            yield* Deferred.succeed(freshScanStarted, undefined);
            yield* Deferred.await(releaseFreshScans);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        yield* manager.write({ ...terminal, data: "exec sleep 60\r" });
        nextScan = "old poll";
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(oldPollStarted);
        const callsBeforeCleanup = snapshotCalls;
        // No further input or PTY output invalidates the idle table. Cleanup
        // must inspect after its own candidates were collected nevertheless.
        commandStarted = state === "quiet exec";
        const callers = yield* Effect.forEach([1, 2, 3], () =>
          manager.closeIdle(terminal).pipe(Effect.forkScoped({ startImmediately: true })),
        );
        yield* TestClock.adjust(0);
        const freshStarted = yield* Deferred.isDone(freshScanStarted);
        const freshCalls = snapshotCalls - callsBeforeCleanup;
        const callersPending = callers.every((caller) => caller.pollUnsafe() === undefined);
        // Open both gates even if the published implementation reused the
        // older poll, so the negative run ends with observable assertions.
        yield* Deferred.succeed(releaseFreshScans, undefined);
        yield* Deferred.succeed(releaseOldPoll, undefined);
        yield* Effect.forEach(callers, Fiber.join);
        yield* TestClock.adjust("1 millis");
        const metadata = yield* readIdleInspectionMetadata(manager);
        const killSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(process.writes).toEqual(["exec sleep 60\r"]);
        if (commandStarted) {
          expect(killSignals).toEqual([]);
          expect(metadata).toEqual([
            expect.objectContaining({ pid: process.pid, status: "running" }),
          ]);
        } else {
          expect(killSignals).toContain("SIGTERM");
          expect(metadata).toEqual([]);
        }
        expect(freshStarted).toBe(true);
        expect(freshCalls).toBe(3);
        expect(freshNames).toEqual(
          Array.from({ length: 3 }, () => (commandStarted ? "sleep" : "zsh")),
        );
        expect(callersPending).toBe(true);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback"] as const)(
    "gives overlapping cleanup callers independent fresh %s snapshots after drained output invalidates a held poll",
    (source) =>
      Effect.gen(function* () {
        const staleSnapshotStarted = yield* Deferred.make<void>();
        const releaseStaleSnapshot = yield* Deferred.make<void>();
        const freshSnapshotStarted = yield* Deferred.make<void>();
        const releaseFreshSnapshot = yield* Deferred.make<void>();
        const outputProcessed = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let holdNextStaleSnapshot = false;
        let holdNextFreshSnapshot = false;
        let commandStarted = false;
        let snapshotCalls = 0;
        const processTable = Effect.gen(function* () {
          snapshotCalls += 1;
          const entries = [{ pid: 9000, ppid: 1, name: commandStarted ? "node" : "zsh" }];
          if (holdNextStaleSnapshot) {
            holdNextStaleSnapshot = false;
            yield* Deferred.succeed(staleSnapshotStarted, undefined);
            yield* Deferred.await(releaseStaleSnapshot);
          } else if (holdNextFreshSnapshot) {
            yield* Deferred.succeed(freshSnapshotStarted, undefined);
            yield* Deferred.await(releaseFreshSnapshot);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        yield* manager.write({ ...terminal, data: "exec node\r" });
        holdNextStaleSnapshot = true;
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(staleSnapshotStarted);
        const callsBeforeOutput = snapshotCalls;
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "output"
            ? Deferred.succeed(outputProcessed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        commandStarted = true;
        process.emitData("command started\n");
        yield* Deferred.await(outputProcessed);
        holdNextFreshSnapshot = true;
        const callers = yield* Effect.forEach([1, 2, 3], () =>
          manager.closeIdle(terminal).pipe(Effect.forkScoped({ startImmediately: true })),
        );
        yield* TestClock.adjust("100 millis");
        const freshStarted = yield* Deferred.isDone(freshSnapshotStarted);
        const callsWhileBothSnapshotsPending = snapshotCalls;
        const callersStillPending = callers.every((caller) => caller.pollUnsafe() === undefined);
        // Release both sources even when old code never starts a fresh scan,
        // so negative controls reach assertions instead of hanging on a gate.
        yield* Deferred.succeed(releaseFreshSnapshot, undefined);
        yield* Deferred.succeed(releaseStaleSnapshot, undefined);
        yield* Effect.forEach(callers, Fiber.join);
        const killSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(freshStarted).toBe(true);
        expect(callsWhileBothSnapshotsPending).toBe(callsBeforeOutput + 3);
        expect(snapshotCalls).toBe(callsBeforeOutput + 3);
        expect(callersStillPending).toBe(true);
        expect(killSignals).toEqual([]);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback"] as const)(
    "revalidates a queued %s shell snapshot when the first writer acquires its thread lock",
    (source) =>
      Effect.gen(function* () {
        const holderEntered = yield* Deferred.make<void>();
        const releaseHolder = yield* Deferred.make<void>();
        const prefetchStarted = yield* Deferred.make<void>();
        const execPollCompleted = yield* Deferred.make<void>();
        const releaseExecWitness = yield* Deferred.make<void>();
        let execPollCalls = 0;
        let witnessExecPoll = false;
        let ownedProcessIds: ReadonlyArray<number> = [];
        const ptyAdapter = new FakePtyAdapter();
        let rootName = "bash";
        let snapshotCalls = 0;
        const sampledNames: string[] = [];
        const processTable = Effect.gen(function* () {
          if (witnessExecPoll && ++execPollCalls === 2) {
            yield* Deferred.succeed(execPollCompleted, undefined);
            yield* Deferred.await(releaseExecWitness);
          }
          snapshotCalls += 1;
          sampledNames.push(rootName);
          if (snapshotCalls === 1) yield* Deferred.succeed(prefetchStarted, undefined);
          return ptyAdapter.processes.map(({ pid }) => ({ pid, ppid: 1, name: rootName }));
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          shellResolver: () => "/opt/tools/bash",
          registerTerminalProcesses: ({ threadId, terminalId, processIds }) =>
            Effect.sync(() => {
              if (threadId === "thread-1" && terminalId === DEFAULT_TERMINAL_ID)
                ownedProcessIds = [...processIds];
            }),
        });
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        const holderTerminal = openInput({ terminalId: "holder" });
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "started" && event.snapshot.terminalId === "holder"
            ? Deferred.succeed(holderEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseHolder)),
              )
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const opening = yield* manager.open(holderTerminal).pipe(Effect.forkScoped);
        yield* Deferred.await(holderEntered);
        const writing = yield* manager
          .write({ ...terminal, data: "noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(prefetchStarted);
        yield* TestClock.adjust(0);
        const writesWhileQueued = [...process.writes];
        const samplesBeforeRelease = [...sampledNames];
        rootName = "zsh";
        yield* Deferred.succeed(releaseHolder, undefined);
        yield* Fiber.join(opening);
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        const samplesAtForwarding = [...sampledNames];
        // Once input has been forwarded, an exec is activity rather than a
        // replacement baseline. Returning to the settled shell is idle.
        rootName = "node";
        witnessExecPoll = true;
        yield* TestClock.adjust("3 minutes");
        yield* Deferred.await(execPollCompleted);
        yield* Deferred.succeed(releaseExecWitness, undefined);
        yield* manager.closeIdle(terminal);
        const metadataDuringExec = yield* readIdleInspectionMetadata(manager);
        const signalsDuringExec = [...process.killSignals];
        const ownershipDuringExec = [...ownedProcessIds];
        rootName = "zsh";
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const remainingMetadata = yield* readIdleInspectionMetadata(manager);
        const signalsAfterIdle = [...process.killSignals];
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [
          holderTerminal,
          ...(!process.killed ? [terminal] : []),
        ]);
        expect(signalsAfterIdle).toContain("SIGTERM");
        expect(samplesBeforeRelease).toEqual(["bash"]);
        expect(writesWhileQueued).toEqual([]);
        expect(process.writes).toEqual(["noop\r"]);
        expect(samplesAtForwarding.slice(-2)).toEqual(["zsh", "zsh"]);
        expect(signalsDuringExec).toEqual([]);
        expect(ownershipDuringExec).toEqual([process.pid]);
        expect(metadataDuringExec).toContainEqual(
          expect.objectContaining({ pid: process.pid, hasRunningSubprocess: true, label: "node" }),
        );
        expect(remainingMetadata.some(({ pid }) => pid === process.pid)).toBe(false);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback"] as const)(
    "keeps overlapping %s shell scans shared while an unrelated terminal drains output",
    (source) =>
      Effect.gen(function* () {
        const initialStarted = yield* Deferred.make<void>();
        const releaseInitial = yield* Deferred.make<void>();
        const confirmationStarted = yield* Deferred.make<void>();
        const releaseConfirmation = yield* Deferred.make<void>();
        const initialOutputProcessed = yield* Deferred.make<void>();
        const confirmationOutputProcessed = yield* Deferred.make<void>();
        const outputPollCompleted = yield* Deferred.make<void>();
        const releaseOutputWitness = yield* Deferred.make<void>();
        let outputPollCalls = 0;
        let witnessOutputPoll = false;
        let noisyOwnership: ReadonlyArray<number> = [];
        const ptyAdapter = new FakePtyAdapter();
        let snapshotCalls = 0;
        let releasedConfirmation = false;
        const processTable = Effect.gen(function* () {
          if (witnessOutputPoll && ++outputPollCalls === 2) {
            yield* Deferred.succeed(outputPollCompleted, undefined);
            yield* Deferred.await(releaseOutputWitness);
          }
          snapshotCalls += 1;
          const entries = [
            ...ptyAdapter.processes.map(({ pid }) => ({ pid, ppid: 1, name: "zsh" })),
            { pid: 100, ppid: ptyAdapter.processes[3]!.pid, name: "node" },
          ];
          if (snapshotCalls === 1) {
            yield* Deferred.succeed(initialStarted, undefined);
            yield* Deferred.await(releaseInitial);
          } else if (!releasedConfirmation) {
            yield* Deferred.succeed(confirmationStarted, undefined);
            yield* Deferred.await(releaseConfirmation);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          registerTerminalProcesses: ({ threadId, processIds }) =>
            Effect.sync(() => {
              if (threadId === "thread-output") noisyOwnership = [...processIds];
            }),
        });
        yield* TestClock.adjust(0);
        const terminals = [1, 2, 3].map((index) => openInput({ threadId: `thread-${index}` }));
        const noisyTerminal = openInput({ threadId: "thread-output" });
        yield* Effect.forEach([...terminals, noisyTerminal], (terminal) => manager.open(terminal));
        const noisyProcess = ptyAdapter.processes[3]!;
        const unsubscribe = yield* manager.subscribe((event) => {
          if (event.type !== "output" || event.threadId !== noisyTerminal.threadId)
            return Effect.void;
          return Deferred.succeed(
            event.data === "initial output\n"
              ? initialOutputProcessed
              : confirmationOutputProcessed,
            undefined,
          ).pipe(Effect.asVoid);
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const write = (terminal: TerminalOpenInput) =>
          manager
            .write({ ...terminal, data: "noop\r" })
            .pipe(Effect.forkScoped({ startImmediately: true }));
        const first = yield* write(terminals[0]!);
        yield* Deferred.await(initialStarted);
        noisyProcess.emitData("initial output\n");
        yield* Deferred.await(initialOutputProcessed);
        const second = yield* write(terminals[1]!);
        yield* TestClock.adjust(0);
        const callsDuringInitial = snapshotCalls;
        const writesDuringInitial = ptyAdapter.processes.map(({ writes }) => [...writes]);
        yield* Deferred.succeed(releaseInitial, undefined);
        yield* Deferred.await(confirmationStarted);
        noisyProcess.emitData("confirmation output\n");
        yield* Deferred.await(confirmationOutputProcessed);
        const third = yield* write(terminals[2]!);
        yield* TestClock.adjust("10 millis");
        const callsDuringConfirmation = snapshotCalls;
        const writesDuringConfirmation = ptyAdapter.processes.map(({ writes }) => [...writes]);
        releasedConfirmation = true;
        yield* Deferred.succeed(releaseConfirmation, undefined);
        yield* TestClock.adjust("100 millis");
        yield* Effect.forEach([first, second, third], Fiber.join);
        const writesAfterConfirmation = ptyAdapter.processes.map(({ writes }) => [...writes]);
        // The output-producing command still owns its active descendant,
        // while its output does not evict scans other terminals can share.
        witnessOutputPoll = true;
        yield* TestClock.adjust("3 minutes");
        yield* Deferred.await(outputPollCompleted);
        yield* Deferred.succeed(releaseOutputWitness, undefined);
        yield* manager.closeIdle(noisyTerminal);
        const noisySignals = [...noisyProcess.killSignals];
        const outputMetadata = yield* readIdleInspectionMetadata(manager);
        const outputOwnership = [...noisyOwnership];
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [...terminals, noisyTerminal]);
        expect(callsDuringInitial).toBe(1);
        expect(writesDuringInitial).toEqual([[], [], [], []]);
        expect(callsDuringConfirmation).toBe(2);
        expect(writesDuringConfirmation).toEqual([[], [], [], []]);
        expect(writesAfterConfirmation).toEqual([["noop\r"], ["noop\r"], ["noop\r"], []]);
        expect(outputMetadata).toContainEqual(
          expect.objectContaining({ pid: noisyProcess.pid, hasRunningSubprocess: true }),
        );
        expect(noisySignals).toEqual([]);
        expect(outputOwnership).toEqual([noisyProcess.pid, 100]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      ([false, true] as const).map((confirmed) => ({ source, confirmed })),
    ),
  )(
    "requires consecutive pre-input $source shell observations before failed capture fallback when confirmed=$confirmed",
    ({ source, confirmed }) =>
      Effect.gen(function* () {
        const captureStarted = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        const recoveredPollCompleted = yield* Deferred.make<void>();
        const releaseRecoveredWitness = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let phase: "pre-input" | "capture" | "recovered" = "pre-input";
        let preInputCalls = 0;
        let recoveredCalls = 0;
        let rootName = "bash";
        let ownedProcessIds: ReadonlyArray<number> = [];
        const processTable = Effect.gen(function* () {
          const name = rootName;
          if (phase === "pre-input" && ++preInputCalls > (confirmed ? 2 : 1)) phase = "capture";
          if (phase === "capture") {
            yield* Deferred.succeed(captureStarted, undefined);
            yield* Deferred.await(releaseCapture);
          } else if (phase === "recovered" && ++recoveredCalls === 2) {
            yield* Deferred.succeed(recoveredPollCompleted, undefined);
            yield* Deferred.await(releaseRecoveredWitness);
          }
          return [{ pid: 9000, ppid: 1, name }];
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          registerTerminalProcesses: ({ processIds }) =>
            Effect.sync(() => {
              ownedProcessIds = [...processIds];
            }),
        });
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        yield* TestClock.adjust(confirmed ? "3 minutes" : "2 minutes");
        // This next held poll proves the preceding one or two observations
        // were applied before any first-input capture starts.
        yield* Deferred.await(captureStarted);
        const writing = yield* manager
          .write({ ...terminal, data: "noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        rootName = confirmed ? "node" : "bash";
        phase = "recovered";
        yield* Deferred.succeed(releaseCapture, undefined);
        yield* TestClock.adjust("3 minutes");
        yield* Deferred.await(recoveredPollCompleted);
        const metadataAfterExec = yield* readIdleInspectionMetadata(manager);
        const ownershipAfterExec = [...ownedProcessIds];
        yield* Deferred.succeed(releaseRecoveredWitness, undefined);
        yield* manager.closeIdle(terminal);
        const signalsAfterExec = [...process.killSignals];
        rootName = "bash";
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const finalMetadata = yield* readIdleInspectionMetadata(manager);
        const finalSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(process.writes).toEqual(["noop\r"]);
        expect(ownershipAfterExec).toEqual([process.pid]);
        expect(metadataAfterExec).toEqual([
          expect.objectContaining({
            pid: process.pid,
            hasRunningSubprocess: true,
            label: confirmed ? "node" : "bash",
          }),
        ]);
        expect(signalsAfterExec).toEqual([]);
        if (confirmed) {
          expect(finalSignals).toContain("SIGTERM");
          expect(finalMetadata).toEqual([]);
        } else {
          expect(finalSignals).toEqual([]);
          expect(finalMetadata).toEqual(metadataAfterExec);
        }
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["native", "fallback"] as const)(
    "restarts %s shell confirmation when this terminal outputs between accepted samples",
    (source) =>
      Effect.gen(function* () {
        const secondSampleStarted = yield* Deferred.make<void>();
        const releaseSecondSample = yield* Deferred.make<void>();
        const outputProcessed = yield* Deferred.make<void>();
        const execPollCompleted = yield* Deferred.make<void>();
        const releaseExecWitness = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let phase: "capture" | "exec" | "idle" = "capture";
        let captureCalls = 0;
        let execCalls = 0;
        let ownedProcessIds: ReadonlyArray<number> = [];
        const captureNames: string[] = [];
        const processTable = Effect.gen(function* () {
          let name: string;
          if (phase === "capture") {
            captureCalls += 1;
            // Prefetch is first. The next bash sample is accepted by capture,
            // and output makes its held confirmation and prior pair stale.
            name = captureCalls <= 4 ? "bash" : "zsh";
            captureNames.push(name);
            if (captureCalls === 3) {
              yield* Deferred.succeed(secondSampleStarted, undefined);
              yield* Deferred.await(releaseSecondSample);
            }
          } else {
            name = phase === "exec" ? "node" : "zsh";
            if (phase === "exec" && ++execCalls === 2) {
              yield* Deferred.succeed(execPollCompleted, undefined);
              yield* Deferred.await(releaseExecWitness);
            }
          }
          return [{ pid: 9000, ppid: 1, name }];
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          shellResolver: () => "/opt/tools/bash",
          registerTerminalProcesses: ({ processIds }) =>
            Effect.sync(() => {
              ownedProcessIds = [...processIds];
            }),
        });
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "output"
            ? Deferred.succeed(outputProcessed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const writing = yield* manager
          .write({ ...terminal, data: "noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(secondSampleStarted);
        const writesBeforeOutput = [...process.writes];
        process.emitData("wrapper startup\n");
        yield* Deferred.await(outputProcessed);
        yield* Deferred.succeed(releaseSecondSample, undefined);
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        const sampledAtForwarding = [...captureNames];
        phase = "exec";
        yield* TestClock.adjust("3 minutes");
        yield* Deferred.await(execPollCompleted);
        const metadataDuringExec = yield* readIdleInspectionMetadata(manager);
        const ownershipDuringExec = [...ownedProcessIds];
        yield* Deferred.succeed(releaseExecWitness, undefined);
        yield* manager.closeIdle(terminal);
        const signalsDuringExec = [...process.killSignals];
        phase = "idle";
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const metadataAfterIdle = yield* readIdleInspectionMetadata(manager);
        const signalsAfterIdle = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(signalsAfterIdle).toContain("SIGTERM");
        expect(writesBeforeOutput).toEqual([]);
        expect(process.writes).toEqual(["noop\r"]);
        expect(sampledAtForwarding.slice(-2)).toEqual(["zsh", "zsh"]);
        expect(ownershipDuringExec).toEqual([process.pid]);
        expect(metadataDuringExec).toEqual([
          expect.objectContaining({ pid: process.pid, hasRunningSubprocess: true, label: "node" }),
        ]);
        expect(signalsDuringExec).toEqual([]);
        expect(metadataAfterIdle).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      (["threads", "terminals"] as const).map((grouping) => ({ source, grouping })),
    ),
  )(
    "shares a held fresh $source wrapper confirmation round across $grouping",
    ({ source, grouping }) =>
      Effect.gen(function* () {
        const initialStarted = yield* Deferred.make<void>();
        const releaseInitial = yield* Deferred.make<void>();
        const confirmationStarted = yield* Deferred.make<void>();
        const releaseConfirmation = yield* Deferred.make<void>();
        const laterStarted = yield* Deferred.make<void>();
        const releaseLater = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let snapshotCalls = 0;
        let holdLater = false;
        let confirmationReleased = false;
        let laterSnapshotPids: ReadonlyArray<number> = [];
        const processTable = Effect.gen(function* () {
          snapshotCalls += 1;
          const entries = ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: "zsh",
          }));
          if (snapshotCalls === 1) {
            yield* Deferred.succeed(initialStarted, undefined);
            yield* Deferred.await(releaseInitial);
          } else if (!confirmationReleased) {
            yield* Deferred.succeed(confirmationStarted, undefined);
            yield* Deferred.await(releaseConfirmation);
          } else if (holdLater) {
            holdLater = false;
            laterSnapshotPids = entries.map(({ pid }) => pid);
            yield* Deferred.succeed(laterStarted, undefined);
            yield* Deferred.await(releaseLater);
          }
          return entries;
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable);
        yield* TestClock.adjust(0);
        const terminals = [1, 2, 3].map((index) =>
          openInput({
            threadId: grouping === "threads" ? `thread-${index}` : "thread-1",
            terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : `terminal-${index}`,
          }),
        );
        yield* Effect.forEach(terminals, (terminal) => manager.open(terminal));
        for (const process of ptyAdapter.processes) process.exitOnKill = "SIGTERM";
        const writing = yield* Effect.forEach(
          terminals,
          (terminal) => manager.write({ ...terminal, data: "noop\r" }),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(initialStarted);
        yield* TestClock.adjust(0);
        const initialCalls = snapshotCalls;
        const writesDuringInitial = ptyAdapter.processes.map((process) => [...process.writes]);
        yield* Deferred.succeed(releaseInitial, undefined);
        yield* Deferred.await(confirmationStarted);
        yield* TestClock.adjust("10 millis");
        const callsDuringConfirmation = snapshotCalls;
        const writesDuringConfirmation = ptyAdapter.processes.map((process) => [...process.writes]);
        const firstWritersPending = writing.pollUnsafe() === undefined;
        confirmationReleased = true;
        yield* Deferred.succeed(releaseConfirmation, undefined);
        yield* Fiber.join(writing);
        const callsAfterFirstWrites = snapshotCalls;
        const laterTerminal = openInput({
          threadId: grouping === "threads" ? "thread-4" : "thread-1",
          terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : "terminal-4",
        });
        yield* manager.open(laterTerminal);
        const laterProcess = ptyAdapter.processes[3]!;
        laterProcess.exitOnKill = "SIGTERM";
        holdLater = true;
        const laterWriting = yield* manager
          .write({ ...laterTerminal, data: "later noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(laterStarted);
        const callsDuringLaterSample = snapshotCalls;
        const laterWritesBeforeSample = [...laterProcess.writes];
        yield* Deferred.succeed(releaseLater, undefined);
        yield* Fiber.join(laterWriting);
        const callsAfterLaterWrite = snapshotCalls;
        const writesAfterConfirmation = ptyAdapter.processes.map((process) => [...process.writes]);
        yield* Effect.forEach([...terminals, laterTerminal], (terminal) =>
          manager.closeIdle(terminal),
        );
        yield* TestClock.adjust("1 millis");
        const metadataAfterCleanup = yield* readIdleInspectionMetadata(manager);
        const killSignals = ptyAdapter.processes.map((process) => [...process.killSignals]);
        const remaining = [...terminals, laterTerminal].filter(
          (_, index) => !ptyAdapter.processes[index]!.killed,
        );
        if (remaining.length > 0) yield* exitSnapshotTestProcesses(manager, ptyAdapter, remaining);
        expect(initialCalls).toBe(1);
        expect(writesDuringInitial).toEqual([[], [], []]);
        expect(callsDuringConfirmation).toBe(2);
        expect(writesDuringConfirmation).toEqual([[], [], []]);
        expect(firstWritersPending).toBe(true);
        expect(callsAfterFirstWrites).toBe(grouping === "threads" ? 2 : 6);
        expect(callsDuringLaterSample).toBe(grouping === "threads" ? 3 : 7);
        expect(laterWritesBeforeSample).toEqual([]);
        expect(laterSnapshotPids).toContain(laterProcess.pid);
        expect(callsAfterLaterWrite).toBe(grouping === "threads" ? 4 : 8);
        expect(writesAfterConfirmation).toEqual([
          ["noop\r"],
          ["noop\r"],
          ["noop\r"],
          ["later noop\r"],
        ]);
        expect(metadataAfterCleanup).toEqual([]);
        for (const signals of killSignals) expect(signals).toContain("SIGTERM");
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    { source: "native", grouping: "threads" },
    { source: "fallback", grouping: "threads" },
    { source: "native", grouping: "terminals" },
    { source: "fallback", grouping: "terminals" },
  ] as const)(
    "shares overlapping first-input $source snapshots across $grouping and refreshes later shells",
    ({ source, grouping }) =>
      Effect.gen(function* () {
        const requestStarted = yield* Deferred.make<void>();
        const releaseRequest = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let snapshotCalls = 0;
        const processTable = Effect.gen(function* () {
          snapshotCalls += 1;
          const entries = ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: "zsh",
          }));
          yield* Deferred.succeed(requestStarted, undefined);
          yield* Deferred.await(releaseRequest);
          return entries;
        });
        const processRunner: ProcessRunner.ProcessRunner["Service"] = {
          run: (input) =>
            processTable.pipe(
              Effect.map((entries) => {
                expect(input.args).toEqual(["-eo", "pid=,ppid=,comm="]);
                return {
                  stdout: entries.map(({ pid, ppid, name }) => `${pid} ${ppid} ${name}`).join("\n"),
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
            ),
        };
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          shellResolver: () => "/opt/tools/my-shell",
          subprocessPollIntervalMs: 60_000,
          ...(source === "native" ? { processTable } : {}),
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
          Effect.provide(layerWithHostPlatform("linux")),
        );
        // Let the empty-session poll park before opening any terminals.
        yield* TestClock.adjust(0);
        const terminals = [1, 2, 3].map((index) => ({
          threadId: grouping === "threads" ? `thread-${index}` : "thread-1",
          terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : `terminal-${index}`,
        }));
        yield* Effect.forEach(terminals, (terminal) => manager.open(openInput(terminal)));
        const write = (terminal: (typeof terminals)[number]) =>
          manager.write({ ...terminal, data: "command\r" });
        const writing = yield* Effect.forEach(terminals, write, {
          concurrency: "unbounded",
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(requestStarted);
        yield* TestClock.adjust(0);
        expect(snapshotCalls).toBe(1);
        expect(ptyAdapter.processes.map((process) => process.writes)).toEqual([[], [], []]);
        yield* Deferred.succeed(releaseRequest, undefined);
        yield* Fiber.join(writing);
        expect(ptyAdapter.processes.map((process) => process.writes)).toEqual([
          ["command\r"],
          ["command\r"],
          ["command\r"],
        ]);

        const laterTerminal = {
          threadId: grouping === "threads" ? "thread-4" : "thread-1",
          terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : "terminal-4",
        };
        yield* manager.open(openInput(laterTerminal));
        yield* write(laterTerminal);
        const callsAfterLaterTerminal = snapshotCalls;
        ptyAdapter.processes[0]!.exitOnKill = "SIGTERM";
        yield* manager.restart(restartInput(terminals[0]!));
        yield* write(terminals[0]!);
        const callsAfterRestart = snapshotCalls;
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [...terminals, laterTerminal]);
        expect(callsAfterLaterTerminal).toBe(grouping === "threads" ? 7 : 9);
        expect(callsAfterRestart).toBe(grouping === "threads" ? 10 : 12);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    { source: "native", outcome: "cancel", grouping: "threads" },
    { source: "native", outcome: "timeout", grouping: "threads" },
    { source: "fallback", outcome: "cancel", grouping: "threads" },
    { source: "fallback", outcome: "timeout", grouping: "threads" },
    { source: "native", outcome: "cancel", grouping: "terminals" },
    { source: "native", outcome: "timeout", grouping: "terminals" },
    { source: "fallback", outcome: "cancel", grouping: "terminals" },
    { source: "fallback", outcome: "timeout", grouping: "terminals" },
  ] as const)(
    "abandons a shared $source snapshot across $grouping after its last waiter leaves via $outcome",
    ({ source, outcome, grouping }) =>
      Effect.gen(function* () {
        const requestStarted = yield* Deferred.make<void>();
        const releaseRequest = yield* Deferred.make<void>();
        const requestStopped = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let snapshotCalls = 0;
        let activeRequests = 0;
        const processTable = Effect.gen(function* () {
          snapshotCalls += 1;
          activeRequests += 1;
          if (snapshotCalls === 1) {
            yield* Deferred.succeed(requestStarted, undefined);
            yield* Deferred.await(releaseRequest);
          }
          return ptyAdapter.processes.map((process) => ({
            pid: process.pid,
            ppid: 1,
            name: "zsh",
          }));
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              activeRequests -= 1;
            }).pipe(Effect.andThen(Deferred.succeed(requestStopped, undefined))),
          ),
        );
        const processRunner: ProcessRunner.ProcessRunner["Service"] = {
          run: () =>
            processTable.pipe(
              Effect.map((entries) => ({
                stdout: entries.map(({ pid, ppid, name }) => `${pid} ${ppid} ${name}`).join("\n"),
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              })),
            ),
        };
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          ...(source === "native" ? { processTable } : {}),
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
          Effect.provide(layerWithHostPlatform("linux")),
        );
        yield* TestClock.adjust(0);
        const terminals = [1, 2].map((index) => ({
          threadId: grouping === "threads" ? `thread-${index}` : "thread-1",
          terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : `terminal-${index}`,
        }));
        yield* Effect.forEach(terminals, (terminal) => manager.open(openInput(terminal)));
        const write = (terminal: (typeof terminals)[number]) =>
          manager.write({ ...terminal, data: "command\r" });
        const writers = yield* Effect.forEach(terminals, (terminal) =>
          write(terminal).pipe(Effect.forkScoped),
        );
        yield* Deferred.await(requestStarted);
        yield* TestClock.adjust(0);
        expect(snapshotCalls).toBe(1);
        if (outcome === "cancel") {
          yield* Fiber.interrupt(writers[0]!);
          expect(activeRequests).toBe(1);
          yield* Fiber.interrupt(writers[1]!);
        } else {
          yield* TestClock.adjust("100 millis");
          if (grouping === "terminals") {
            yield* Fiber.join(writers[0]!);
            yield* TestClock.adjust("100 millis");
          }
          yield* Effect.forEach(writers, Fiber.join);
        }
        yield* Deferred.await(requestStopped);
        expect(snapshotCalls).toBe(outcome === "timeout" && grouping === "terminals" ? 3 : 1);
        expect(activeRequests).toBe(0);
        expect(ptyAdapter.processes.map((process) => process.writes)).toEqual(
          outcome === "cancel" ? [[], []] : [["command\r"], ["command\r"]],
        );
        // Releasing an abandoned source cannot publish a reusable result.
        yield* Deferred.succeed(releaseRequest, undefined);
        const nextTerminal =
          outcome === "cancel"
            ? terminals[0]!
            : {
                threadId: grouping === "threads" ? "thread-3" : "thread-1",
                terminalId: grouping === "threads" ? DEFAULT_TERMINAL_ID : "terminal-3",
              };
        if (outcome === "timeout") yield* manager.open(openInput(nextTerminal));
        yield* write(nextTerminal);
        const callsAfterNewWrite = snapshotCalls;
        const activeRequestsAfterNewWrite = activeRequests;
        yield* exitSnapshotTestProcesses(
          manager,
          ptyAdapter,
          outcome === "timeout" ? [...terminals, nextTerminal] : terminals,
        );
        expect(callsAfterNewWrite).toBe(outcome === "timeout" && grouping === "terminals" ? 6 : 4);
        expect(activeRequestsAfterNewWrite).toBe(0);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps last known subprocess state when the process snapshot fails", () =>
    Effect.gen(function* () {
      let failSnapshots = false;
      let failedCalls = 0;
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Effect.sync(() => {
            if (failSnapshots) failedCalls += 1;
            return {
              stdout: failSnapshots ? "" : "  100  9000 vim",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(failSnapshots ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
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

      failSnapshots = true;
      yield* waitFor(
        Effect.sync(() => failedCalls >= 3),
        "1200 millis",
      );

      // A failed snapshot is not authoritative: no terminal flips to idle.
      const activityEvents = (yield* getEvents).filter((event) => event.type === "activity");
      expect(activityEvents.length).toBeGreaterThan(0);
      expect(activityEvents.every((event) => event.hasRunningSubprocess === true)).toBe(true);
    }),
  );

  it("calculates snapshot failure backoff and success reset delays", () => {
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 0), 1_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 1), 2_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 2), 4_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 30), 60_000);
  });

  it.effect("uses process snapshots from the resource monitor", () =>
    Effect.gen(function* () {
      let snapshotCalls = 0;
      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.sync(() => {
          snapshotCalls += 1;
          return [{ pid: 100, ppid: 9000, name: "ping.exe" }];
        }),
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" && event.hasRunningSubprocess && event.label === "ping",
          ),
        ),
        "1200 millis",
      );
      expect(snapshotCalls).toBeGreaterThan(0);
    }),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      (["-zsh", "zsh"] as const).map((childName) => ({ source, childName })),
    ),
  )(
    "keeps the real $source child basename $childName distinct from its login-shell root",
    ({ source, childName }) =>
      Effect.gen(function* () {
        const captureStarted = yield* Deferred.make<void>();
        const ownershipRegistered = yield* Deferred.make<ReadonlyArray<number>>();
        const ptyAdapter = new FakePtyAdapter();
        const processTable = Effect.gen(function* () {
          yield* Deferred.succeed(captureStarted, undefined);
          return [
            { pid: 9000, ppid: 1, name: "-zsh" },
            { pid: 100, ppid: 9000, name: childName },
          ];
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          shellResolver: () => "/bin/zsh",
          registerTerminalProcesses: ({ processIds }) =>
            Deferred.succeed(ownershipRegistered, processIds).pipe(Effect.asVoid),
        });
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        const writing = yield* manager
          .write({ ...terminal, data: "run child\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(captureStarted);
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        yield* TestClock.adjust("60 seconds");
        const processIds = yield* Deferred.await(ownershipRegistered);
        const metadata = yield* readIdleInspectionMetadata(manager);
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const metadataAfterCleanup = yield* readIdleInspectionMetadata(manager);
        const killSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        const active = childName === "-zsh";
        expect(process.writes).toEqual(["run child\r"]);
        expect(processIds).toEqual(active ? [9000, 100] : []);
        expect(metadata).toEqual([
          expect.objectContaining({
            pid: process.pid,
            status: "running",
            hasRunningSubprocess: active,
            ...(active ? { label: "-zsh" } : {}),
          }),
        ]);
        expect(metadataAfterCleanup).toEqual(active ? metadata : []);
        if (active) expect(killSignals).toEqual([]);
        else expect(killSignals).toContain("SIGTERM");
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("closes only a thread's idle shells, ignoring a helper forked from the shell", () =>
    Effect.gen(function* () {
      // FakePtyAdapter assigns pids from 9000 in open order.
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "zsh" },
          // An async prompt worker: a copy of the shell with no children.
          { pid: 100, ppid: 9000, name: "zsh" },
          { pid: 9001, ppid: 1, name: "zsh" },
          { pid: 200, ppid: 9001, name: "node" },
          { pid: 9002, ppid: 1, name: "zsh" },
          // A subshell with a child is real work.
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

  it.effect.each(["darwin", "linux"] as const)(
    "keeps a childless exec command while closing idle shells on %s",
    (platform) =>
      Effect.gen(function* () {
        let commandsStarted = false;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.sync(() =>
            [
              { pid: 9000, ppid: 1, name: "node" },
              { pid: 9001, ppid: 1, name: "/bin/zsh" },
              { pid: 9002, ppid: 1, name: "-zsh" },
              // A login shell's async prompt helper is still idle.
              { pid: 100, ppid: 9002, name: "zsh" },
              { pid: 9003, ppid: 1, name: "zsh" },
              { pid: 200, ppid: 9003, name: "node" },
              { pid: 9004, ppid: 1, name: "zsh" },
              { pid: 300, ppid: 9004, name: "zsh" },
              { pid: 301, ppid: 300, name: "sleep" },
              // A missing process name alone is not evidence of exec.
              { pid: 9005, ppid: 1, name: "" },
            ].map((entry) =>
              entry.ppid === 1 && !commandsStarted ? { ...entry, name: "zsh" } : entry,
            ),
          ),
        }).pipe(Effect.provide(layerWithHostPlatform(platform)));
        for (const terminalId of ["exec", "idle", "login", "child", "subshell", "unknown"]) {
          yield* manager.open(openInput({ terminalId }));
          yield* manager.write({ threadId: "thread-1", terminalId, data: "exec command\r" });
        }

        commandsStarted = true;
        yield* manager.closeIdle({ threadId: "thread-1" });

        expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
          false,
          true,
          true,
          false,
          false,
          true,
        ]);
      }),
  );

  it.effect("reports the command that replaced the shell through terminal activity", () =>
    Effect.gen(function* () {
      let commandsStarted = false;
      const activity = yield* Deferred.make<TerminalEvent>();
      const { manager } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        processTable: Effect.sync(() => [
          { pid: 9000, ppid: 1, name: commandsStarted ? "/usr/bin/node" : "zsh" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "activity"
          ? Deferred.succeed(activity, event).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "exec node\r",
      });
      commandsStarted = true;

      expect(yield* Deferred.await(activity)).toEqual(
        expect.objectContaining({ type: "activity", hasRunningSubprocess: true, label: "node" }),
      );
    }),
  );

  it.effect("uses the successful fallback shell identity when checking idle terminals", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "/missing/preferred-shell",
        env: { SHELL: "/bin/zsh" },
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.succeed([{ pid: 9000, ppid: 1, name: "zsh" }]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "/missing/preferred-shell",
        "/bin/zsh",
      ]);
      // zsh's spawn arguments must not be included in its captured identity.
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-o", "nopromptsp"]);

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
    }),
  );

  it.effect("recognizes an idle custom shell without a shell-name allowlist", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/opt/tools/custom-shell",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "custom-shell" },
          { pid: 100, ppid: 9000, name: "custom-shell" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
    }),
  );

  it.effect.each([
    { shellName: "custom-login-shell", commName: "custom-login-sh" },
    { shellName: "custom-é-shell-name", commName: "custom-é-shell" },
  ])(
    "closes full custom shells before input and protects ambiguous or changed roots after input for $shellName",
    ({ shellName, commName }) =>
      Effect.gen(function* () {
        let commandsStarted = false;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => `/opt/tools/${shellName}`,
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.sync(() =>
            [
              { pid: 9000, ppid: 1, name: `-${shellName}` },
              { pid: 100, ppid: 9000, name: shellName },
              { pid: 9001, ppid: 1, name: commName },
              { pid: 200, ppid: 9001, name: commName },
              { pid: 9002, ppid: 1, name: "node" },
              // Neither a shorter prefix nor a different full name is the shell.
              { pid: 9003, ppid: 1, name: "custom" },
              { pid: 9004, ppid: 1, name: `${shellName}-worker` },
            ].map((entry) =>
              entry.ppid === 1 && !commandsStarted ? { ...entry, name: shellName } : entry,
            ),
          ),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        for (const terminalId of ["full", "comm", "exec", "short-prefix", "different-full"]) {
          yield* manager.open(openInput({ terminalId }));
          if (terminalId !== "full") {
            yield* manager.write({ threadId: "thread-1", terminalId, data: "exec command\r" });
          }
        }

        commandsStarted = true;
        yield* manager.closeIdle({ threadId: "thread-1" });

        expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
          true,
          false,
          false,
          false,
          false,
        ]);
      }),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      (
        [
          {
            scenario: "truncated ASCII name",
            shellName: "custom-login-shell",
            startupName: "-custom-login-s",
            commandName: "custom-login-s",
            active: true,
          },
          {
            scenario: "truncated UTF-8 name",
            shellName: "custom-é-login-shell",
            startupName: "-custom-é-logi",
            commandName: "custom-é-logi",
            active: true,
          },
          {
            scenario: "full short name",
            shellName: "zsh",
            startupName: "-zsh",
            commandName: "-zsh",
            active: false,
          },
        ] as const
      ).map((scenario) => ({ source, ...scenario })),
    ),
  )(
    "Linux login-shell $scenario stays safe through $source first input and cleanup",
    ({ source, shellName, startupName, commandName, active }) =>
      Effect.gen(function* () {
        const registered = yield* Deferred.make<ReadonlyArray<number>>();
        const ptyAdapter = new FakePtyAdapter();
        let observedName: string = startupName;
        let ownershipReleases = 0;
        const { manager } = yield* createSnapshotBoundaryManager(
          source,
          ptyAdapter,
          Effect.sync(() => [{ pid: 9000, ppid: 1, name: observedName }]),
          {
            shellResolver: () => `/opt/tools/${shellName}`,
            registerTerminalProcesses: ({ processIds }) =>
              Deferred.succeed(registered, processIds).pipe(Effect.asVoid),
            unregisterTerminal: () =>
              Effect.sync(() => {
                ownershipReleases += 1;
              }),
          },
        );
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        const writing = yield* manager
          .write({ ...terminal, data: active ? `exec ${commandName}\r` : "noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        // These long login-shell comm values are 15 UTF-8 bytes before the
        // leading dash is removed; their normalized names are only 14 bytes.
        // A childless exec can use that shorter full name, keeping its PID.
        observedName = commandName;
        yield* TestClock.adjust("60 seconds");
        const processIds = yield* Deferred.await(registered);
        const metadataBeforeCleanup = yield* readIdleInspectionMetadata(manager);
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const metadataAfterCleanup = yield* readIdleInspectionMetadata(manager);
        const killedByCleanup = process.killed;
        const ownershipReleasedByCleanup = ownershipReleases;
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(processIds).toEqual(active ? [process.pid] : []);
        expect(metadataBeforeCleanup).toEqual([
          expect.objectContaining({
            pid: process.pid,
            status: "running",
            hasRunningSubprocess: active,
            ...(active ? { label: commandName } : {}),
          }),
        ]);
        expect(killedByCleanup).toBe(!active);
        if (active) {
          expect(metadataAfterCleanup).toEqual(metadataBeforeCleanup);
          expect(ownershipReleasedByCleanup).toBe(0);
        } else {
          expect(metadataAfterCleanup).toEqual([]);
          expect(ownershipReleasedByCleanup).toBeGreaterThan(0);
        }
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["custom-login-shell", "my-shell", "custom-login-sh"])(
    "retains a childless matching-prefix exec and ownership when configured shell is %s",
    (shellName) =>
      Effect.gen(function* () {
        const ownedProcessIds = yield* Deferred.make<ReadonlyArray<number>>();
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => `/opt/tools/${shellName}`,
          // custom-login-shell-worker has the same 15-byte comm as the shell.
          processTable: Effect.succeed([{ pid: 9000, ppid: 1, name: "custom-login-sh" }]),
          registerTerminalProcesses: ({ processIds }) =>
            processIds.length > 0
              ? Deferred.succeed(ownedProcessIds, processIds).pipe(Effect.asVoid)
              : Effect.void,
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());

        expect(yield* Deferred.await(ownedProcessIds)).toEqual([9000]);
        yield* manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "exec custom-login-shell-worker\r",
        });
        yield* manager.closeIdle({ threadId: "thread-1" });

        expect(ptyAdapter.processes[0]?.killed).toBe(false);
      }),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      (
        [
          {
            scenario: "timeout after an idle startup observation",
            capture: "timeout",
            priorObservation: true,
            observedName: "zsh",
            active: false,
          },
          {
            scenario: "error after an idle startup observation",
            capture: "error",
            priorObservation: true,
            observedName: "zsh",
            active: false,
          },
          {
            scenario: "error before an exec matching the configured wrapper",
            capture: "error",
            priorObservation: true,
            observedName: "my-shell",
            active: true,
          },
          {
            scenario: "error before an unobserved childless exec",
            capture: "error",
            priorObservation: false,
            observedName: "node",
            active: true,
          },
          {
            scenario: "error before a later snapshot missing the root",
            capture: "error",
            priorObservation: false,
            observedName: "",
            active: true,
          },
          {
            scenario: "missing root before an unobserved idle wrapper",
            capture: "missing",
            priorObservation: false,
            observedName: "zsh",
            active: true,
          },
        ] as const
      ).map((scenario) => ({ source, ...scenario })),
    ),
  )(
    "uses only pre-input wrapper identity after $source capture $scenario",
    ({ source, capture, priorObservation, observedName, active }) =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        const recoveredPollCompleted = yield* Deferred.make<void>();
        const releaseCompletionWitness = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let phase: "pre-input" | "capture" | "recovered" = priorObservation
          ? "pre-input"
          : "capture";
        let preInputSnapshots = 0;
        let recoveredSnapshots = 0;
        let ownedProcessIds: ReadonlyArray<number> = [];
        const readSnapshot = Effect.gen(function* () {
          if (phase === "pre-input") {
            preInputSnapshots += 1;
            if (preInputSnapshots <= 2) {
              return { entries: [{ pid: 9000, ppid: 1, name: "zsh" }], failed: false };
            }
            // Beginning the next background scan proves the earlier startup
            // observation was applied before first input can be forwarded.
            phase = "capture";
          }
          if (phase === "capture") {
            const entries = capture === "missing" ? [] : [{ pid: 9000, ppid: 1, name: "zsh" }];
            yield* Deferred.succeed(captureEntered, undefined);
            yield* Deferred.await(releaseCapture);
            return { entries, failed: capture === "error" };
          }
          recoveredSnapshots += 1;
          if (recoveredSnapshots === 2) {
            yield* Deferred.succeed(recoveredPollCompleted, undefined);
            yield* Deferred.await(releaseCompletionWitness);
          }
          return {
            entries: observedName ? [{ pid: 9000, ppid: 1, name: observedName }] : [],
            failed: false,
          };
        });
        const processTable = readSnapshot.pipe(
          Effect.flatMap(({ entries, failed }) =>
            failed
              ? Effect.fail("sidecar unavailable").pipe(Effect.mapError((cause) => cause as never))
              : Effect.succeed(entries),
          ),
        );
        const processRunner: ProcessRunner.ProcessRunner["Service"] = {
          run: (input) =>
            readSnapshot.pipe(
              Effect.map(({ entries, failed }) => {
                expect(input.args).toEqual(["-eo", "pid=,ppid=,comm="]);
                return {
                  stdout: entries.map(({ pid, ppid, name }) => `${pid} ${ppid} ${name}`).join("\n"),
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
            ),
        };
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          shellResolver: () => "/opt/tools/my-shell",
          subprocessPollIntervalMs: 60_000,
          registerTerminalProcesses: ({ processIds }) =>
            Effect.sync(() => {
              ownedProcessIds = [...processIds];
            }),
          ...(source === "native" ? { processTable } : {}),
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
          Effect.provide(layerWithHostPlatform("linux")),
        );
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        if (priorObservation) {
          yield* TestClock.adjust("180 seconds");
          yield* Deferred.await(captureEntered);
        }
        const writing = yield* manager
          .write({ ...terminal, data: "noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(captureEntered);
        if (capture === "timeout") yield* TestClock.adjust("100 millis");
        else yield* Deferred.succeed(releaseCapture, undefined);
        if (capture === "missing") yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        phase = "recovered";
        yield* Deferred.succeed(releaseCapture, undefined);
        yield* TestClock.adjust("3 minutes");
        // Hold a second recovered scan so the metadata and ownership below
        // can only have come from the completed first recovered poll.
        yield* Deferred.await(recoveredPollCompleted);
        const metadataBeforeCleanup = yield* readIdleInspectionMetadata(manager);
        const processIdsBeforeCleanup = [...ownedProcessIds];
        yield* Deferred.succeed(releaseCompletionWitness, undefined);
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const metadataAfterCleanup = yield* readIdleInspectionMetadata(manager);
        const killSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(process.writes).toEqual(["noop\r"]);
        expect(processIdsBeforeCleanup).toEqual(active ? [process.pid] : []);
        expect(metadataBeforeCleanup).toEqual([
          expect.objectContaining({
            pid: process.pid,
            status: "running",
            hasRunningSubprocess: active,
            ...(active && observedName ? { label: observedName } : {}),
          }),
        ]);
        expect(metadataAfterCleanup).toEqual(active ? metadataBeforeCleanup : []);
        if (active) expect(killSignals).toEqual([]);
        else expect(killSignals).toContain("SIGTERM");
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      [
        { scenario: "complete idle shell", startupName: "zsh", nextName: "zsh", active: false },
        {
          scenario: "ambiguous truncated login shell",
          startupName: "-custom-login-s",
          nextName: "custom-login-s",
          active: true,
        },
      ].map((scenario) => ({ source, ...scenario })),
    ),
  )(
    "uses a late pre-input $source observation while the first writer queues: $scenario",
    ({ source, startupName, nextName, active }) =>
      Effect.gen(function* () {
        const holderEntered = yield* Deferred.make<void>();
        const releaseHolder = yield* Deferred.make<void>();
        const captureEntered = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        const lateObservationApplied = yield* Deferred.make<void>();
        const releaseLateWitness = yield* Deferred.make<void>();
        const recoveredPollCompleted = yield* Deferred.make<void>();
        const releaseRecoveredWitness = yield* Deferred.make<void>();
        let holdNextHistoryWrite = false;
        const fs = yield* FileSystem.FileSystem;
        const holderFileSystem = {
          ...fs,
          writeFileString: () =>
            Effect.gen(function* () {
              if (holdNextHistoryWrite) {
                holdNextHistoryWrite = false;
                yield* Deferred.succeed(holderEntered, undefined);
                yield* Deferred.await(releaseHolder);
              }
            }),
        };
        const ptyAdapter = new FakePtyAdapter();
        let phase: "capture" | "late" | "recovered" = "capture";
        let lateScans = 0;
        let recoveredScans = 0;
        let ownedProcessIds: ReadonlyArray<number> = [];
        const processTable = Effect.gen(function* () {
          if (phase === "capture") {
            yield* Deferred.succeed(captureEntered, undefined);
            yield* Deferred.await(releaseCapture);
            return [];
          }
          const name = phase === "late" ? startupName : nextName;
          if (phase === "late" && ++lateScans === 3) {
            // The poller cannot begin this scan until it has applied the
            // previous pre-input observation while the writer was queued.
            yield* Deferred.succeed(lateObservationApplied, undefined);
            yield* Deferred.await(releaseLateWitness);
          } else if (phase === "recovered" && ++recoveredScans === 2) {
            yield* Deferred.succeed(recoveredPollCompleted, undefined);
            yield* Deferred.await(releaseRecoveredWitness);
          }
          return [{ pid: 9000, ppid: 1, name }];
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          registerTerminalProcesses: ({ processIds }) =>
            Effect.sync(() => {
              ownedProcessIds = [...processIds];
            }),
        }).pipe(Effect.provideService(FileSystem.FileSystem, holderFileSystem));
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        holdNextHistoryWrite = true;
        const holder = yield* manager.clear(terminal).pipe(Effect.forkScoped);
        yield* Deferred.await(holderEntered);
        const writing = yield* manager
          .write({ ...terminal, data: "noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(captureEntered);
        yield* TestClock.adjust("100 millis");
        phase = "late";
        yield* Deferred.succeed(releaseCapture, undefined);
        yield* TestClock.adjust("3 minutes");
        yield* Deferred.await(lateObservationApplied);
        const writesWhileQueued = [...process.writes];
        yield* Deferred.succeed(releaseLateWitness, undefined);
        yield* Deferred.succeed(releaseHolder, undefined);
        yield* Fiber.join(holder);
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        phase = "recovered";
        yield* Deferred.succeed(releaseLateWitness, undefined);
        yield* TestClock.adjust("3 minutes");
        yield* Deferred.await(recoveredPollCompleted);
        const metadata = yield* readIdleInspectionMetadata(manager);
        const processIds = [...ownedProcessIds];
        yield* Deferred.succeed(releaseRecoveredWitness, undefined);
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const metadataAfterCleanup = yield* readIdleInspectionMetadata(manager);
        const killSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(writesWhileQueued).toEqual([]);
        expect(process.writes).toEqual(["noop\r"]);
        expect(processIds).toEqual(active ? [process.pid] : []);
        expect(metadata).toEqual([
          expect.objectContaining({
            pid: process.pid,
            status: "running",
            hasRunningSubprocess: active,
            ...(active ? { label: nextName } : {}),
          }),
        ]);
        expect(metadataAfterCleanup).toEqual(active ? metadata : []);
        if (active) expect(killSignals).toEqual([]);
        else expect(killSignals).toContain("SIGTERM");
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(
    (["native", "fallback"] as const).flatMap((source) =>
      [
        { startupName: "my-shell", configuredName: "my-shell" },
        { startupName: "bash", configuredName: "my-shell" },
        { startupName: "bash", configuredName: "bash" },
      ].flatMap(({ startupName, configuredName }) =>
        ([true, false] as const).map((resolves) => ({
          source,
          startupName,
          configuredName,
          resolves,
        })),
      ),
    ),
  )(
    "settles $source wrapper identity from $startupName configured as $configuredName before forwarding when resolved=$resolves",
    ({ source, startupName, configuredName, resolves }) =>
      Effect.gen(function* () {
        const firstSampleStarted = yield* Deferred.make<void>();
        const releaseFirstSample = yield* Deferred.make<void>();
        const releaseUnsettledSample = yield* Deferred.make<void>();
        const firstPollCompleted = yield* Deferred.make<void>();
        const releaseFirstPollWitness = yield* Deferred.make<void>();
        const execPollCompleted = yield* Deferred.make<void>();
        const releaseExecPollWitness = yield* Deferred.make<void>();
        const ptyAdapter = new FakePtyAdapter();
        let phase: "capture" | "poll" | "exec" = "capture";
        let captureSamples = 0;
        let pollSamples = 0;
        let execSamples = 0;
        let rootName: string = startupName;
        let ownedProcessIds: ReadonlyArray<number> = [];
        const processTable = Effect.gen(function* () {
          const name = rootName;
          if (phase === "capture") {
            captureSamples += 1;
            if (captureSamples === 1) {
              // This table was taken while the configured wrapper or its
              // interpreter was still the root, before the real shell began.
              yield* Deferred.succeed(firstSampleStarted, undefined);
              yield* Deferred.await(releaseFirstSample);
            } else if (!resolves) {
              yield* Deferred.await(releaseUnsettledSample);
            }
          } else if (phase === "poll" && ++pollSamples === 2) {
            yield* Deferred.succeed(firstPollCompleted, undefined);
            yield* Deferred.await(releaseFirstPollWitness);
          } else if (phase === "exec" && ++execSamples === 2) {
            yield* Deferred.succeed(execPollCompleted, undefined);
            yield* Deferred.await(releaseExecPollWitness);
          }
          return [{ pid: 9000, ppid: 1, name }];
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          shellResolver: () => `/opt/tools/${configuredName}`,
          registerTerminalProcesses: ({ processIds }) =>
            Effect.sync(() => {
              ownedProcessIds = [...processIds];
            }),
        });
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        const writing = yield* manager
          .write({ ...terminal, data: "noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstSampleStarted);
        const writesBeforeSample = [...process.writes];
        if (resolves) rootName = "zsh";
        yield* Deferred.succeed(releaseFirstSample, undefined);
        // Exercise the real typing deadline. An unsettled confirmation must
        // not hold input longer, or freeze a wrapper as the permanent shell.
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        phase = "poll";
        yield* Deferred.succeed(releaseUnsettledSample, undefined);
        yield* TestClock.adjust("3 minutes");
        yield* Deferred.await(firstPollCompleted);
        const initialMetadata = yield* readIdleInspectionMetadata(manager);
        const initialOwnership = [...ownedProcessIds];
        yield* Deferred.succeed(releaseFirstPollWitness, undefined);
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const initialKillSignals = [...process.killSignals];
        const metadataAfterInitialCleanup = yield* readIdleInspectionMetadata(manager);
        let execMetadata = metadataAfterInitialCleanup;
        let execOwnership: ReadonlyArray<number> = [];
        if (!resolves && !process.killed) {
          // A later childless exec is evidence of activity, never a new shell
          // identity learned after the first bytes were forwarded.
          phase = "exec";
          rootName = "node";
          yield* TestClock.adjust("3 minutes");
          yield* Deferred.await(execPollCompleted);
          execMetadata = yield* readIdleInspectionMetadata(manager);
          execOwnership = [...ownedProcessIds];
          yield* Deferred.succeed(releaseExecPollWitness, undefined);
          yield* manager.closeIdle(terminal);
        }
        const finalKillSignals = [...process.killSignals];
        if (!process.killed) yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        expect(writesBeforeSample).toEqual([]);
        expect(process.writes).toEqual(["noop\r"]);
        expect(initialOwnership).toEqual(resolves ? [] : [process.pid]);
        expect(initialMetadata).toEqual([
          expect.objectContaining({
            pid: process.pid,
            status: "running",
            hasRunningSubprocess: !resolves,
            ...(!resolves ? { label: startupName } : {}),
          }),
        ]);
        if (resolves) {
          expect(initialKillSignals).toContain("SIGTERM");
          expect(metadataAfterInitialCleanup).toEqual([]);
        } else {
          expect(initialKillSignals).toEqual([]);
          expect(metadataAfterInitialCleanup).toEqual(initialMetadata);
          expect(execOwnership).toEqual([process.pid]);
          expect(execMetadata).toEqual([
            expect.objectContaining({
              pid: process.pid,
              status: "running",
              hasRunningSubprocess: true,
              label: "node",
            }),
          ]);
          expect(finalKillSignals).toEqual([]);
        }
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("closes an idle shell started through a differently named wrapper", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/opt/tools/my-shell",
        processTable: Effect.succeed([{ pid: 9000, ppid: 1, name: "zsh" }]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());
      yield* manager.closeIdle({ threadId: "thread-1" });
      expect(ptyAdapter.processes[0]?.killed).toBe(true);
    }),
  );

  it.effect("keeps later input behind the first PTY write after capture completes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.succeed([{ pid: 9000, ppid: 1, name: "zsh" }]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const originalWrite = process.write.bind(process);
      const startLaterWrite = yield* Deferred.make<void>();
      const laterWrite = yield* Deferred.await(startLaterWrite).pipe(
        Effect.andThen(
          manager.write({
            threadId: "thread-1",
            terminalId: DEFAULT_TERMINAL_ID,
            data: "later input\r",
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      process.write = (data) => {
        if (data === "first input\r") {
          // Start the next chunk synchronously at the forwarding boundary.
          // It must still queue even though the cached capture has completed.
          Deferred.doneUnsafe(startLaterWrite, Effect.void);
        }
        originalWrite(data);
      };

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "first input\r",
      });
      yield* Fiber.join(laterWrite);
      expect(process.writes).toEqual(["first input\r", "later input\r"]);
    }),
  );

  it.effect.each(["restart", "context-changing open"] as const)(
    "rejects queued input from the original process after %s",
    (operation) =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const finishCapture = yield* Deferred.make<void>();
        const replacementStarted = yield* Deferred.make<void>();
        const finishReplacement = yield* Deferred.make<void>();
        const resumedInput: Array<() => void> = [];
        let pauseInput = false;
        const defaultDispatcher = (yield* Scheduler.Scheduler).makeDispatcher();
        const inputScheduler: Scheduler.Scheduler = {
          executionMode: "async",
          shouldYield: () => pauseInput,
          makeDispatcher: () => ({
            scheduleTask: (task, priority) => {
              if (pauseInput) resumedInput.push(task);
              else defaultDispatcher.scheduleTask(task, priority);
            },
            flush: () => {},
          }),
        };
        const resumeInput = () => {
          pauseInput = false;
          for (const task of resumedInput.splice(0)) task();
        };
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.gen(function* () {
            yield* Deferred.succeed(captureEntered, undefined);
            yield* Deferred.await(finishCapture);
            return ptyAdapter.processes
              .filter((process) => !process.killed)
              .map(({ pid }) => ({ pid, ppid: 1, name: "zsh" }));
          }),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());
        const original = ptyAdapter.processes[0]!;
        original.exitOnKill = "SIGTERM";
        const write = (data: string) =>
          manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data });
        const first = yield* write("first\r").pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(captureEntered);
        yield* TestClock.adjust(0);
        const second = yield* write("stale second\r").pipe(
          Effect.provideService(Scheduler.Scheduler, inputScheduler),
          Effect.result,
          Effect.forkScoped({ startImmediately: true }),
        );
        const third = yield* write("stale third\r").pipe(
          Effect.provideService(Scheduler.Scheduler, inputScheduler),
          Effect.result,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* TestClock.adjust(0);
        expect(original.writes).toEqual([]);
        expect(second.pollUnsafe()).toBeUndefined();
        expect(third.pollUnsafe()).toBeUndefined();

        const unsubscribe = yield* manager.subscribe((event) =>
          (event.type === "started" || event.type === "restarted") &&
          event.snapshot.pid !== original.pid
            ? Deferred.succeed(replacementStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishReplacement)),
              )
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        // Hold later writers' Deferred resumptions until the replacement owns
        // the thread lock; lock wakeups need not outrun newly runnable input.
        const replacing = yield* (
          operation === "restart"
            ? manager.restart(restartInput())
            : manager.open(openInput({ env: { TERMINAL_CONTEXT: "replacement" } }))
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.addFinalizer(() => Effect.sync(resumeInput));
        yield* TestClock.adjust(0);
        expect(replacing.pollUnsafe()).toBeUndefined();
        pauseInput = true;
        yield* Deferred.succeed(finishCapture, undefined);
        yield* Deferred.await(replacementStarted);
        yield* Fiber.join(first);
        const replacement = ptyAdapter.processes[1]!;
        replacement.exitOnKill = "SIGTERM";
        expect(original.killed).toBe(true);
        expect(original.writes).toEqual(["first\r"]);
        expect(replacement.writes).toEqual([]);
        expect(second.pollUnsafe()).toBeUndefined();
        expect(third.pollUnsafe()).toBeUndefined();

        resumeInput();
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(finishReplacement, undefined);
        yield* Fiber.join(replacing);
        const queuedResults = yield* Effect.forEach([second, third], Fiber.join);
        yield* write("fresh input\r");
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [openInput()]);
        for (const result of queuedResults) {
          expect(result._tag === "Failure" ? result.failure._tag : null).toBe(
            "TerminalNotRunningError",
          );
        }
        expect(replacement.writes).toEqual(["fresh input\r"]);
        expect(original.writes).toEqual(["first\r"]);
        expect(ptyAdapter.processes).toHaveLength(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["deliver", "cancel", "fail"] as const)(
    "preserves three-chunk input order when the queued middle chunk must %s",
    (outcome) =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const finishCapture = yield* Deferred.make<void>();
        const startThird = yield* Deferred.make<void>();
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.gen(function* () {
            yield* Deferred.succeed(captureEntered, undefined);
            yield* Deferred.await(finishCapture);
            return [{ pid: 9000, ppid: 1, name: "zsh" }];
          }),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        const originalWrite = process.write.bind(process);
        process.write = (data) => {
          if (outcome === "fail" && data === "middle\r") throw new Error("middle write failed");
          originalWrite(data);
        };
        const write = (data: string) =>
          manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data });
        const third = yield* Deferred.await(startThird).pipe(
          Effect.andThen(write("third\r")),
          Effect.forkScoped({ startImmediately: true }),
        );
        const first = yield* write("first\r").pipe(
          // This continuation runs after successful forwarding clears the
          // first-input gate, while the earlier middle request is queued.
          Effect.andThen(Deferred.succeed(startThird, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.await(captureEntered);
        const middle = yield* write("middle\r").pipe(
          Effect.result,
          Effect.forkScoped({ startImmediately: true }),
        );
        expect(middle.pollUnsafe()).toBeUndefined();
        if (outcome === "cancel") yield* Fiber.interrupt(middle);
        expect(process.writes).toEqual([]);
        yield* Deferred.succeed(finishCapture, undefined);
        yield* Fiber.join(first);
        if (outcome !== "cancel") {
          expect((yield* Fiber.join(middle))._tag).toBe(
            outcome === "deliver" ? "Success" : "Failure",
          );
        }
        yield* Fiber.join(third);
        expect(process.writes).toEqual(
          outcome === "deliver" ? ["first\r", "middle\r", "third\r"] : ["first\r", "third\r"],
        );
        yield* exitSnapshotTestProcesses(manager, ptyAdapter, [openInput()]);
      }),
  );

  it.effect("keeps forwarded exec active when its writer is canceled before resuming", () =>
    Effect.gen(function* () {
      const captureEntered = yield* Deferred.make<void>();
      const finishCapture = yield* Deferred.make<void>();
      let commandName = "zsh";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.gen(function* () {
          const name = commandName;
          yield* Deferred.succeed(captureEntered, undefined);
          yield* Deferred.await(finishCapture);
          return [{ pid: 9000, ppid: 1, name }];
        }),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const originalWrite = process.write.bind(process);
      let interruptWriter = () => {};
      process.write = (data) => {
        originalWrite(data);
        commandName = "node";
        interruptWriter();
      };
      const writing = yield* manager
        .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "exec node\r" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      interruptWriter = () => writing.interruptUnsafe();
      yield* Deferred.await(captureEntered);
      yield* Deferred.succeed(finishCapture, undefined);
      expect(Exit.isFailure(yield* Fiber.await(writing))).toBe(true);
      expect(process.writes).toEqual(["exec node\r"]);

      yield* manager.closeIdle({ threadId: "thread-1" });
      expect(process.killed).toBe(false);
    }),
  );

  it.effect.each(["close", "restart"] as const)(
    "freezes wrapper identity while first input and %s overlap",
    (operation) =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const closeStarted = yield* Deferred.make<void>();
        let commandName = "zsh";
        let snapshotCalls = 0;
        let capturing = false;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/opt/tools/my-shell",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.gen(function* () {
            snapshotCalls += 1;
            const name = commandName;
            if (capturing) {
              yield* Deferred.succeed(captureEntered, undefined);
              yield* Deferred.await(releaseCapture);
            }
            return [
              { pid: 9000, ppid: 1, name },
              { pid: 9001, ppid: 1, name },
            ];
          }),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        const originalWrite = process.write.bind(process);
        process.write = (data) => {
          originalWrite(data);
          commandName = "node";
        };
        capturing = true;
        const first = yield* manager
          .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "exec node\r" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(captureEntered);
        const second = yield* Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(
            operation === "close"
              ? manager.write({
                  threadId: "thread-1",
                  terminalId: DEFAULT_TERMINAL_ID,
                  data: "second input\r",
                })
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(secondStarted);
        const close = yield* Deferred.succeed(closeStarted, undefined).pipe(
          Effect.andThen(
            operation === "close"
              ? manager.closeIdle({ threadId: "thread-1" })
              : manager.restart(restartInput()),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(closeStarted);
        expect(process.killed).toBe(false);
        expect(process.writes).toEqual([]);
        yield* Deferred.succeed(releaseCapture, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(snapshotCalls).toBeLessThanOrEqual(3);
        capturing = false;
        yield* Fiber.join(close);
        expect(process.writes).toEqual(
          operation === "close" ? ["exec node\r", "second input\r"] : ["exec node\r"],
        );
        expect(process.killed).toBe(operation === "restart");
        if (operation === "restart") {
          // Restart must capture the new shell, rather than retaining old identity.
          commandName = "zsh";
          yield* manager.write({
            threadId: "thread-1",
            terminalId: DEFAULT_TERMINAL_ID,
            data: "exec node\r",
          });
          commandName = "node";
          yield* manager.closeIdle({ threadId: "thread-1" });
          expect(ptyAdapter.processes[1]?.killed).toBe(false);
          expect(ptyAdapter.processes[1]?.writes).toEqual(["exec node\r"]);
        }
      }),
  );

  it.effect.each(["native", "fallback"] as const)(
    "skips reserved first input when %s idle cleanup queues before its writer",
    (source) =>
      Effect.gen(function* () {
        const holderEntered = yield* Deferred.make<void>();
        const releaseHolder = yield* Deferred.make<void>();
        const captureEntered = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        let holdNextHistoryWrite = false;
        const fs = yield* FileSystem.FileSystem;
        const holderFileSystem = {
          ...fs,
          writeFileString: () =>
            Effect.gen(function* () {
              if (holdNextHistoryWrite) {
                holdNextHistoryWrite = false;
                yield* Deferred.succeed(holderEntered, undefined);
                yield* Deferred.await(releaseHolder);
              }
            }),
        };
        let pauseCleanup = false;
        const resumedCleanup: Array<() => void> = [];
        const defaultDispatcher = (yield* Scheduler.Scheduler).makeDispatcher();
        const cleanupScheduler: Scheduler.Scheduler = {
          executionMode: "async",
          shouldYield: () => pauseCleanup,
          makeDispatcher: () => ({
            scheduleTask: (task, priority) => {
              if (pauseCleanup) resumedCleanup.push(task);
              else defaultDispatcher.scheduleTask(task, priority);
            },
            flush: () => {},
          }),
        };
        const resumeCleanup = () => {
          pauseCleanup = false;
          for (const task of resumedCleanup.splice(0)) task();
        };
        yield* Effect.addFinalizer(() => Effect.sync(resumeCleanup));
        const ptyAdapter = new FakePtyAdapter();
        let holdNextSnapshot = true;
        let ownershipReleases = 0;
        const processTable = Effect.gen(function* () {
          if (holdNextSnapshot) {
            holdNextSnapshot = false;
            yield* Deferred.succeed(captureEntered, undefined);
            yield* Deferred.await(releaseCapture);
          }
          return [{ pid: 9000, ppid: 1, name: "zsh" }];
        });
        const { manager } = yield* createSnapshotBoundaryManager(source, ptyAdapter, processTable, {
          shellResolver: () => "/bin/zsh",
          unregisterTerminal: () =>
            Effect.sync(() => {
              ownershipReleases += 1;
            }),
        }).pipe(Effect.provideService(FileSystem.FileSystem, holderFileSystem));
        yield* TestClock.adjust(0);
        const terminal = openInput();
        yield* manager.open(terminal);
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        holdNextHistoryWrite = true;
        const holder = yield* manager.clear(terminal).pipe(Effect.forkScoped);
        yield* Deferred.await(holderEntered);
        const closing = yield* manager
          .closeIdle(terminal)
          .pipe(
            Effect.provideService(Scheduler.Scheduler, cleanupScheduler),
            Effect.forkScoped({ startImmediately: true }),
          );
        const writing = yield* manager
          .write({ ...terminal, data: "noop\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(captureEntered);
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(releaseHolder, undefined);
        yield* Fiber.join(holder);
        yield* TestClock.adjust(0);
        // Cleanup was queued first, so its candidate capture happens after
        // reservation but before forwarding. Hold its scan resumption until
        // the writer has also released its pending-input reservation.
        pauseCleanup = true;
        yield* Deferred.succeed(releaseCapture, undefined);
        yield* Fiber.join(writing);
        resumeCleanup();
        yield* Fiber.join(closing);
        const staleKillSignals = [...process.killSignals];
        const staleOwnershipReleases = ownershipReleases;
        const metadataAfterQueuedCleanup = yield* readIdleInspectionMetadata(manager);
        // The submitted no-op is now idle; skipping one reserved candidate
        // must not keep the shell immune to a later cleanup.
        yield* manager.closeIdle(terminal);
        yield* TestClock.adjust("1 millis");
        const metadataAfterFreshCleanup = yield* readIdleInspectionMetadata(manager);
        const freshKillSignals = [...process.killSignals];
        if (metadataAfterFreshCleanup.some(({ status }) => status === "running")) {
          yield* exitSnapshotTestProcesses(manager, ptyAdapter, [terminal]);
        }
        expect(process.writes).toEqual(["noop\r"]);
        expect(staleKillSignals).toEqual([]);
        expect(staleOwnershipReleases).toBe(0);
        expect(metadataAfterQueuedCleanup).toEqual([
          expect.objectContaining({ pid: process.pid, status: "running" }),
        ]);
        expect(freshKillSignals).toContain("SIGTERM");
        expect(metadataAfterFreshCleanup).toEqual([]);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["deliver", "cancel", "fail"] as const)(
    "protects first input queued behind idle cleanup and releases pending input after %s",
    (outcome) =>
      Effect.gen(function* () {
        const inspectionEntered = yield* Deferred.make<void>();
        const finishInspection = yield* Deferred.make<void>();
        let checking = false;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processKillGraceMs: 0,
          processTable: Effect.gen(function* () {
            if (checking) {
              yield* Deferred.succeed(inspectionEntered, undefined);
              yield* Deferred.await(finishInspection);
            }
            return [{ pid: 9000, ppid: 1, name: "zsh" }];
          }),
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        if (outcome === "fail") process.writeFailure = new Error("write failed");
        checking = true;
        const closing = yield* manager
          .closeIdle({ threadId: "thread-1" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(inspectionEntered);
        const writing = yield* manager
          .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "command\r" })
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        expect(writing.pollUnsafe()).toBeUndefined();
        if (outcome === "cancel") yield* Fiber.interrupt(writing);
        checking = false;
        yield* Deferred.succeed(finishInspection, undefined);
        yield* Fiber.join(closing);
        if (outcome !== "cancel") {
          expect((yield* Fiber.join(writing))._tag).toBe(
            outcome === "deliver" ? "Success" : "Failure",
          );
        }
        expect(process.killed).toBe(false);
        expect(process.writes).toEqual(outcome === "deliver" ? ["command\r"] : []);
        // Failed/canceled requests must not leave a permanent cleanup blocker.
        yield* manager.closeIdle({ threadId: "thread-1" });
        expect(process.killed).toBe(true);
      }),
  );

  it.effect(
    "bounds first input when the process monitor stalls without adopting the later exec",
    () =>
      Effect.gen(function* () {
        const captureEntered = yield* Deferred.make<void>();
        const stalledMonitor = yield* Deferred.make<void>();
        const ownedProcessIds = yield* Deferred.make<ReadonlyArray<number>>();
        const exited = yield* Deferred.make<void>();
        let stalled = true;
        const { manager, ptyAdapter } = yield* createManager(5, {
          shellResolver: () => "/bin/zsh",
          subprocessPollIntervalMs: 60_000,
          processTable: Effect.gen(function* () {
            if (stalled) {
              yield* Deferred.succeed(captureEntered, undefined);
              yield* Deferred.await(stalledMonitor);
            }
            return [{ pid: 9000, ppid: 1, name: "node" }];
          }),
          registerTerminalProcesses: ({ processIds }) =>
            processIds.length > 0
              ? Deferred.succeed(ownedProcessIds, processIds).pipe(Effect.asVoid)
              : Effect.void,
        }).pipe(Effect.provide(layerWithHostPlatform("linux")));
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "exited"
            ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.exitOnKill = "SIGTERM";
        const writing = yield* manager
          .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "exec node\r" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(captureEntered);
        expect(process.writes).toEqual([]);
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(writing);
        expect(process.writes).toEqual(["exec node\r"]);
        stalled = false;
        yield* Deferred.succeed(stalledMonitor, undefined);
        yield* manager.closeIdle({ threadId: "thread-1" });
        expect(process.killed).toBe(false);
        yield* TestClock.adjust("60 seconds");
        expect(yield* Deferred.await(ownedProcessIds)).toEqual([9000]);
        process.emitExit({ exitCode: 0, signal: null });
        yield* Deferred.await(exited);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps Windows root detection based on child processes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "pwsh.exe",
        subprocessPollIntervalMs: 60_000,
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "node.exe" },
          { pid: 9001, ppid: 1, name: "pwsh.exe" },
          { pid: 100, ppid: 9001, name: "node.exe" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));
      yield* manager.open(openInput({ terminalId: "root" }));
      yield* manager.open(openInput({ terminalId: "child" }));

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([true, false]);
    }),
  );

  it.effect("keeps terminals that get input or output while closeIdle checks them", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      // The typed command's process misses the snapshot, but its input or echo lands.
      let duringCheck: (pid: number) => Effect.Effect<void> = () => Effect.void;
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        subprocessPollIntervalMs: 60_000,
        subprocessInspector: (pid) =>
          duringCheck(pid).pipe(
            Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
          ),
      });
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
              yield* waitFor(
                Effect.map(getEvents, (events) => events.some((event) => event.type === "output")),
              );
            }).pipe(Effect.orDie);

      yield* manager.closeIdle({ threadId: "thread-1" });

      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([false, false]);
    }),
  );

  it.effect("backs off the spawned fallback when the resource monitor snapshot fails", () =>
    Effect.gen(function* () {
      const fallbackCalls: Array<number> = [];
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              fallbackCalls.push(now);
              return {
                stdout: "  100  9000 vim",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrInvalidUtf8: false,
                stdoutInvalidUtf8: false,
                stderrTruncated: false,
              };
            }),
          ),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.fail("sidecar unavailable").pipe(
          Effect.mapError((cause) => cause as never),
        ),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      // The fallback data is still applied while the sidecar is down.
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

      yield* waitFor(
        Effect.sync(() => fallbackCalls.length >= 4),
        "2000 millis",
      );
      // Four snapshots at the 20 ms base cadence would span ~60 ms. Backoff
      // (40 + 80 + 160 ms) stretches the same four snapshots past 150 ms, so
      // a stalled sidecar no longer hot-loops the spawned fallback.
      const spanMs = fallbackCalls[3]! - fallbackCalls[0]!;
      expect(spanMs).toBeGreaterThan(150);
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

  it.effect.each(["current", "legacy"] as const)(
    "reads only a Unicode-safe tail from oversized %s history",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let sourcePath: string | undefined;
        let closedReads = 0;
        const readRequests: number[] = [];
        const trackedFileSystem = FileSystem.FileSystem.of({
          ...fs,
          readFileString: (candidate, encoding) =>
            candidate === sourcePath
              ? Effect.die("History restoration must not read the whole file")
              : fs.readFileString(candidate, encoding),
          open: (candidate, options) =>
            Effect.gen(function* () {
              if (candidate !== sourcePath) return yield* fs.open(candidate, options);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closedReads += 1;
                }),
              );
              const file = yield* fs.open(candidate, options);
              return new Proxy(file, {
                get(target, key) {
                  if (key === "read") {
                    return (buffer: Uint8Array) => {
                      readRequests.push(buffer.byteLength);
                      return target.read(buffer.subarray(0, 5));
                    };
                  }
                  return Reflect.get(target, key, target);
                },
              });
            }),
        });
        const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 15 }).pipe(
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );
        const nextPath = yield* historyLogPath(logsDir);
        sourcePath = source === "current" ? nextPath : path.join(logsDir, "thread-1.log");
        yield* fs.writeFileString(sourcePath, "old".repeat(32_768) + "😀\uFEFFnewest\ré");

        const snapshot = yield* manager.open(openInput());
        expect(snapshot.history).toBe("\uFEFFnewest\ré");
        expect(readRequests).toEqual([15, 10, 5]);
        expect(closedReads).toBe(1);
        expect(Buffer.from(yield* fs.readFile(nextPath)).toString()).toBe("\uFEFFnewest\ré");
        if (source === "legacy") expect(yield* fs.exists(sourcePath)).toBe(false);
        yield* manager.close({ threadId: "thread-1" });
        expect((yield* manager.open(openInput())).history).toBe("\uFEFFnewest\ré");
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
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
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
      // DECRQM/DECRPM, XTVERSION, and kitty-keyboard CSI query/reply traffic.
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      // DECRQSS and XTGETTCAP query/reply traffic in 7-bit DCS form.
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      // The same DCS traffic in 8-bit form.
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      // Setters and cursor movement share final bytes with query families but
      // have visible terminal-state value and must survive replay.
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, 'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[udone\n');
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
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
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

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
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

  it.effect.each(["linux", "darwin", "win32"] as const)(
    "advertises truecolor before the PTY backend on %s without replacing explicit values",
    (platform) =>
      Effect.gen(function* () {
        for (const [parentColor, runtimeColor, expected] of [
          [undefined, undefined, "truecolor"],
          ["", undefined, "truecolor"],
          ["24bit", undefined, "24bit"],
          ["24bit", "", ""],
          [undefined, "", ""],
          ["24bit", "custom", "custom"],
        ] as const) {
          const env = Object.freeze({ COLORTERM: parentColor });
          const { manager, ptyAdapter } = yield* createManager(5, {
            shellResolver: () => "/bin/sh",
            env,
          }).pipe(Effect.provide(layerWithHostPlatform(platform)));
          yield* manager.open(
            openInput({ env: runtimeColor === undefined ? {} : { COLORTERM: runtimeColor } }),
          );
          expect(ptyAdapter.spawnInputs[0]?.env.COLORTERM).toBe(expected);
          expect(env.COLORTERM).toBe(parentColor);
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

  it.effect("expands provider home paths passed to setup terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5);

      yield* manager.open({
        ...openInput(),
        env: {
          CODEX_HOME: "~/.codex-work",
          CLAUDE_CONFIG_DIR: "~/.claude-work",
          CUSTOM_ACCOUNT: "~/leave-this-value-alone",
        },
      });

      const environment = ptyAdapter.spawnInputs[0]?.env;
      expect(environment?.CODEX_HOME).toMatch(/[\\/][.]codex-work$/);
      expect(environment?.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-work$/);
      expect(environment?.CUSTOM_ACCOUNT).toBe("~/leave-this-value-alone");
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
      // XDG_DATA_DIRS keeps the host entries but drops the AppImage share dir.
      expect(spawnInput.env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
      // GSETTINGS_SCHEMA_DIR pointed only at the mount, so it is removed and
      // gsettings falls back to the host schema location.
      expect(spawnInput.env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
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
      const { manager, ptyAdapter } = yield* createManager(5, { env: { FORCE_COLOR: "3" } });
      yield* manager.open(
        openInput({
          env: {
            T3CODE_PROJECT_ROOT: "/repo",
            T3CODE_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.T3CODE_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.T3CODE_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
      assert.equal(spawnInput.env.NO_COLOR, "1");
      assert.equal(spawnInput.env.FORCE_COLOR, "0");
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

  it.effect("preserves the settings failure when provider environment resolution fails", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const settingsCause = new Error("secret store read failed");
      const settingsError = new ServerSettingsError({
        settingsPath: "/test/settings.json",
        operation: "read-secret",
        providerInstanceId,
        environmentVariable: "OPENROUTER_API_KEY",
        cause: settingsCause,
      });
      const serverSettings = ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.fail(settingsError),
        updateSettings: () => Effect.fail(settingsError),
        updateProviderInstance: () => Effect.fail(settingsError),
        withSettingsSnapshot: () => Effect.fail(settingsError),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      });

      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: providerInstanceId,
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderEnvironmentError",
        providerInstanceId,
      });
      expect(error.cause).toBe(settingsError);
      expect(error.message).not.toContain(settingsError.message);
      expect(error.message).not.toContain("OPENROUTER_API_KEY");
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

  it.effect("resolves the Codex default slot", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: undefined,
      });

      expect(environment.CODEX_HOME).toMatch(/[\\/][.]codex-default$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: "~/.codex-default" },
            },
          },
        }),
      ),
    ),
  );

  it.effect("resolves the Claude default slot", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "claudeAgent",
        env: undefined,
      });

      expect(environment.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-default$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: "~/.claude-default" },
            },
          },
        }),
      ),
    ),
  );

  it.effect("resolves an empty Codex default slot with default config", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: { CODEX_HOME: "/inherited/codex-home" },
      });

      expect(environment.CODEX_HOME).toBe("/inherited/codex-home");
    }).pipe(
      Effect.provide(ServerSettings.ServerSettingsService.layerTest({ providerInstances: {} })),
    ),
  );

  it.effect("keeps unknown provider instance ids unavailable after default-slot hydration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex_unknown",
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderInstanceNotFoundError",
        providerInstanceId: "codex_unknown",
      });
    }).pipe(Effect.provide(ServerSettings.ServerSettingsService.layerTest())),
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

  it.effect("restarts with current provider secrets and clears bounded history", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_restart");
      const { manager, ptyAdapter, logsDir } = yield* createManager(2, {
        historyByteLimit: 8,
        resolveProviderInstanceEnvironment: (rawProviderInstanceId, env) =>
          TerminalManager.resolveProviderInstanceTerminalEnvironment({
            serverSettings,
            path,
            rawProviderInstanceId,
            env,
          }),
      });
      const homePath = path.join(logsDir, "codex");
      const updateSecret = (value: string) =>
        serverSettings.updateSettings({
          providerInstances: {
            [providerInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath },
              environment: [{ name: "PROVIDER_SECRET", value, sensitive: true }],
            },
          },
        });
      const input = {
        providerInstanceId,
        env: { CLIENT_FLAG: "1", PROVIDER_SECRET: "client-value" },
      };
      const outputProcessed = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(outputProcessed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* updateSecret("first-secret");
      yield* manager.restart(restartInput(input));
      const firstProcess = ptyAdapter.processes[0]!;
      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("first-secret");
      firstProcess.emitData("discarded\nold-one\nold-two\n");
      yield* Deferred.await(outputProcessed);
      expect((yield* manager.open(openInput(input))).history).toBe("old-two\n");

      yield* updateSecret("second-secret");
      const restarted = yield* manager.restart(restartInput(input));

      expect(firstProcess.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env).toMatchObject({
        PROVIDER_SECRET: "second-secret",
        CODEX_HOME: homePath,
        CLIENT_FLAG: "1",
      });
      expect(restarted.history).toBe("");
      expect(restarted.status).toBe("running");
      expect(restarted).not.toHaveProperty("env");
      expect(restarted).not.toHaveProperty("providerInstanceId");
      const logPath = yield* historyLogPath(logsDir);
      expect(yield* readFileString(logPath)).toBe("");

      ptyAdapter.processes[1]!.emitData("discarded again\nnew-one\nnew-two\n");
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(logPath)).toBe("new-two\n");
    }).pipe(
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-terminal-provider-restart-" }),
          ),
        ),
      ),
    ),
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

  it.effect("fails closed when attaching would create a missing provider terminal", () =>
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

      const error = yield* manager
        .attachStream(openInput({ providerInstanceId }), () => Effect.void)
        .pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
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
