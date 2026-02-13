import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_TERMINAL_ID, type TerminalEvent, type TerminalOpenInput } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { PtyAdapter, PtyExitEvent, PtyProcess, PtySpawnInput } from "./ptyAdapter";
import { TerminalManager } from "./terminalManager";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
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

  kill(): void {
    this.killed = true;
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

class FakePtyAdapter implements PtyAdapter {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  spawn(input: PtySpawnInput): PtyProcess {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      throw failure;
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    return process;
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 800): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function historyLogName(threadId: string): string {
  return `terminal_${Buffer.from(threadId, "utf8").toString("base64url")}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Buffer.from(threadId, "utf8").toString("base64url")}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Buffer.from(terminalId, "utf8").toString("base64url")}.log`;
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

describe("TerminalManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeManager(
    historyLineLimit = 5,
    options: { shellResolver?: () => string } = {},
  ) {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-terminal-"));
    tempDirs.push(logsDir);
    const ptyAdapter = new FakePtyAdapter();
    const manager = new TerminalManager({
      logsDir,
      ptyAdapter,
      historyLineLimit,
      shellResolver: options.shellResolver ?? (() => "/bin/bash"),
    });
    return { logsDir, ptyAdapter, manager };
  }

  it("spawns lazily and reuses running terminal per thread", async () => {
    const { manager, ptyAdapter } = makeManager();
    const [first, second] = await Promise.all([manager.open(openInput()), manager.open(openInput())]);
    const third = await manager.open(openInput());

    expect(first.threadId).toBe("thread-1");
    expect(first.terminalId).toBe("default");
    expect(second.threadId).toBe("thread-1");
    expect(third.threadId).toBe("thread-1");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    manager.dispose();
  });

  it("forwards write and resize to active pty process", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.write({ threadId: "thread-1", data: "ls\n" });
    await manager.resize({ threadId: "thread-1", cols: 120, rows: 30 });

    expect(process.writes).toEqual(["ls\n"]);
    expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);

    manager.dispose();
  });

  it("supports multiple terminals per thread with isolated sessions", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "term-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    await manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
    await manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

    expect(first.writes).toEqual(["pwd\n"]);
    expect(second.writes).toEqual(["ls\n"]);
    expect(ptyAdapter.spawnInputs).toHaveLength(2);

    manager.dispose();
  });

  it("clears transcript and emits cleared event", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("hello\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await manager.clear({ threadId: "thread-1" });
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    expect(events.some((event) => event.type === "cleared")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "cleared" &&
          event.threadId === "thread-1" &&
          event.terminalId === "default",
      ),
    ).toBe(true);

    manager.dispose();
  });

  it("restarts terminal with empty transcript and respawns pty", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const firstProcess = ptyAdapter.processes[0];
    expect(firstProcess).toBeDefined();
    if (!firstProcess) return;
    firstProcess.emitData("before restart\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    const snapshot = await manager.restart(openInput());
    expect(snapshot.history).toBe("");
    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    manager.dispose();
  });

  it("emits exited event and reopens with clean transcript after exit", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("old data\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    process.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => events.some((event) => event.type === "exited"));
    const reopened = await manager.open(openInput());

    expect(reopened.history).toBe("");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("");

    manager.dispose();
  });

  it("caps persisted history to configured line limit", async () => {
    const { manager, ptyAdapter } = makeManager(3);
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("line1\nline2\nline3\nline4\n");
    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
    expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);

    manager.dispose();
  });

  it("deletes history file when close(deleteHistory=true)", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("bye\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    await manager.close({ threadId: "thread-1", deleteHistory: true });
    expect(fs.existsSync(historyLogPath(logsDir))).toBe(false);

    manager.dispose();
  });

  it("closes all terminals for a thread when close omits terminalId", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "sidecar" }));
    const defaultProcess = ptyAdapter.processes[0];
    const sidecarProcess = ptyAdapter.processes[1];
    expect(defaultProcess).toBeDefined();
    expect(sidecarProcess).toBeDefined();
    if (!defaultProcess || !sidecarProcess) return;

    defaultProcess.emitData("default\n");
    sidecarProcess.emitData("sidecar\n");
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default")));
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar")));

    await manager.close({ threadId: "thread-1", deleteHistory: true });

    expect(defaultProcess.killed).toBe(true);
    expect(sidecarProcess.killed).toBe(true);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default"))).toBe(
      false,
    );
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar"))).toBe(
      false,
    );

    manager.dispose();
  });

  it("migrates legacy transcript filenames to terminal-scoped history path on open", async () => {
    const { manager, logsDir } = makeManager();
    const legacyPath = path.join(logsDir, "thread-1.log");
    const nextPath = historyLogPath(logsDir);
    fs.writeFileSync(legacyPath, "legacy-line\n", "utf8");

    const snapshot = await manager.open(openInput());

    expect(snapshot.history).toBe("legacy-line\n");
    expect(fs.existsSync(nextPath)).toBe(true);
    expect(fs.readFileSync(nextPath, "utf8")).toBe("legacy-line\n");
    expect(fs.existsSync(legacyPath)).toBe(false);

    manager.dispose();
  });

  it("retries with fallback shells when preferred shell spawn fails", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellResolver: () => "/definitely/missing-shell -l",
    });
    ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

    const snapshot = await manager.open(openInput());

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
        ptyAdapter.spawnInputs.some((input) =>
          ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].includes(
            input.shell,
          ),
        ),
      ).toBe(true);
    }

    manager.dispose();
  });
});
