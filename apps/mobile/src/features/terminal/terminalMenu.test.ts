import { describe, expect, it } from "vite-plus/test";

import { type KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { DEFAULT_TERMINAL_ID, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { getTerminalLabel } from "@t3tools/shared/terminalLabels";

import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  nextTerminalId,
  previousLiveTerminalId,
  resolveProjectScriptTerminalId,
  type TerminalMenuSession,
} from "./terminalMenu";

function makeMenuSession(input: {
  readonly terminalId: string;
  readonly status: TerminalMenuSession["status"];
}): TerminalMenuSession {
  return {
    terminalId: input.terminalId,
    cwd: null,
    status: input.status,
    hasRunningSubprocess: false,
    displayLabel: getTerminalLabel(input.terminalId),
    updatedAt: null,
  };
}

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

describe("previousLiveTerminalId", () => {
  it("returns null when no other live session remains", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: "term-2", status: "exited" }),
          makeMenuSession({ terminalId: "term-3", status: "closed" }),
        ],
        exitedTerminalId: "term-2",
      }),
    ).toBe(null);
  });

  it("prefers the nearest live session below the exited id", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "running" }),
          makeMenuSession({ terminalId: "term-2", status: "running" }),
          makeMenuSession({ terminalId: "term-3", status: "exited" }),
          makeMenuSession({ terminalId: "term-4", status: "running" }),
        ],
        exitedTerminalId: "term-3",
      }),
    ).toBe("term-2");
  });

  it("falls back to the nearest live session above when the exited id was lowest", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "exited" }),
          makeMenuSession({ terminalId: "term-2", status: "starting" }),
          makeMenuSession({ terminalId: "term-4", status: "running" }),
        ],
        exitedTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });

  it("ignores dead sessions when picking the fallback", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "running" }),
          makeMenuSession({ terminalId: "term-2", status: "exited" }),
          makeMenuSession({ terminalId: "term-3", status: "exited" }),
        ],
        exitedTerminalId: "term-3",
      }),
    ).toBe(DEFAULT_TERMINAL_ID);
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
