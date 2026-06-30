import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  EnvironmentId,
  EnvironmentApi,
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalOpenInput,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { subscribe, type RpcSession } from "@t3tools/client-runtime/rpc";
import { assert, it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  classifyProjectActionTerminalCandidates,
  openTerminalAndWaitForInputReady,
  ProjectActionTerminalReadinessTimeoutError,
  projectActionTerminalReadinessFailureFromEvent,
  projectActionTerminalId,
  resolveProjectActionTerminalId,
  runProjectScriptInTerminal,
  runningTerminalIdsWithProjectActionReservations,
  terminalSessionIsReadyForProjectActionInput,
  terminalSessionShouldProbeForProjectActionInput,
  terminalOutputLooksReadyForInput,
  waitForProjectActionTerminalInputReady,
  waitForProjectActionTerminalInputReadyStrict,
} from "./projectScriptTerminals";

vi.mock("@t3tools/client-runtime/rpc", () => ({
  subscribe: vi.fn(),
}));

const OPEN_INPUT: TerminalOpenInput = {
  threadId: "thread-1",
  terminalId: "action-build",
  cwd: "/repo",
};

const subscribeMock = vi.mocked(subscribe);

const makeSupervisor = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
  const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
  const prepared = yield* SubscriptionRef.make(Option.none<PreparedConnection>());
  return EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: "environment-test" as EnvironmentId,
      label: "Test environment",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
    state,
    session,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor["Service"]);
});

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
  subscribeMock.mockReset();
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
        terminalIds: ["action-build", "action-build:2", "term-1"],
        runningTerminalIds: ["action-build"],
      }),
    ).toBe("action-build:2");
  });

  it("allocates a suffixed action terminal when all existing action terminals are busy", () => {
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build",
        terminalIds: ["action-build", "action-build:2"],
        runningTerminalIds: ["action-build", "action-build:2"],
      }),
    ).toBe("action-build:3");
  });

  it("does not reuse another script primary terminal as an action fallback", () => {
    expect(projectActionTerminalId("build-2")).toBe("action-build-2");
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build",
        terminalIds: ["action-build", "action-build-2"],
        runningTerminalIds: ["action-build"],
      }),
    ).toBe("action-build:2");
  });

  it("encodes script ids before adding fallback suffixes", () => {
    expect(projectActionTerminalId("build:2")).toBe("action-build%3A2");
    expect(projectActionTerminalId("build:2", 2)).toBe("action-build%3A2:2");
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build:2",
        terminalIds: ["action-build%3A2", "action-build:2"],
        runningTerminalIds: ["action-build%3A2"],
      }),
    ).toBe("action-build%3A2:2");
  });

  it("only reuses numeric action fallback suffixes", () => {
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build",
        terminalIds: ["action-build", "action-build:dev", "action-build:2"],
        runningTerminalIds: ["action-build"],
      }),
    ).toBe("action-build:2");
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build",
        terminalIds: ["action-build", "action-build:dev"],
        runningTerminalIds: ["action-build"],
      }),
    ).toBe("action-build:2");
  });
});

describe("terminalOutputLooksReadyForInput", () => {
  it("detects common shell prompts", () => {
    expect(terminalOutputLooksReadyForInput("initializing...\n$ ")).toBe(true);
    expect(terminalOutputLooksReadyForInput("\u001B[32mrepo\u001B[0m % ")).toBe(true);
    expect(terminalOutputLooksReadyForInput("user@host:~/repo$ ")).toBe(true);
    expect(terminalOutputLooksReadyForInput("host% ")).toBe(true);
    expect(terminalOutputLooksReadyForInput("PS C:\\repo> ")).toBe(true);
    expect(terminalOutputLooksReadyForInput("C:\\repo> ")).toBe(true);
    expect(terminalOutputLooksReadyForInput("C:> ")).toBe(true);
  });

  it("ignores terminal title control sequences around prompts", () => {
    expect(terminalOutputLooksReadyForInput("\u001B]0;repo\u0007$ \u001B[?2004h")).toBe(true);
  });

  it("does not treat plain command text as readiness", () => {
    expect(terminalOutputLooksReadyForInput("pnpm run dist:desktop:dmg:arm64\n")).toBe(false);
    expect(terminalOutputLooksReadyForInput("rendered <span>\n")).toBe(false);
    expect(terminalOutputLooksReadyForInput("status: waiting>\n")).toBe(false);
    expect(terminalOutputLooksReadyForInput("progress 100%\n")).toBe(false);
    expect(terminalOutputLooksReadyForInput("Building 50 %\n")).toBe(false);
  });
});

