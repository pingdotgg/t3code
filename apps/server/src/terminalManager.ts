import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalWriteInput,
  terminalClearInputSchema,
  terminalCloseInputSchema,
  terminalOpenInputSchema,
  terminalResizeInputSchema,
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
  terminalId: string;
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

function toSafeTerminalId(terminalId: string): string {
  return Buffer.from(terminalId, "utf8").toString("base64url");
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
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

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      const existing = this.sessions.get(sessionKey);
      if (!existing) {
        await this.flushPersistQueue(input.threadId, input.terminalId);
        const history = await this.readHistory(input.threadId, input.terminalId);
        const session: TerminalSessionState = {
          threadId: input.threadId,
          terminalId: input.terminalId,
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
        this.sessions.set(sessionKey, session);
        this.startSession(session, input, "started");
        return this.snapshot(session);
      }

      if (existing.cwd !== input.cwd) {
        this.stopProcess(existing);
        existing.cwd = input.cwd;
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
      } else if (existing.status === "exited" || existing.status === "error") {
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
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
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.process.write(input.data);
  }

  async resize(raw: TerminalResizeInput): Promise<void> {
    const input = terminalResizeInputSchema.parse(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    session.process.resize(input.cols, input.rows);
  }

  async clear(raw: TerminalClearInput): Promise<void> {
    const input = terminalClearInputSchema.parse(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.requireSession(input.threadId, input.terminalId);
      session.history = "";
      session.updatedAt = new Date().toISOString();
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      this.emitEvent({
        type: "cleared",
        threadId: input.threadId,
        terminalId: input.terminalId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = terminalOpenInputSchema.parse(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      let session = this.sessions.get(sessionKey);
      if (!session) {
        session = {
          threadId: input.threadId,
          terminalId: input.terminalId,
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
        this.sessions.set(sessionKey, session);
      } else {
        this.stopProcess(session);
        session.cwd = input.cwd;
      }

      session.history = "";
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      this.startSession(session, input, "restarted");
      return this.snapshot(session);
    });
  }

  async close(raw: TerminalCloseInput): Promise<void> {
    const input = terminalCloseInputSchema.parse(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      if (input.terminalId) {
        await this.closeSession(
          input.threadId,
          input.terminalId,
          input.deleteHistory === true,
        );
        return;
      }

      const threadSessions = this.sessionsForThread(input.threadId);
      for (const session of threadSessions) {
        this.stopProcess(session);
        this.sessions.delete(toSessionKey(session.threadId, session.terminalId));
      }
      await Promise.all(
        threadSessions.map((session) =>
          this.flushPersistQueue(session.threadId, session.terminalId),
        ),
      );

      if (input.deleteHistory) {
        await this.deleteAllHistoryForThread(input.threadId);
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
        terminalId: session.terminalId,
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
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        message,
      });
      this.logger.error("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }

  private onProcessData(session: TerminalSessionState, data: string): void {
    session.history = capHistory(`${session.history}${data}`, this.historyLineLimit);
    session.updatedAt = new Date().toISOString();
    this.queuePersist(session.threadId, session.terminalId, session.history);
    this.emitEvent({
      type: "output",
      threadId: session.threadId,
      terminalId: session.terminalId,
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
      terminalId: session.terminalId,
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
        terminalId: session.terminalId,
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

  private queuePersist(threadId: string, terminalId: string, history: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.pendingPersistHistory.set(persistenceKey, history);
    this.schedulePersist(threadId, terminalId);
  }

  private async persistHistory(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);
    this.pendingPersistHistory.delete(persistenceKey);
    await this.enqueuePersistWrite(threadId, terminalId, history);
  }

  private enqueuePersistWrite(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const task = async () => {
      await fs.promises.writeFile(this.historyPath(threadId, terminalId), history, "utf8");
    };
    const previous = this.persistQueues.get(persistenceKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn("failed to persist terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(persistenceKey, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(persistenceKey) === next) {
        this.persistQueues.delete(persistenceKey);
      }
      if (
        this.pendingPersistHistory.has(persistenceKey) &&
        !this.persistTimers.has(persistenceKey)
      ) {
        this.schedulePersist(threadId, terminalId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    if (this.persistTimers.has(persistenceKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(persistenceKey);
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory === undefined) return;
      this.pendingPersistHistory.delete(persistenceKey);
      void this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
    }, this.persistDebounceMs);
    this.persistTimers.set(persistenceKey, timer);
  }

  private clearPersistTimer(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const timer = this.persistTimers.get(persistenceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(persistenceKey);
  }

  private async readHistory(threadId: string, terminalId: string): Promise<string> {
    const historyPath = this.historyPath(threadId, terminalId);
    try {
      const raw = await fs.promises.readFile(historyPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);
      if (capped !== raw) {
        await fs.promises.writeFile(historyPath, capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
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

  private async deleteHistory(threadId: string, terminalId: string): Promise<void> {
    const deletions = [fs.promises.rm(this.historyPath(threadId, terminalId), { force: true })];
    if (terminalId === DEFAULT_TERMINAL_ID) {
      deletions.push(fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }));
    }
    try {
      await Promise.all(deletions);
    } catch (error) {
      this.logger.warn("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushPersistQueue(threadId: string, terminalId: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);

    while (true) {
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory !== undefined) {
        this.pendingPersistHistory.delete(persistenceKey);
        await this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
      }

      const pending = this.persistQueues.get(persistenceKey);
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

  private async closeSession(
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ): Promise<void> {
    const key = toSessionKey(threadId, terminalId);
    const session = this.sessions.get(key);
    if (session) {
      this.stopProcess(session);
      this.sessions.delete(key);
    }
    await this.flushPersistQueue(threadId, terminalId);
    if (deleteHistory) {
      await this.deleteHistory(threadId, terminalId);
    }
  }

  private sessionsForThread(threadId: string): TerminalSessionState[] {
    return [...this.sessions.values()].filter((session) => session.threadId === threadId);
  }

  private async deleteAllHistoryForThread(threadId: string): Promise<void> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    try {
      const entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
      const removals = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        )
        .map((name) => fs.promises.rm(path.join(this.logsDir, name), { force: true }));
      await Promise.all(removals);
    } catch (error) {
      this.logger.warn("failed to delete terminal histories for thread", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireSession(threadId: string, terminalId: string): TerminalSessionState {
    const session = this.sessions.get(toSessionKey(threadId, terminalId));
    if (!session) {
      throw new Error(`Unknown terminal thread: ${threadId}, terminal: ${terminalId}`);
    }
    return session;
  }

  private snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
    return {
      threadId: session.threadId,
      terminalId: session.terminalId,
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

  private historyPath(threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}.log`);
    }
    return path.join(this.logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
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
