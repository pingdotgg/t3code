import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import {
  recordTerminalDiagnostic,
  recordTerminalInputReceived,
  recordTerminalWriteStart,
  recordTerminalWriteSuccess,
  resetTerminalDiagnosticsForTests,
} from "../lib/terminalDiagnosticsState";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  recordWsHeartbeatPing,
  recordWsHeartbeatPong,
  resetWsConnectionStateForTests,
} from "./wsConnectionState";
import { buildWebSocketDiagnosticsReport } from "./webSocketDiagnostics";

describe("webSocketDiagnostics", () => {
  const environmentId = EnvironmentId.make("environment-diagnostics");
  const threadId = ThreadId.make("thread-diagnostics");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetWsConnectionStateForTests();
    resetTerminalDiagnosticsForTests();
    useStore.setState({
      accountRateLimitsByInstanceId: {},
      activeEnvironmentId: environmentId,
      environmentStateById: {},
    });
    useTerminalStateStore.setState({
      nextTerminalEventId: 1,
      terminalEventEntriesByKey: {},
      terminalLaunchContextByThreadKey: {},
      terminalStateByThreadKey: {},
    });
  });

  it("builds a redacted markdown note with websocket and terminal state", () => {
    recordWsConnectionAttempt("ws://localhost:3020/?token=secret-token");
    recordWsConnectionOpened();
    recordWsHeartbeatPing();
    recordWsHeartbeatPong();
    useTerminalStateStore.getState().applyTerminalEvent(
      { environmentId, threadId },
      {
        createdAt: "2026-04-03T20:30:01.000Z",
        snapshot: {
          cwd: "/workspace/project",
          exitCode: null,
          exitSignal: null,
          history: "terminal output that should not appear",
          pid: 123,
          status: "running",
          terminalId: "default",
          threadId,
          updatedAt: "2026-04-03T20:30:01.000Z",
          worktreePath: null,
        },
        terminalId: "default",
        threadId,
        type: "started",
      },
    );
    recordTerminalInputReceived({
      data: "npm run command-that-must-not-leak",
      source: "xterm-on-data",
      terminalId: "default",
      threadRef: { environmentId, threadId },
    });
    const writeAttempt = recordTerminalWriteStart({
      data: "npm run command-that-must-not-leak",
      source: "xterm-on-data",
      terminalId: "default",
      threadRef: { environmentId, threadId },
    });
    recordTerminalWriteSuccess({
      attempt: writeAttempt,
      terminalId: "default",
      threadRef: { environmentId, threadId },
    });
    recordTerminalDiagnostic({ environmentId, threadId }, "default", "terminal-resync-started", {
      reason: "toolbar",
    });
    recordTerminalDiagnostic({ environmentId, threadId }, "default", "terminal-resync-failed", {
      message: "Terminal resync failed",
    });
    recordTerminalDiagnostic({ environmentId, threadId }, "default", "terminal-restart-confirmed", {
      reason: "toolbar",
    });

    const report = buildWebSocketDiagnosticsReport({
      activeProjectName: "project",
      activeThreadEnvironmentId: environmentId,
      activeThreadId: threadId,
      activeThreadTitle: "Diagnostics thread",
      diffOpen: false,
      fileExplorerAvailable: true,
      fileExplorerOpen: false,
      gitCwd: "/workspace/project",
      openInCwd: "/workspace/project",
      sourceControlOpen: false,
      terminalAvailable: true,
      terminalOpen: true,
    });

    expect(report).toContain("# WebSocket diagnostics note");
    expect(report).toContain("## WebSocket summary");
    expect(report).toContain("## Terminal client summary");
    expect(report).toContain("## Raw snapshot");
    expect(report).toContain('"uiState": "connected"');
    expect(report).toContain('"heartbeatPingCount": 1');
    expect(report).toContain('"historyBytes": 38');
    expect(report).toContain('"inputKind": "paste-or-composition"');
    expect(report).toContain('"write-success": 1');
    expect(report).toContain("Terminal recovery state: manual-restarting");
    expect(report).toContain("writes since last output=1");
    expect(report).toContain('"terminal-resync-failed": 1');
    expect(report).toContain('"terminal-restart-confirmed": 1');
    expect(report).toContain("manual terminal resync attempt(s) failed");
    expect(report).not.toContain("secret-token");
    expect(report).not.toContain("terminal output that should not appear");
    expect(report).not.toContain("command-that-must-not-leak");
  });
});