describe("terminalSessionIsReadyForProjectActionInput", () => {
  it("treats shell-labeled sessions with a visible prompt as reusable", () => {
    expect(
      terminalSessionIsReadyForProjectActionInput({
        summary: {
          cwd: "/repo",
          hasRunningSubprocess: true,
          label: "bash",
          status: "running",
          worktreePath: null,
        },
        buffer: "$ ",
        targetCwd: "/repo",
        targetWorktreePath: null,
      }),
    ).toBe(true);
  });

  it("waits for prompt output before reusing an idle shell session", () => {
    expect(
      terminalSessionIsReadyForProjectActionInput({
        summary: {
          cwd: "/repo",
          hasRunningSubprocess: false,
          label: "bash",
          status: "running",
          worktreePath: null,
        },
        buffer: "loading profile...\n",
        targetCwd: "/repo",
        targetWorktreePath: null,
      }),
    ).toBe(false);
  });

  it("does not reuse a busy shell-labeled session without prompt output", () => {
    expect(
      terminalSessionIsReadyForProjectActionInput({
        summary: {
          cwd: "/repo",
          hasRunningSubprocess: true,
          label: "bash",
          status: "running",
          worktreePath: null,
        },
        buffer: "",
        targetCwd: "/repo",
        targetWorktreePath: null,
      }),
    ).toBe(false);
  });

  it("does not treat non-shell subprocess labels as reusable", () => {
    expect(
      terminalSessionIsReadyForProjectActionInput({
        summary: {
          cwd: "/repo",
          hasRunningSubprocess: true,
          label: "vim",
          status: "running",
          worktreePath: null,
        },
        buffer: "$ ",
        targetCwd: "/repo",
        targetWorktreePath: null,
      }),
    ).toBe(false);
  });
});

describe("terminalSessionShouldProbeForProjectActionInput", () => {
  it("probes shell-labeled busy sessions in the target workspace", () => {
    expect(
      terminalSessionShouldProbeForProjectActionInput({
        summary: {
          cwd: "/repo",
          hasRunningSubprocess: true,
          label: "bash",
          status: "running",
          worktreePath: "/repo-worktree",
        },
        targetCwd: "/repo",
        targetWorktreePath: "/repo-worktree",
      }),
    ).toBe(true);
  });

  it("probes Windows cmd sessions", () => {
    expect(
      terminalSessionShouldProbeForProjectActionInput({
        summary: {
          cwd: "C:\\repo",
          hasRunningSubprocess: true,
          label: "cmd.exe",
          status: "running",
          worktreePath: null,
        },
        targetCwd: "C:\\repo",
        targetWorktreePath: null,
      }),
    ).toBe(true);
  });

  it("does not probe non-shell subprocess labels", () => {
    expect(
      terminalSessionShouldProbeForProjectActionInput({
        summary: {
          cwd: "/repo",
          hasRunningSubprocess: true,
          label: "node",
          status: "running",
          worktreePath: null,
        },
        targetCwd: "/repo",
        targetWorktreePath: null,
      }),
    ).toBe(false);
  });

  it("does not probe terminals from another cwd", () => {
    expect(
      terminalSessionShouldProbeForProjectActionInput({
        summary: {
          cwd: "/other",
          hasRunningSubprocess: true,
          label: "bash",
          status: "running",
          worktreePath: null,
        },
        targetCwd: "/repo",
        targetWorktreePath: null,
      }),
    ).toBe(false);
  });
});

