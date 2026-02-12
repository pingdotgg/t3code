import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalThreadInput,
  type TerminalWriteInput,
  terminalCloseInputSchema,
  terminalOpenInputSchema,
  terminalResizeInputSchema,
  terminalThreadInputSchema,
  terminalWriteInputSchema,
} from "@t3tools/contracts";

import { createLogger } from "./logger";
import { NodePtyAdapter, type PtyAdapter, type PtyExitEvent, type PtyProcess } from "./ptyAdapter";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;

export interface TerminalManagerEvents {
  event: [event: TerminalEvent];
}

export interface TerminalManagerOptions {
  logsDir?: string;
  historyLineLimit?: number;
  ptyAdapter?: PtyAdapter;
  shellResolver?: () => string;
}

interface TerminalSessionState {
  threadId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
}

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (process.platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function uniqueShells(shells: Array<string | null>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const shell of shells) {
    if (!shell || shell.length === 0) continue;
    if (seen.has(shell)) continue;
    seen.add(shell);
    ordered.push(shell);
  }
  return ordered;
}

function resolveShellCandidates(shellResolver: () => string): string[] {
  const requested = normalizeShellCommand(shellResolver());

  if (process.platform === "win32") {
    return uniqueShells([
      requested,
      process.env.ComSpec ?? null,
      "powershell.exe",
      "cmd.exe",
    ]);
  }

  return uniqueShells([
    requested,
    normalizeShellCommand(process.env.SHELL),
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
    "zsh",
    "bash",
    "sh",
  ]);
}

function isRetryableShellSpawnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Buffer.from(threadId, "utf8").toString("base64url")}`;
}

export class TerminalManager extends EventEmitter<TerminalManagerEvents> {
  private readonly sessions = new Map<string, TerminalSessionState>();
  private readonly logsDir: string;
  private readonly historyLineLimit: number;
  private readonly ptyAdapter: PtyAdapter;
  private readonly shellResolver: () => string;
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingPersistHistory = new Map<string, string>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly persistDebounceMs: number;
  private readonly logger = createLogger("terminal");

  constructor(options: TerminalManagerOptions = {}) {
    super();
    this.logsDir = options.logsDir ?? path.resolve(process.cwd(), ".logs", "terminals");
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.ptyAdapter = options.ptyAdapter ?? new NodePtyAdapter();
    this.shellResolver = options.shellResolver ?? defaultShellResolver;
    this.persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  async open(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = terminalOpenInputSchema.parse(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const existing = this.sessions.get(input.threadId);
      if (!existing) {
        await this.flushPersistQueue(input.threadId);
        const history = await this.readHistory(input.threadId);
        const session: TerminalSessionState = {
          threadId: input.threadId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history,
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols: input.cols,
          rows: input.rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
        };
        this.sessions.set(input.threadId, session);
        this.startSession(session, input, "started");
        return this.snapshot(session);
      }

      if (existing.cwd !== input.cwd) {
        this.stopProcess(existing);
        existing.cwd = input.cwd;
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.history);
      } else if (existing.status === "exited" || existing.status === "error") {
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.history);
      }

      if (!existing.process) {
        this.startSession(existing, input, "started");
        return this.snapshot(existing);
      }

      if (existing.cols !== input.cols || existing.rows !== input.rows) {
        existing.cols = input.cols;
        existing.rows = input.rows;
        existing.process.resize(input.cols, input.rows);
        existing.updatedAt = new Date().toISOString();
      }

      return this.snapshot(existing);
    });
  }

  async write(raw: TerminalWriteInput): Promise<void> {
    const input = terminalWriteInputSchema.parse(raw);
    const session = this.requireSession(input.threadId);
    if (!session.process || session.status !== "running") {
      throw new Error(`Terminal is not running for thread: ${input.threadId}`);
    }
    session.process.write(input.data);
  }

  async resize(raw: TerminalThreadInput & { cols: number; rows: number }): Promise<void> {
    const input = terminalResizeInputSchema.parse(raw);
    const session = this.requireSession(input.threadId);
    if (!session.process || session.status !== "running") {
      throw new Error(`Terminal is not running for thread: ${input.threadId}`);
    }
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    session.process.resize(input.cols, input.rows);
  }

  async clear(raw: TerminalThreadInput): Promise<void> {
    const input = terminalThreadInputSchema.parse(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.requireSession(input.threadId);
      session.history = "";
      session.updatedAt = new Date().toISOString();
      await this.persistHistory(input.threadId, session.history);
      this.emitEvent({
        type: "cleared",
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = terminalOpenInputSchema.parse(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      let session = this.sessions.get(input.threadId);
      if (!session) {
        session = {
          threadId: input.threadId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols: input.cols,
          rows: input.rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
        };
        this.sessions.set(input.threadId, session);
      } else {
        this.stopProcess(session);
        session.cwd = input.cwd;
      }

      session.history = "";
      await this.persistHistory(input.threadId, session.history);
      this.startSession(session, input, "restarted");
      return this.snapshot(session);
    });
  }

  async close(raw: TerminalCloseInput): Promise<void> {
    const input = terminalCloseInputSchema.parse(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.sessions.get(input.threadId);
      if (session) {
        this.stopProcess(session);
        this.sessions.delete(input.threadId);
      }
      await this.flushPersistQueue(input.threadId);
      if (input.deleteHistory) {
        await this.deleteHistory(input.threadId);
      }
    });
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.stopProcess(session);
    }
    this.sessions.clear();
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    this.pendingPersistHistory.clear();
    this.threadLocks.clear();
    this.persistQueues.clear();
  }

  private startSession(
    session: TerminalSessionState,
    input: TerminalOpenInput,
    eventType: "started" | "restarted",
  ): void {
    this.stopProcess(session);

    session.status = "starting";
    session.cwd = input.cwd;
    session.cols = input.cols;
    session.rows = input.rows;
    session.exitCode = null;
    session.exitSignal = null;
    session.updatedAt = new Date().toISOString();

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    try {
      const shellCandidates = resolveShellCandidates(this.shellResolver);
      let lastSpawnError: unknown = null;

      for (const shell of shellCandidates) {
        try {
          ptyProcess = this.ptyAdapter.spawn({
            shell,
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            env: process.env,
          });
          startedShell = shell;
          break;
        } catch (error) {
          lastSpawnError = error;
          if (!isRetryableShellSpawnError(error)) {
            throw error;
          }
        }
      }

      if (!ptyProcess) {
        const detail =
          lastSpawnError instanceof Error
            ? lastSpawnError.message
            : "Terminal start failed";
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.join(", ")}.`
            : "";
        throw new Error(`${detail}.${tried}`.trim());
      }

      session.process = ptyProcess;
      session.pid = ptyProcess.pid;
      session.status = "running";
      session.updatedAt = new Date().toISOString();
      session.unsubscribeData = ptyProcess.onData((data) => {
        this.onProcessData(session, data);
      });
      session.unsubscribeExit = ptyProcess.onExit((event) => {
        this.onProcessExit(session, event);
      });
      this.emitEvent({
        type: eventType,
        threadId: session.threadId,
        createdAt: new Date().toISOString(),
        snapshot: this.snapshot(session),
      });
    } catch (error) {
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {
          // Ignore kill errors during failed startup cleanup.
        }
      }
      session.status = "error";
      session.pid = null;
      session.process = null;
      session.updatedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : "Terminal start failed";
      this.emitEvent({
        type: "error",
        threadId: session.threadId,
        createdAt: new Date().toISOString(),
        message,
      });
      this.logger.error("failed to start terminal", {
        threadId: session.threadId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }

  private onProcessData(session: TerminalSessionState, data: string): void {
    session.history = capHistory(`${session.history}${data}`, this.historyLineLimit);
    session.updatedAt = new Date().toISOString();
    this.queuePersist(session.threadId, session.history);
    this.emitEvent({
      type: "output",
      threadId: session.threadId,
      createdAt: new Date().toISOString(),
      data,
    });
  }

  private onProcessExit(session: TerminalSessionState, event: PtyExitEvent): void {
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.status = "exited";
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.exitSignal = Number.isInteger(event.signal) ? event.signal : null;
    session.updatedAt = new Date().toISOString();
    this.emitEvent({
      type: "exited",
      threadId: session.threadId,
      createdAt: new Date().toISOString(),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
  }

  private stopProcess(session: TerminalSessionState): void {
    const process = session.process;
    if (!process) return;
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.status = "exited";
    session.updatedAt = new Date().toISOString();
    try {
      process.kill();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to kill terminal process", {
        threadId: session.threadId,
        error: message,
      });
    }
  }

  private cleanupProcessHandles(session: TerminalSessionState): void {
    session.unsubscribeData?.();
    session.unsubscribeData = null;
    session.unsubscribeExit?.();
    session.unsubscribeExit = null;
  }

  private queuePersist(threadId: string, history: string): void {
    this.pendingPersistHistory.set(threadId, history);
    this.schedulePersist(threadId);
  }

  private async persistHistory(threadId: string, history: string): Promise<void> {
    this.clearPersistTimer(threadId);
    this.pendingPersistHistory.delete(threadId);
    await this.enqueuePersistWrite(threadId, history);
  }

  private enqueuePersistWrite(threadId: string, history: string): Promise<void> {
    const task = async () => {
      await fs.promises.writeFile(this.historyPath(threadId), history, "utf8");
    };
    const previous = this.persistQueues.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn("failed to persist terminal history", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(threadId, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(threadId) === next) {
        this.persistQueues.delete(threadId);
      }
      if (this.pendingPersistHistory.has(threadId) && !this.persistTimers.has(threadId)) {
        this.schedulePersist(threadId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(threadId: string): void {
    if (this.persistTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(threadId);
      const pendingHistory = this.pendingPersistHistory.get(threadId);
      if (pendingHistory === undefined) return;
      this.pendingPersistHistory.delete(threadId);
      void this.enqueuePersistWrite(threadId, pendingHistory);
    }, this.persistDebounceMs);
    this.persistTimers.set(threadId, timer);
  }

  private clearPersistTimer(threadId: string): void {
    const timer = this.persistTimers.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(threadId);
  }

  private async readHistory(threadId: string): Promise<string> {
    try {
      const raw = await fs.promises.readFile(this.historyPath(threadId), "utf8");
      const capped = capHistory(raw, this.historyLineLimit);
      if (capped !== raw) {
        await fs.promises.writeFile(this.historyPath(threadId), capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      const raw = await fs.promises.readFile(this.legacyHistoryPath(threadId), "utf8");
      const capped = capHistory(raw, this.historyLineLimit);
      if (capped !== raw) {
        await fs.promises.writeFile(this.legacyHistoryPath(threadId), capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private async deleteHistory(threadId: string): Promise<void> {
    try {
      await Promise.all([
        fs.promises.rm(this.historyPath(threadId), { force: true }),
        fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }),
      ]);
    } catch (error) {
      this.logger.warn("failed to delete terminal history", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushPersistQueue(threadId: string): Promise<void> {
    this.clearPersistTimer(threadId);

    while (true) {
      const pendingHistory = this.pendingPersistHistory.get(threadId);
      if (pendingHistory !== undefined) {
        this.pendingPersistHistory.delete(threadId);
        await this.enqueuePersistWrite(threadId, pendingHistory);
      }

      const pending = this.persistQueues.get(threadId);
      if (!pending) {
        return;
      }
      await pending.catch(() => undefined);
    }
  }

  private async assertValidCwd(cwd: string): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Terminal cwd does not exist: ${cwd}`, { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${cwd}`);
    }
  }

  private requireSession(threadId: string): TerminalSessionState {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`Unknown terminal thread: ${threadId}`);
    }
    return session;
  }

  private snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
    return {
      threadId: session.threadId,
      cwd: session.cwd,
      status: session.status,
      pid: session.pid,
      history: session.history,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      updatedAt: session.updatedAt,
    };
  }

  private emitEvent(event: TerminalEvent): void {
    this.emit("event", event);
  }

  private historyPath(threadId: string): string {
    return path.join(this.logsDir, `${toSafeThreadId(threadId)}.log`);
  }

  private legacyHistoryPath(threadId: string): string {
    return path.join(this.logsDir, `${legacySafeThreadId(threadId)}.log`);
  }

  private async runWithThreadLock<T>(
    threadId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }
}
