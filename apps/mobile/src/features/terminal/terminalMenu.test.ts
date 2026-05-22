import { describe, expect, it } from "vitest";

import type { KnownTerminalSession } from "@t3tools/client-runtime";
import { DEFAULT_TERMINAL_ID, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { getTerminalLabel } from "@t3tools/shared/terminalLabels";

import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  nextTerminalId,
  resolveProjectScriptTerminalId,
} from "./terminalMenu";

function makeKnownSession(input: {
  readonly terminalId: string;
  readonly status: KnownTerminalSession["state"]["status"];
  readonly cwd?: string | null;
  readonly updatedAt?: string | null;
}): KnownTerminalSession {
  return {
    target: {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: input.terminalId,
    },
    state: {
      summary: input.cwd
        ? {
            threadId: "thread-1",
            terminalId: input.terminalId,
            cwd: input.cwd,
            worktreePath: input.cwd,
            status: input.status === "closed" ? "error" : input.status,
            pid: input.status === "running" ? 123 : null,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: getTerminalLabel(input.terminalId),
            updatedAt: input.updatedAt ?? "2026-04-15T20:00:00.000Z",
          }
        : null,
      buffer: "",
      status: input.status,
      error: null,
      hasRunningSubprocess: false,
      updatedAt: input.updatedAt ?? "2026-04-15T20:00:00.000Z",
      version: 1,
    },
  };
}

describe("buildTerminalMenuSessions", () => {
  it("only lists server-known sessions that are running or starting (plus current)", () => {
    expect(
      buildTerminalMenuSessions({
        knownSessions: [
          makeKnownSession({
            terminalId: "term-3",
            status: "running",
            cwd: "/workspace/feature",
            updatedAt: "2026-04-15T20:05:00.000Z",
          }),
          makeKnownSession({
            terminalId: "term-2",
            status: "exited",
            cwd: "/workspace/exited",
            updatedAt: "2026-04-15T20:06:00.000Z",
          }),
        ],
        workspaceRoot: "/workspace/root",
      }),
    ).toEqual([
      {
        terminalId: "term-3",
        cwd: "/workspace/feature",
        status: "running",
        hasRunningSubprocess: false,
        displayLabel: "Terminal 3",
        updatedAt: "2026-04-15T20:05:00.000Z",
      },
    ]);
  });

  it("keeps the current terminal visible even if it is no longer running", () => {
    expect(
      buildTerminalMenuSessions({
        knownSessions: [],
        workspaceRoot: "/workspace/root",
        currentSession: {
          terminalId: "term-4",
          cwd: "/workspace/exited",
          status: "exited",
          hasRunningSubprocess: false,
          displayLabel: "Terminal 4",
          updatedAt: "2026-04-15T20:07:00.000Z",
        },
      }),
    ).toEqual([
      {
        terminalId: "term-4",
        cwd: "/workspace/exited",
        status: "exited",
        hasRunningSubprocess: false,
        displayLabel: "Terminal 4",
        updatedAt: "2026-04-15T20:07:00.000Z",
      },
    ]);
  });
});

describe("nextTerminalId", () => {
  it("uses the primary id when no terminals are listed yet", () => {
    expect(nextTerminalId([])).toBe(DEFAULT_TERMINAL_ID);
  });

  it("allocates term-2 when only the primary shell exists", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID])).toBe("term-2");
  });
});

describe("nextOpenTerminalId", () => {
  it("matches nextTerminalId when not on a terminal route", () => {
    expect(nextOpenTerminalId({ listedTerminalIds: [] })).toBe(DEFAULT_TERMINAL_ID);
    expect(nextOpenTerminalId({ listedTerminalIds: [DEFAULT_TERMINAL_ID] })).toBe("term-2");
  });

  it("avoids the mounted primary tab when the session list is still empty", () => {
    expect(
      nextOpenTerminalId({
        listedTerminalIds: [],
        activeRouteTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });

  it("does not double-count when the route id is already listed", () => {
    expect(
      nextOpenTerminalId({
        listedTerminalIds: [DEFAULT_TERMINAL_ID],
        activeRouteTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });
});

describe("resolveProjectScriptTerminalId", () => {
  it("reuses the default shell when no terminal is running", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [DEFAULT_TERMINAL_ID],
        hasRunningTerminal: false,
      }),
    ).toBe(DEFAULT_TERMINAL_ID);
  });

  it("opens a new terminal when a shell is already running", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [DEFAULT_TERMINAL_ID, "term-2", "term-4"],
        hasRunningTerminal: true,
      }),
    ).toBe("term-3");
  });
});