describe("classifyProjectActionTerminalCandidates", () => {
  it("keeps ready and probeable action terminals out of busy terminal selection", () => {
    const result = classifyProjectActionTerminalCandidates({
      sessions: [
        {
          target: { terminalId: "action-build" },
          state: {
            summary: {
              cwd: "/repo",
              hasRunningSubprocess: true,
              label: "bash",
              status: "running",
              worktreePath: null,
            },
            buffer: "$ ",
          },
        },
        {
          target: { terminalId: "action-build:2" },
          state: {
            summary: {
              cwd: "/repo",
              hasRunningSubprocess: true,
              label: "bash",
              status: "running",
              worktreePath: null,
            },
            buffer: "",
          },
        },
        {
          target: { terminalId: "term-1" },
          state: {
            summary: {
              cwd: "/repo",
              hasRunningSubprocess: true,
              label: "node",
              status: "running",
              worktreePath: null,
            },
            buffer: "$ ",
          },
        },
      ],
      runningTerminalIds: ["action-build", "action-build:2", "term-1", "missing"],
      targetCwd: "/repo",
      targetWorktreePath: null,
    });

    expect(result.sessionsById.get("action-build")?.target.terminalId).toBe("action-build");
    expect(result.readyTerminalIds).toEqual(new Set(["action-build"]));
    expect(result.probeTerminalIds).toEqual(new Set(["action-build:2"]));
    expect(result.runningTerminalIdsForSelection).toEqual(["term-1", "missing"]);
    expect(
      resolveProjectActionTerminalId({
        scriptId: "build",
        terminalIds: ["action-build", "action-build:2"],
        runningTerminalIds: runningTerminalIdsWithProjectActionReservations({
          runningTerminalIds: result.runningTerminalIdsForSelection,
          reservedTerminalIds: ["action-build"],
        }),
      }),
    ).toBe("action-build:2");
  });

  it("classifies ready terminals before probeable terminals", () => {
    const result = classifyProjectActionTerminalCandidates({
      sessions: [
        {
          target: { terminalId: "action-build" },
          state: {
            summary: {
              cwd: "/repo",
              hasRunningSubprocess: true,
              label: "bash",
              status: "running",
              worktreePath: null,
            },
            buffer: "$ ",
          },
        },
      ],
      runningTerminalIds: ["action-build"],
      targetCwd: "/repo",
      targetWorktreePath: null,
    });

    expect(result.readyTerminalIds).toEqual(new Set(["action-build"]));
    expect(result.probeTerminalIds).toEqual(new Set());
    expect(result.runningTerminalIdsForSelection).toEqual([]);
  });

  it("preserves selection candidates without reusable session state", () => {
    const result = classifyProjectActionTerminalCandidates({
      sessions: [
        {
          target: { terminalId: "detached" },
          state: {
            summary: null,
            buffer: "",
          },
        },
        {
          target: { terminalId: "term-1" },
          state: {
            summary: {
              cwd: "/repo",
              hasRunningSubprocess: true,
              label: "node",
              status: "running",
              worktreePath: null,
            },
            buffer: "",
          },
        },
      ],
      runningTerminalIds: ["term-1", "missing", "term-1", "detached"],
      targetCwd: "/repo",
      targetWorktreePath: null,
    });

    expect(result.readyTerminalIds).toEqual(new Set());
    expect(result.probeTerminalIds).toEqual(new Set());
    expect(result.runningTerminalIdsForSelection).toEqual([
      "term-1",
      "missing",
      "term-1",
      "detached",
    ]);
  });

  it("does not classify sessions from another worktree as reusable or probeable", () => {
    const result = classifyProjectActionTerminalCandidates({
      sessions: [
        {
          target: { terminalId: "action-build" },
          state: {
            summary: {
              cwd: "/repo",
              hasRunningSubprocess: true,
              label: "bash",
              status: "running",
              worktreePath: "/other-worktree",
            },
            buffer: "$ ",
          },
        },
      ],
      runningTerminalIds: ["action-build"],
      targetCwd: "/repo",
      targetWorktreePath: "/repo-worktree",
    });

    expect(result.readyTerminalIds.size).toBe(0);
    expect(result.probeTerminalIds.size).toBe(0);
    expect(result.runningTerminalIdsForSelection).toEqual(["action-build"]);
  });
});

describe("runningTerminalIdsWithProjectActionReservations", () => {
  it("adds active launch reservations without duplicating existing busy terminal ids", () => {
    expect(
      runningTerminalIdsWithProjectActionReservations({
        runningTerminalIds: ["term-1", "action-build", "term-1"],
        reservedTerminalIds: ["action-build", "action-build:2"],
      }),
    ).toEqual(["term-1", "action-build", "term-1", "action-build:2"]);
  });
});

