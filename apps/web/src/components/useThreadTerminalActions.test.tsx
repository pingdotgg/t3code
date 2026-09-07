import { EnvironmentId, ProjectId, ThreadId, type ProjectScript } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import * as Cause from "effect/Cause";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadTerminalActions } from "./useThreadTerminalActions";

const commands = vi.hoisted(() => ({ open: vi.fn(), write: vi.fn(), close: vi.fn() }));
vi.mock("../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (_command: unknown, label: string) =>
    label === "terminal open"
      ? commands.open
      : label === "terminal write"
        ? commands.write
        : commands.close,
}));
vi.mock("~/hooks/useLocalStorage", () => ({ useLocalStorage: () => [{}, vi.fn()] }));

const threadRef = { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") };
const project = {
  id: ProjectId.make("project"),
  workspaceRoot: "/tmp/project",
} as NonNullable<Parameters<typeof useThreadTerminalActions>[0]["activeProject"]>;
const script: ProjectScript = {
  id: "build",
  name: "Build",
  command: "build",
  icon: "play",
  runOnWorktreeCreate: false,
};
let actions: ReturnType<typeof useThreadTerminalActions>;
let renderer: ReactTestRenderer;
const focusComposer = vi.fn();
const setThreadError = vi.fn();
const state = () =>
  selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  );

function Probe() {
  const terminalUiState = useTerminalUiStateStore((store) =>
    selectThreadTerminalUiState(store.terminalUiStateByThreadKey, threadRef),
  );
  const value = useThreadTerminalActions({
    environmentId: threadRef.environmentId,
    activeThreadRef: threadRef,
    activeThread: {
      id: threadRef.threadId,
      environmentId: threadRef.environmentId,
      worktreePath: null,
    },
    activeProject: project,
    terminals: {
      terminalUiState,
      activeKnownTerminalIds: terminalUiState.terminalIds,
      allocatableActiveTerminalIds: terminalUiState.terminalIds,
      activeTerminalLabelsById: new Map(),
      runningTerminalIds: [],
    },
    setThreadError,
    focusComposer,
  });
  useLayoutEffect(() => {
    actions = value;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  commands.open.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  commands.write.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  await act(() => {
    renderer = create(<Probe />);
  });
});

afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("terminal allocation failures", () => {
  const failOpen = () =>
    commands.open.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Open failed")),
    });

  it("removes a failed first terminal and retries on the next toggle", async () => {
    failOpen();
    await act(() => actions.toggleTerminalVisibility());
    expect(state().terminalIds).toEqual([]);
    expect(state().terminalOpen).toBe(false);
    await act(() => actions.toggleTerminalVisibility());
    expect(commands.open).toHaveBeenCalledTimes(2);
    expect(state().terminalIds).toHaveLength(1);
  });

  it.each(["horizontal", "vertical", "new", "script"] as const)(
    "preserves the existing terminal after a failed %s allocation",
    async (kind) => {
      await act(() => actions.toggleTerminalVisibility());
      const existing = state().terminalIds;
      failOpen();
      await act(async () => {
        if (kind === "new") actions.createNewTerminal();
        else if (kind === "script")
          await actions.runProjectScript(script, { preferNewTerminal: true });
        else actions.splitTerminal(kind);
      });
      expect(state().terminalIds).toEqual(existing);
      expect(state().activeTerminalId).toBe(existing[0]);
      expect(commands.write).not.toHaveBeenCalled();
    },
  );

  it("does not remove an existing terminal when a script cannot reopen it", async () => {
    await act(() => actions.toggleTerminalVisibility());
    const existing = state().terminalIds;
    failOpen();
    await act(() => actions.runProjectScript(script));
    expect(state().terminalIds).toEqual(existing);
    expect(commands.write).not.toHaveBeenCalled();
  });
});
