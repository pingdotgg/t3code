import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@t3tools/contracts";
import { Effect, Encoding, Exit, Layer, ManagedRuntime, Ref, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { TerminalManager } from "../Services/Manager";
import {
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  PtySpawnError,
} from "../Services/PTY";
import { makeTerminalManagerWithOptions } from "./Manager";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;

  constructor(readonly pid: number) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
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

  onExit(callback: (event: PtyExitEvent) => void): () => void {
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

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  constructor(private readonly mode: "sync" | "async" = "sync") {}

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
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
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 800): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      Promise.resolve(predicate())
        .then((done) => {
          if (done) {
            resolve();
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error("Timed out waiting for condition"));
            return;
          }
          setTimeout(poll, 15);
        })
        .catch(reject);
    };
    void poll();
  });
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

function historyLogName(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`;
}

function historyLogPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, historyLogName(threadId));
}

function multiTerminalHistoryLogPath(
  logsDir: string,
  threadId = "thread-1",
  terminalId = "default",
): string {
  return path.join(logsDir, multiTerminalHistoryLogName(threadId, terminalId));
}

async function makeManager(
  historyLineLimit = 5,
  options: {
    shellResolver?: () => string;
    subprocessChecker?: (terminalPid: number) => Effect.Effect<boolean>;
    subprocessPollIntervalMs?: number;
    processKillGraceMs?: number;
    maxRetainedInactiveSessions?: number;
    ptyAdapter?: FakePtyAdapter;
  } = {},
) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-terminal-"));
  const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
  const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

  const terminalLayer = Layer.effect(
    TerminalManager,
    makeTerminalManagerWithOptions({
      logsDir,
      historyLineLimit,
      ptyAdapter,
      ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
      ...(options.subprocessChecker !== undefined
        ? { subprocessChecker: options.subprocessChecker }
        : {}),
      ...(options.subprocessPollIntervalMs !== undefined
        ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
        : {}),
      ...(options.processKillGraceMs !== undefined
        ? { processKillGraceMs: options.processKillGraceMs }
        : {}),
      ...(options.maxRetainedInactiveSessions !== undefined
        ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
        : {}),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

  const runtime = ManagedRuntime.make(terminalLayer);
  const manager = await runtime.runPromise(Effect.service(TerminalManager));
  const eventsRef = await Effect.runPromise(Ref.make<TerminalEvent[]>([]));
  const eventScope = await Effect.runPromise(Scope.make("sequential"));
  await runtime.runPromise(
    Stream.runForEach(manager.streamEvents, (event) =>
      Ref.update(eventsRef, (events) => [...events, event]),
    ).pipe(Effect.forkIn(eventScope)),
  );

  return {
    baseDir,
    logsDir,
    ptyAdapter,
    runtime,
    manager,
    eventsRef,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    getEvents: () => Effect.runPromise(Ref.get(eventsRef)),
    dispose: async () => {
      await Effect.runPromise(Scope.close(eventScope, Exit.void));
      await runtime.dispose();
    },
  };
}

describe("TerminalManager", () => {
  const runtimes: Array<{ dispose: () => Promise<void> }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0, runtimes.length)) {
      await runtime.dispose();
    }
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createManager(
    historyLineLimit = 5,
    options: {
      shellResolver?: () => string;
      subprocessChecker?: (terminalPid: number) => Effect.Effect<boolean>;
      subprocessPollIntervalMs?: number;
      processKillGraceMs?: number;
      maxRetainedInactiveSessions?: number;
      ptyAdapter?: FakePtyAdapter;
    } = {},
  ) {
    const result = await makeManager(historyLineLimit, options);
    runtimes.push({ dispose: result.dispose });
    tempDirs.push(result.baseDir);
    return result;
  }

  it("spawns lazily and reuses running terminal per thread", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    const [first, second] = await Promise.all([
      run(manager.open(openInput())),
      run(manager.open(openInput())),
    ]);
    const third = await run(manager.open(openInput()));

    expect(first.threadId).toBe("thread-1");
    expect(first.terminalId).toBe("default");
    expect(second.threadId).toBe("thread-1");
    expect(third.threadId).toBe("thread-1");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
  });

  it("supports asynchronous PTY spawn effects", async () => {
    const { manager, ptyAdapter, run } = await createManager(5, {
      ptyAdapter: new FakePtyAdapter("async"),
    });

    const snapshot = await run(manager.open(openInput()));

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(ptyAdapter.processes).toHaveLength(1);
  });

  it("forwards write and resize to active pty process", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await run(
      manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "ls\n" }),
    );
    await run(
      manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      }),
    );

    expect(process.writes).toEqual(["ls\n"]);
    expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
  });

  it("resizes running terminal on open when a different size is requested", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(manager.open(openInput({ cols: 100, rows: 24 })));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    const reopened = await run(manager.open(openInput({ cols: 120, rows: 30 })));

    expect(reopened.status).toBe("running");
    expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
  });

  it("supports multiple terminals per thread independently", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(manager.open(openInput({ terminalId: "default" })));
    await run(manager.open(openInput({ terminalId: "term-2" })));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    await run(manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" }));
    await run(manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" }));

    expect(first.writes).toEqual(["pwd\n"]);
    expect(second.writes).toEqual(["ls\n"]);
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
  });

  it("clears transcript and emits cleared event", async () => {
    const { manager, ptyAdapter, logsDir, run, getEvents } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("hello\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await run(manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }));
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    const events = await getEvents();
    expect(events.some((event) => event.type === "cleared")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "cleared" &&
          event.threadId === "thread-1" &&
          event.terminalId === "default",
      ),
    ).toBe(true);
  });

  it("restarts terminal with empty transcript and respawns pty", async () => {
    const { manager, ptyAdapter, logsDir, run } = await createManager();
    await run(manager.open(openInput()));
    const firstProcess = ptyAdapter.processes[0];
    expect(firstProcess).toBeDefined();
    if (!firstProcess) return;
    firstProcess.emitData("before restart\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    const snapshot = await run(manager.restart(restartInput()));
    expect(snapshot.history).toBe("");
    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");
  });

  it("emits exited event and reopens with clean transcript after exit", async () => {
    const { manager, ptyAdapter, logsDir, run, getEvents } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("old data\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    process.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(async () => (await getEvents()).some((event) => event.type === "exited"));
    const reopened = await run(manager.open(openInput()));

    expect(reopened.history).toBe("");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("");
  });

  it("ignores trailing writes after terminal exit", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitExit({ exitCode: 0, signal: 0 });

    await expect(
      run(manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "\r" })),
    ).resolves.toBeUndefined();
    expect(process.writes).toEqual([]);
  });

  it("emits subprocess activity events when child-process state changes", async () => {
    let hasRunningSubprocess = false;
    const { manager, run, getEvents } = await createManager(5, {
      subprocessChecker: () => Effect.succeed(hasRunningSubprocess),
      subprocessPollIntervalMs: 20,
    });

    await run(manager.open(openInput()));
    await waitFor(async () => (await getEvents()).some((event) => event.type === "started"));
    expect((await getEvents()).some((event) => event.type === "activity")).toBe(false);

    hasRunningSubprocess = true;
    await waitFor(
      async () =>
        (await getEvents()).some(
          (event) => event.type === "activity" && event.hasRunningSubprocess === true,
        ),
      1_200,
    );

    hasRunningSubprocess = false;
    await waitFor(
      async () =>
        (await getEvents()).some(
          (event) => event.type === "activity" && event.hasRunningSubprocess === false,
        ),
      1_200,
    );
  });

  it("caps persisted history to configured line limit", async () => {
    const { manager, ptyAdapter, run } = await createManager(3);
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("line1\nline2\nline3\nline4\n");
    await run(manager.close({ threadId: "thread-1" }));

    const reopened = await run(manager.open(openInput()));
    const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
    expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
  });

  it("strips replay-unsafe terminal query and reply sequences from persisted history", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("prompt ");
    process.emitData("\u001b[32mok\u001b[0m ");
    process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
    process.emitData("\u001b[1;1R");
    process.emitData("done\n");

    await run(manager.close({ threadId: "thread-1" }));

    const reopened = await run(manager.open(openInput()));
    expect(reopened.history).toBe("prompt \u001b[32mok\u001b[0m done\n");
  });

  it("preserves clear and style control sequences while dropping chunk-split query traffic", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before clear\n");
    process.emitData("\u001b[H\u001b[2J");
    process.emitData("prompt ");
    process.emitData("\u001b]11;");
    process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
    process.emitData("R\u001b[36mdone\u001b[0m\n");

    await run(manager.close({ threadId: "thread-1" }));

    const reopened = await run(manager.open(openInput()));
    expect(reopened.history).toBe(
      "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
    );
  });

  it("does not leak final bytes from ESC sequences with intermediate bytes", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before ");
    process.emitData("\u001b(B");
    process.emitData("after\n");

    await run(manager.close({ threadId: "thread-1" }));

    const reopened = await run(manager.open(openInput()));
    expect(reopened.history).toBe("before \u001b(Bafter\n");
  });

  it("preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before ");
    process.emitData("\u001b(");
    process.emitData("Bafter\n");

    await run(manager.close({ threadId: "thread-1" }));

    const reopened = await run(manager.open(openInput()));
    expect(reopened.history).toBe("before \u001b(Bafter\n");
  });

  it("deletes history file when close(deleteHistory=true)", async () => {
    const { manager, ptyAdapter, logsDir, run } = await createManager();
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("bye\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    await run(manager.close({ threadId: "thread-1", deleteHistory: true }));
    expect(fs.existsSync(historyLogPath(logsDir))).toBe(false);
  });

  it("closes all terminals for a thread when close omits terminalId", async () => {
    const { manager, ptyAdapter, logsDir, run } = await createManager();
    await run(manager.open(openInput({ terminalId: "default" })));
    await run(manager.open(openInput({ terminalId: "sidecar" })));
    const defaultProcess = ptyAdapter.processes[0];
    const sidecarProcess = ptyAdapter.processes[1];
    expect(defaultProcess).toBeDefined();
    expect(sidecarProcess).toBeDefined();
    if (!defaultProcess || !sidecarProcess) return;

    defaultProcess.emitData("default\n");
    sidecarProcess.emitData("sidecar\n");
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default")));
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar")));

    await run(manager.close({ threadId: "thread-1", deleteHistory: true }));

    expect(defaultProcess.killed).toBe(true);
    expect(sidecarProcess.killed).toBe(true);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default"))).toBe(false);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar"))).toBe(false);
  });

  it("escalates terminal shutdown to SIGKILL when process does not exit in time", async () => {
    const { manager, ptyAdapter, run } = await createManager(5, { processKillGraceMs: 10 });
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await run(manager.close({ threadId: "thread-1" }));
    await waitFor(() => process.killSignals.includes("SIGKILL"));

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).toContain("SIGKILL");
  });

  it("evicts oldest inactive terminal sessions when retention limit is exceeded", async () => {
    const { manager, ptyAdapter, run, logsDir, getEvents } = await createManager(5, {
      maxRetainedInactiveSessions: 1,
    });

    await run(manager.open(openInput({ threadId: "thread-1" })));
    await run(manager.open(openInput({ threadId: "thread-2" })));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    first.emitData("first-history\n");
    second.emitData("second-history\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir, "thread-1")));
    first.emitExit({ exitCode: 0, signal: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    second.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(async () => {
      const events = await getEvents();
      return events.filter((event) => event.type === "exited").length === 2;
    });

    const reopenedSecond = await run(manager.open(openInput({ threadId: "thread-2" })));
    const reopenedFirst = await run(manager.open(openInput({ threadId: "thread-1" })));

    expect(reopenedFirst.history).toBe("first-history\n");
    expect(reopenedSecond.history).toBe("");
  });

  it("migrates legacy transcript filenames to terminal-scoped history path on open", async () => {
    const { manager, logsDir, run } = await createManager();
    const legacyPath = path.join(logsDir, "thread-1.log");
    const nextPath = historyLogPath(logsDir);
    fs.writeFileSync(legacyPath, "legacy-line\n", "utf8");

    const snapshot = await run(manager.open(openInput()));

    expect(snapshot.history).toBe("legacy-line\n");
    expect(fs.existsSync(nextPath)).toBe(true);
    expect(fs.readFileSync(nextPath, "utf8")).toBe("legacy-line\n");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("retries with fallback shells when preferred shell spawn fails", async () => {
    const { manager, ptyAdapter, run } = await createManager(5, {
      shellResolver: () => "/definitely/missing-shell -l",
    });
    ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

    const snapshot = await run(manager.open(openInput()));

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
    expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/definitely/missing-shell");

    if (process.platform === "win32") {
      expect(
        ptyAdapter.spawnInputs.some(
          (input) => input.shell === "cmd.exe" || input.shell === "powershell.exe",
        ),
      ).toBe(true);
    } else {
      expect(
        ptyAdapter.spawnInputs
          .slice(1)
          .some((input) => input.shell !== "/definitely/missing-shell"),
      ).toBe(true);
    }
  });

  it("filters app runtime env variables from terminal sessions", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string | undefined) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      if (value === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("PORT", "5173");
    setEnv("T3CODE_PORT", "3773");
    setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    setEnv("TEST_TERMINAL_KEEP", "keep-me");

    try {
      const { manager, ptyAdapter, run } = await createManager();
      await run(manager.open(openInput()));
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    } finally {
      restoreEnv();
    }
  });

  it("injects runtime env overrides into spawned terminals", async () => {
    const { manager, ptyAdapter, run } = await createManager();
    await run(
      manager.open(
        openInput({
          env: {
            T3CODE_PROJECT_ROOT: "/repo",
            T3CODE_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
          },
        }),
      ),
    );
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.env.T3CODE_PROJECT_ROOT).toBe("/repo");
    expect(spawnInput.env.T3CODE_WORKTREE_PATH).toBe("/repo/worktree-a");
    expect(spawnInput.env.CUSTOM_FLAG).toBe("1");
  });

  it("starts zsh with prompt spacer disabled to avoid `%` end markers", async () => {
    if (process.platform === "win32") return;
    const { manager, ptyAdapter, run } = await createManager(5, {
      shellResolver: () => "/bin/zsh",
    });
    await run(manager.open(openInput()));
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
  });

  it("bridges PTY callbacks back into Effect-managed event streaming", async () => {
    const { manager, ptyAdapter, run, getEvents } = await createManager(5, {
      ptyAdapter: new FakePtyAdapter("async"),
    });

    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("hello from callback\n");

    await waitFor(
      async () =>
        (await getEvents()).some(
          (event) => event.type === "output" && event.data === "hello from callback\n",
        ),
      1_200,
    );
  });

  it("scoped runtime shutdown stops active terminals cleanly", async () => {
    const result = await createManager(5, { processKillGraceMs: 10 });
    const { manager, ptyAdapter, run, dispose } = result;
    await run(manager.open(openInput()));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await dispose();
    await waitFor(() => process.killSignals.includes("SIGKILL"));

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).toContain("SIGKILL");
  });
});