describe("runProjectScriptInTerminal", () => {
  const runtimeEnv = { T3CODE_PROJECT_ROOT: "/repo" };
  const script = { id: "build", command: "pnpm build" };

  function createCommandSuccess() {
    return AsyncResult.success(undefined);
  }

  it("reuses a ready action terminal and waits after opening before writing", async () => {
    const reservedTerminalIds = new Set<string>();
    const showTerminal = vi.fn();
    const openTerminal = vi.fn(async () => createCommandSuccess());
    const writeTerminal = vi.fn(async () => createCommandSuccess());
    const waitForInputReady = vi.fn(async () => createCommandSuccess());
    const requireInputReady = vi.fn(async () => createCommandSuccess());

    const result = await runProjectScriptInTerminal({
      script,
      threadId: "thread-1",
      targetCwd: "/repo",
      targetWorktreePath: null,
      runtimeEnv,
      preferNewTerminal: false,
      knownTerminalIds: ["action-build"],
      serverTerminalIds: ["action-build"],
      visibleTerminalIds: ["action-build"],
      runningTerminalIds: ["action-build"],
      sessions: [
        {
          target: { terminalId: "action-build" },
          state: {
            summary: {
              cwd: "/repo",
              hasRunningSubprocess: false,
              label: "bash",
              status: "running",
              worktreePath: null,
            },
            buffer: "$ ",
          },
        },
      ],
      reservedTerminalIds,
      isCommandInterrupted: () => false,
      showTerminal,
      openTerminal,
      writeTerminal,
      waitForInputReady,
      requireInputReady,
    });

    expect(result).toEqual({ _tag: "Success" });
    expect(showTerminal).toHaveBeenCalledWith("action-build", { isVisibleTerminal: true });
    expect(openTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build",
      cwd: "/repo",
      env: runtimeEnv,
    });
    expect(requireInputReady).not.toHaveBeenCalled();
    expect(waitForInputReady).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build",
      cwd: "/repo",
      env: runtimeEnv,
    });
    expect(writeTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build",
      data: "pnpm build\r",
    });
    expect(openTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      waitForInputReady.mock.invocationCallOrder[0] ?? 0,
    );
    expect(waitForInputReady.mock.invocationCallOrder[0]).toBeLessThan(
      writeTerminal.mock.invocationCallOrder[0] ?? 0,
    );
    expect([...reservedTerminalIds]).toEqual([]);
  });

  it("falls back to another action terminal when a probed terminal is not ready", async () => {
    const reservedTerminalIds = new Set<string>();
    const showTerminal = vi.fn();
    const openTerminal = vi.fn(async () => createCommandSuccess());
    const writeTerminal = vi.fn(async () => createCommandSuccess());
    const waitForInputReady = vi.fn(async () => createCommandSuccess());
    const requireInputReady = vi.fn(async () => AsyncResult.failure(Cause.fail("not ready")));

    const result = await runProjectScriptInTerminal({
      script,
      threadId: "thread-1",
      targetCwd: "/repo",
      targetWorktreePath: null,
      runtimeEnv,
      preferNewTerminal: false,
      knownTerminalIds: ["action-build"],
      serverTerminalIds: ["action-build"],
      visibleTerminalIds: ["action-build"],
      runningTerminalIds: ["action-build"],
      sessions: [
        {
          target: { terminalId: "action-build" },
          state: {
            summary: {
              cwd: "/repo",
              hasRunningSubprocess: true,
              label: "bash",
              status: "running",
              worktreePath: null,
            },
            buffer: "still starting\n",
          },
        },
      ],
      reservedTerminalIds,
      isCommandInterrupted: () => false,
      showTerminal,
      openTerminal,
      writeTerminal,
      waitForInputReady,
      requireInputReady,
    });

    expect(result).toEqual({ _tag: "Success" });
    expect(requireInputReady).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build",
      cwd: "/repo",
      env: runtimeEnv,
    });
    expect(showTerminal).toHaveBeenCalledWith("action-build:2", { isVisibleTerminal: false });
    expect(openTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build:2",
      cwd: "/repo",
      env: runtimeEnv,
      cols: 120,
      rows: 30,
    });
    expect(waitForInputReady).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build:2",
      cwd: "/repo",
      env: runtimeEnv,
      cols: 120,
      rows: 30,
    });
    expect(writeTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build:2",
      data: "pnpm build\r",
    });
    expect([...reservedTerminalIds]).toEqual([]);
  });

  it("does not write when waiting after open is interrupted", async () => {
    const reservedTerminalIds = new Set<string>();
    const interruptedResult = AsyncResult.failure(Cause.interrupt());
    const showTerminal = vi.fn();
    const openTerminal = vi.fn(async () => createCommandSuccess());
    const writeTerminal = vi.fn(async () => createCommandSuccess());
    const waitForInputReady = vi.fn(async () => interruptedResult);
    const requireInputReady = vi.fn(async () => createCommandSuccess());

    const result = await runProjectScriptInTerminal({
      script,
      threadId: "thread-1",
      targetCwd: "/repo",
      targetWorktreePath: null,
      runtimeEnv,
      preferNewTerminal: false,
      knownTerminalIds: ["action-build"],
      serverTerminalIds: [],
      visibleTerminalIds: [],
      runningTerminalIds: [],
      sessions: [],
      reservedTerminalIds,
      isCommandInterrupted: (commandResult) => commandResult === interruptedResult,
      showTerminal,
      openTerminal,
      writeTerminal,
      waitForInputReady,
      requireInputReady,
    });

    expect(result).toEqual({ _tag: "Interrupted" });
    expect(openTerminal).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build",
      cwd: "/repo",
      env: runtimeEnv,
      cols: 120,
      rows: 30,
    });
    expect(waitForInputReady).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "action-build",
      cwd: "/repo",
      env: runtimeEnv,
      cols: 120,
      rows: 30,
    });
    expect(writeTerminal).not.toHaveBeenCalled();
    expect([...reservedTerminalIds]).toEqual([]);
  });
});

