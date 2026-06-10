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

// Fork invariant: DEFAULT_TERMINAL_ID is "default" (the primary tab); EXTRA terminals are
// allocated as `term-N` starting at `term-1`. (Upstream conflates the two because there the
// primary id IS "term-1"; this fork keeps them distinct.)
describe("nextTerminalId (pure extra-terminal allocator)", () => {
  it("allocates term-1 when no terminals are listed yet", () => {
    expect(nextTerminalId([])).toBe("term-1");
  });

  it("allocates term-1 when only the primary `default` shell exists", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID])).toBe("term-1");
  });

  it("skips ids already in use and fills the lowest free term-N", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-2", "term-4"])).toBe("term-1");
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-1", "term-2"])).toBe("term-3");
  });
});

describe("nextOpenTerminalId", () => {
  it("opens the primary `default` tab on the first open (nothing listed or mounted)", () => {
    expect(nextOpenTerminalId({ listedTerminalIds: [] })).toBe(DEFAULT_TERMINAL_ID);
  });

  it("advances to term-1 once the primary `default` shell exists", () => {
    expect(nextOpenTerminalId({ listedTerminalIds: [DEFAULT_TERMINAL_ID] })).toBe("term-1");
  });

  it("advances to term-1 when opening from the mounted primary route", () => {
    expect(
      nextOpenTerminalId({
        listedTerminalIds: [],
        activeRouteTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-1");
  });

  it("does not double-count when the route id is already listed", () => {
    expect(
      nextOpenTerminalId({
        listedTerminalIds: [DEFAULT_TERMINAL_ID],
        activeRouteTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-1");
  });

  it("never collides with the primary `default` when allocating extras", () => {
    const primary = DEFAULT_TERMINAL_ID;
    const first = nextOpenTerminalId({ listedTerminalIds: [primary] });
    expect(first).toBe("term-1");
    const second = nextOpenTerminalId({ listedTerminalIds: [primary, first] });
    expect(second).toBe("term-2");
    expect([first, second]).not.toContain(primary);
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

  it("opens a new term-N shell when a shell is already running", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [DEFAULT_TERMINAL_ID, "term-2", "term-4"],
        hasRunningTerminal: true,
      }),
    ).toBe("term-1");
  });
});
