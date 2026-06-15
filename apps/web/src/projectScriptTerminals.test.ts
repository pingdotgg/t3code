import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  EnvironmentApi,
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalOpenInput,
} from "@t3tools/contracts";

import {
  openTerminalAndWaitForInputReady,
  projectActionTerminalId,
  resolveProjectActionTerminalId,
  terminalOutputLooksReadyForInput,
} from "./projectScriptTerminals";

const OPEN_INPUT: TerminalOpenInput = {
  threadId: "thread-1",
  terminalId: "action-build",
  cwd: "/repo",
};

function createReadyApi(
  snapshotHistory: string,
  unsubscribe = vi.fn(),
): Pick<EnvironmentApi, "terminal"> {
  return {
    terminal: {
      attach: vi.fn((_input: TerminalAttachInput, callback) => {
        const snapshotEvent: Extract<TerminalAttachStreamEvent, { type: "snapshot" }> = {
          type: "snapshot",
          snapshot: {
            threadId: OPEN_INPUT.threadId,
            terminalId: OPEN_INPUT.terminalId,
            cwd: OPEN_INPUT.cwd,
            worktreePath: null,
            status: "running",
            pid: 123,
            history: snapshotHistory,
            exitCode: null,
            exitSignal: null,
            label: "Terminal",
            updatedAt: "2026-06-15T00:00:00.000Z",
          },
        };
        callback(snapshotEvent);
        return unsubscribe;
      }),
    } as unknown as EnvironmentApi["terminal"],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("project action terminal ids", () => {
  it("uses a stable action-specific terminal id", () => {
    expect(projectActionTerminalId("build")).toBe("action-build");
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build",
        terminalIds: [],
        runningTerminalIds: [],
      }),
    ).toBe("action-build");
  });

  it("reuses an idle action fallback when the primary action terminal is busy", () => {
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build",
        terminalIds: ["action-build", "action-build-2", "term-1"],
        runningTerminalIds: ["action-build"],
      }),
    ).toBe("action-build-2");
  });

  it("allocates a suffixed action terminal when all existing action terminals are busy", () => {
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build",
        terminalIds: ["action-build", "action-build-2"],
        runningTerminalIds: ["action-build", "action-build-2"],
      }),
    ).toBe("action-build-3");
  });
});

describe("terminalOutputLooksReadyForInput", () => {
  it("detects common shell prompts", () => {
    expect(terminalOutputLooksReadyForInput("initializing...\n$ ")).toBe(true);
    expect(terminalOutputLooksReadyForInput("\u001B[32mrepo\u001B[0m % ")).toBe(true);
  });

  it("does not treat plain command text as readiness", () => {
    expect(terminalOutputLooksReadyForInput("pnpm run dist:desktop:dmg:arm64\n")).toBe(false);
  });
});

describe("openTerminalAndWaitForInputReady", () => {
  it("resolves from a prompt already present in the snapshot history", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const api = createReadyApi("ready\n$ ", unsubscribe);

    await openTerminalAndWaitForInputReady(api, OPEN_INPUT);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("waits for prompt output after the snapshot", async () => {
    vi.useFakeTimers();
    const listenerRef: { current: ((event: TerminalAttachStreamEvent) => void) | null } = {
      current: null,
    };
    const unsubscribe = vi.fn();
    const api: Pick<EnvironmentApi, "terminal"> = {
      terminal: {
        attach: vi.fn((_input: TerminalAttachInput, callback) => {
          listenerRef.current = callback;
          callback({
            type: "snapshot",
            snapshot: {
              threadId: OPEN_INPUT.threadId,
              terminalId: OPEN_INPUT.terminalId,
              cwd: OPEN_INPUT.cwd,
              worktreePath: null,
              status: "running",
              pid: 123,
              history: "",
              exitCode: null,
              exitSignal: null,
              label: "Terminal",
              updatedAt: "2026-06-15T00:00:00.000Z",
            },
          });
          return unsubscribe;
        }),
      } as unknown as EnvironmentApi["terminal"],
    };

    const ready = openTerminalAndWaitForInputReady(api, OPEN_INPUT);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(unsubscribe).not.toHaveBeenCalled();

    listenerRef.current?.({
      type: "output",
      threadId: OPEN_INPUT.threadId,
      terminalId: OPEN_INPUT.terminalId,
      data: "$ ",
    });
    await ready;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("falls back after the timeout when no prompt is emitted", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const api = createReadyApi("", unsubscribe);

    const ready = openTerminalAndWaitForInputReady(api, OPEN_INPUT, 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await ready;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