describe("openTerminalAndWaitForInputReady", () => {
  it("classifies terminal attach errors as typed readiness failures", () => {
    const error = projectActionTerminalReadinessFailureFromEvent(OPEN_INPUT, {
      type: "error",
      threadId: OPEN_INPUT.threadId,
      terminalId: OPEN_INPUT.terminalId,
      message: "PTY closed unexpectedly.",
    });

    expect(error).not.toBeNull();
    expect(error?._tag).toBe("ProjectActionTerminalAttachError");
    expect(error?.threadId).toBe(OPEN_INPUT.threadId);
    expect(error?.terminalId).toBe(OPEN_INPUT.terminalId);
    expect(error?.cwd).toBe(OPEN_INPUT.cwd);
    expect(error?.detail).toBe("PTY closed unexpectedly.");
  });

  it("classifies closed and exited terminals as typed readiness failures", () => {
    const closed = projectActionTerminalReadinessFailureFromEvent(OPEN_INPUT, {
      type: "closed",
      threadId: OPEN_INPUT.threadId,
      terminalId: OPEN_INPUT.terminalId,
    });
    const exited = projectActionTerminalReadinessFailureFromEvent(OPEN_INPUT, {
      type: "exited",
      threadId: OPEN_INPUT.threadId,
      terminalId: OPEN_INPUT.terminalId,
      exitCode: 1,
      exitSignal: null,
    });

    expect(closed?._tag).toBe("ProjectActionTerminalAttachError");
    expect(closed?.detail).toBe("Terminal closed before it was ready for input.");
    expect(exited?._tag).toBe("ProjectActionTerminalAttachError");
    expect(exited?.detail).toBe("Terminal process exited before it was ready for input.");
  });

  it("uses a typed timeout error for project action terminal readiness", () => {
    const error = new ProjectActionTerminalReadinessTimeoutError({
      threadId: OPEN_INPUT.threadId,
      terminalId: OPEN_INPUT.terminalId,
      cwd: OPEN_INPUT.cwd,
      timeoutMs: 1_000,
    });

    expect(error._tag).toBe("ProjectActionTerminalReadinessTimeoutError");
    expect(error.message).toContain(OPEN_INPUT.terminalId);
  });

  it("resolves from a prompt already present in the snapshot history", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const api = createReadyApi("ready\n$ ", unsubscribe);

    await openTerminalAndWaitForInputReady(api, OPEN_INPUT);

    expect(api.terminal.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        restartIfNotRunning: true,
        terminalId: OPEN_INPUT.terminalId,
        threadId: OPEN_INPUT.threadId,
      }),
      expect.any(Function),
    );
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

  it("waits for readiness after opening when the first attach throws", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    let openResolve: () => void = () => {
      throw new Error("Open promise was not initialized.");
    };
    let listener: (event: TerminalAttachStreamEvent) => void = () => {
      throw new Error("Terminal attach listener was not initialized.");
    };
    let settled = false;
    const api: Pick<EnvironmentApi, "terminal"> = {
      terminal: {
        attach: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("attach unavailable");
          })
          .mockImplementationOnce((_input: TerminalAttachInput, callback) => {
            listener = callback;
            return unsubscribe;
          }),
        open: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              openResolve = resolve;
            }),
        ),
      } as unknown as EnvironmentApi["terminal"],
    };

    const ready = openTerminalAndWaitForInputReady(api, OPEN_INPUT);
    void ready.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(api.terminal.open).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    openResolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.terminal.attach).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    listener({
      type: "output",
      threadId: OPEN_INPUT.threadId,
      terminalId: OPEN_INPUT.terminalId,
      data: "$ ",
    });
    await ready;

    expect(settled).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("falls back after the timeout when the second attach never emits a prompt", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    let openResolve: () => void = () => {
      throw new Error("Open promise was not initialized.");
    };
    let settled = false;
    const api: Pick<EnvironmentApi, "terminal"> = {
      terminal: {
        attach: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("attach unavailable");
          })
          .mockImplementationOnce(() => unsubscribe),
        open: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              openResolve = resolve;
            }),
        ),
      } as unknown as EnvironmentApi["terminal"],
    };

    const ready = openTerminalAndWaitForInputReady(api, OPEN_INPUT, 1_000);
    void ready.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(api.terminal.open).toHaveBeenCalledTimes(1);

    openResolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.terminal.attach).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await ready;

    expect(settled).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  effectIt.effect(
    "fails strict readiness on terminal closure but preserves best-effort fallback",
    () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor;
        subscribeMock.mockReturnValueOnce(
          Stream.make({
            type: "closed",
            threadId: OPEN_INPUT.threadId,
            terminalId: OPEN_INPUT.terminalId,
          }),
        );

        const error = yield* waitForProjectActionTerminalInputReadyStrict(OPEN_INPUT, 1_000).pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.flip,
        );

        assert.strictEqual(error._tag, "ProjectActionTerminalAttachError");
        if (error._tag !== "ProjectActionTerminalAttachError") {
          return yield* Effect.die(new Error("Expected a terminal attach error."));
        }
        assert.strictEqual(error.detail, "Terminal closed before it was ready for input.");

        subscribeMock.mockReturnValueOnce(
          Stream.make({
            type: "closed",
            threadId: OPEN_INPUT.threadId,
            terminalId: OPEN_INPUT.terminalId,
          }),
        );

        yield* waitForProjectActionTerminalInputReady(OPEN_INPUT, 1_000).pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
        );
      }),
  );

  effectIt.effect("fails strict readiness when the attach stream ends without readiness", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor;
      subscribeMock.mockReturnValueOnce(Stream.empty);

      const error = yield* waitForProjectActionTerminalInputReadyStrict(OPEN_INPUT, 1_000).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "ProjectActionTerminalAttachError");
      if (error._tag !== "ProjectActionTerminalAttachError") {
        return yield* Effect.die(new Error("Expected a terminal attach error."));
      }
      assert.strictEqual(
        error.detail,
        "Terminal attach stream ended before it was ready for input.",
      );

      subscribeMock.mockReturnValueOnce(Stream.empty);
      yield* waitForProjectActionTerminalInputReady(OPEN_INPUT, 1_000).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
      );
    }),
  );

  effectIt.effect("maps attach subscription failures to typed readiness failures", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor;
      subscribeMock.mockImplementationOnce(() => {
        throw new Error("attach transport unavailable");
      });

      const thrownError = yield* waitForProjectActionTerminalInputReadyStrict(
        OPEN_INPUT,
        1_000,
      ).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);

      assert.strictEqual(thrownError._tag, "ProjectActionTerminalAttachError");
      if (thrownError._tag !== "ProjectActionTerminalAttachError") {
        return yield* Effect.die(new Error("Expected a terminal attach error."));
      }
      assert.strictEqual(thrownError.threadId, OPEN_INPUT.threadId);
      assert.strictEqual(thrownError.terminalId, OPEN_INPUT.terminalId);
      assert.strictEqual(
        thrownError.detail,
        "Terminal attach failed before it was ready for input.",
      );
      assert.notStrictEqual(thrownError.cause, undefined);
      assert.match(
        Cause.pretty(thrownError.cause as Cause.Cause<unknown>),
        /attach transport unavailable/,
      );

      subscribeMock.mockReturnValueOnce(Stream.fail(new Error("attach stream rejected")));
      const failedStreamError = yield* waitForProjectActionTerminalInputReadyStrict(
        OPEN_INPUT,
        1_000,
      ).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);

      assert.strictEqual(failedStreamError._tag, "ProjectActionTerminalAttachError");
      if (failedStreamError._tag !== "ProjectActionTerminalAttachError") {
        return yield* Effect.die(new Error("Expected a terminal attach error."));
      }
      assert.strictEqual(
        failedStreamError.detail,
        "Terminal attach failed before it was ready for input.",
      );
      assert.notStrictEqual(failedStreamError.cause, undefined);
      assert.match(
        Cause.pretty(failedStreamError.cause as Cause.Cause<unknown>),
        /attach stream rejected/,
      );
    }),
  );
});
