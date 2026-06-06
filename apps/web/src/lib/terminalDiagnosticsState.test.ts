import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTerminalDiagnosticsSnapshot,
  recordTerminalDiagnostic,
  recordTerminalInputReceived,
  recordTerminalWriteError,
  recordTerminalWriteStart,
  recordTerminalWriteSuccess,
  resetTerminalDiagnosticsForTests,
  summarizeTerminalInput,
} from "./terminalDiagnosticsState";

describe("terminalDiagnosticsState", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("environment-terminal-diagnostics"),
    threadId: ThreadId.make("thread-terminal-diagnostics"),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetTerminalDiagnosticsForTests();
  });

  it("summarizes terminal input without preserving typed text", () => {
    expect(summarizeTerminalInput("npm run secret-command")).toEqual({
      byteLength: 22,
      charLength: 22,
      codePointLength: 22,
      controlCodeCount: 0,
      escapeCount: 0,
      inputKind: "paste-or-composition",
      newlineCount: 0,
      printableCodePointCount: 22,
    });

    expect(summarizeTerminalInput("\r").inputKind).toBe("enter");
    expect(summarizeTerminalInput("\u001b[A").inputKind).toBe("arrow");
  });

  it("records input and write lifecycle metadata without command contents", () => {
    recordTerminalInputReceived({
      data: "npm run secret-command",
      source: "xterm-on-data",
      terminalId: "default",
      threadRef,
    });
    const attempt = recordTerminalWriteStart({
      data: "npm run secret-command",
      source: "xterm-on-data",
      terminalId: "default",
      threadRef,
    });
    recordTerminalWriteSuccess({
      attempt,
      terminalId: "default",
      threadRef,
    });

    const snapshot = getTerminalDiagnosticsSnapshot({ threadRef });

    expect(snapshot.countsByKind["input-received"]).toBe(1);
    expect(snapshot.countsByKind["write-start"]).toBe(1);
    expect(snapshot.countsByKind["write-success"]).toBe(1);
    expect(snapshot.pendingWrites).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("secret-command");
  });

  it("keeps pending writes until success or error is recorded", () => {
    const attempt = recordTerminalWriteStart({
      data: "\r",
      source: "accessory-key",
      terminalId: "default",
      threadRef,
    });

    expect(getTerminalDiagnosticsSnapshot({ threadRef }).pendingWrites).toHaveLength(1);

    recordTerminalWriteError({
      attempt,
      error: new Error("write failed"),
      terminalId: "default",
      threadRef,
    });

    const snapshot = getTerminalDiagnosticsSnapshot({ threadRef });
    expect(snapshot.pendingWrites).toEqual([]);
    expect(snapshot.countsByKind["write-error"]).toBe(1);
    expect(JSON.stringify(snapshot)).toContain("write failed");
  });

  it("summarizes terminal recovery state without preserving typed input", () => {
    recordTerminalDiagnostic(threadRef, "default", "open-start", { reason: "mount" });
    recordTerminalDiagnostic(threadRef, "default", "open-error", {
      message: "All fibers interrupted without error",
      transientTransport: true,
    });
    recordTerminalDiagnostic(threadRef, "default", "open-retry-scheduled", {
      attempt: 1,
      delayMs: 250,
    });
    recordTerminalInputReceived({
      data: "npm run secret-command",
      source: "xterm-on-data",
      terminalId: "default",
      threadRef,
    });
    const attempt = recordTerminalWriteStart({
      data: "npm run secret-command",
      source: "xterm-on-data",
      terminalId: "default",
      threadRef,
    });
    recordTerminalWriteSuccess({
      attempt,
      terminalId: "default",
      threadRef,
    });
    recordTerminalDiagnostic(threadRef, "default", "terminal-resync-started", {
      reason: "toolbar",
    });
    recordTerminalDiagnostic(threadRef, "default", "terminal-resync-failed", {
      message: "Terminal resync failed",
    });
    recordTerminalDiagnostic(threadRef, "default", "terminal-restart-clicked", {
      reason: "toolbar",
    });
    recordTerminalDiagnostic(threadRef, "default", "terminal-restart-confirmed", {
      reason: "toolbar",
    });

    const snapshot = getTerminalDiagnosticsSnapshot({ threadRef });

    expect(snapshot.countsByKind["open-retry-scheduled"]).toBe(1);
    expect(snapshot.countsByKind["terminal-resync-started"]).toBe(1);
    expect(snapshot.countsByKind["terminal-resync-failed"]).toBe(1);
    expect(snapshot.countsByKind["terminal-restart-confirmed"]).toBe(1);
    expect(snapshot.terminalRecoveryById.default).toMatchObject({
      currentRecoveryState: "manual-restarting",
      terminalId: "default",
      writesSinceLastOutput: 1,
    });
    expect(snapshot.terminalRecoveryById.default?.lastOpenError?.message).toBe(
      "All fibers interrupted without error",
    );
    expect(JSON.stringify(snapshot)).not.toContain("secret-command");
  });
});
