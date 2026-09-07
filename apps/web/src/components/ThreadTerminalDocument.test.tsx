import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useEffect, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { ThreadTerminalDocument } from "./ThreadTerminalDocument";
import { ThreadTerminals } from "./ThreadTerminals";
import {
  useThreadTerminalActions,
  useThreadTerminalSessionState,
} from "./useThreadTerminalActions";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useUiStateStore } from "../uiStateStore";
import { commandForProjectScript } from "../projectScripts";
import type { Project, Thread } from "../types";

type DrawerProps = ComponentProps<typeof ThreadTerminalDrawer>;
const fixture = vi.hoisted(() => ({
  threads: new Map<string, Thread>(),
  refs: [] as ScopedThreadRef[],
  summaries: [] as TerminalSummary[],
  bindings: [] as ResolvedKeybindingsConfig,
  project: null as Project | null,
  drawers: new Map<string, DrawerProps>(),
  mounts: new Map<string, number>(),
  paletteOpen: false,
  supportsThreads: true,
  open: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
  confirm: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  pin: vi.fn(),
  unpin: vi.fn(),
  clipboard: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => fixture.bindings }));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../state/terminal", () => ({
  terminalEnvironment: { open: fixture.open, write: fixture.write, close: fixture.close },
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { unsettle: fixture.unsettle } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../state/entities", () => ({
  useThread: (ref: ScopedThreadRef | null) =>
    ref ? (fixture.threads.get(scopedThreadKey(ref)) ?? null) : null,
  useThreadShell: (ref: ScopedThreadRef | null) =>
    ref ? (fixture.threads.get(scopedThreadKey(ref)) ?? null) : null,
  useThreadRefs: () => fixture.refs,
  useProject: () => fixture.project,
}));
vi.mock("../state/terminalSessions", async (importOriginal) => {
  const original = await importOriginal<typeof import("../state/terminalSessions")>();
  return {
    ...original,
    useKnownTerminalSessions: ({ environmentId, threadId }: ScopedThreadRef) =>
      original.selectKnownTerminalSessions(fixture.summaries, environmentId, threadId),
    useThreadRunningTerminalIds: () =>
      fixture.summaries.filter((s) => s.hasRunningSubprocess).map((s) => s.terminalId),
  };
});
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ projectScriptOverrides: {}, defaultProjectScripts: [] }),
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: {
      environment: {
        capabilities: {
          threadSettlement: fixture.supportsThreads,
          threadPinning: fixture.supportsThreads,
        },
      },
    },
  }),
}));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: fixture.settle,
    pinThread: fixture.pin,
    confirmAndUnpinThread: fixture.unpin,
  }),
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({
  useOpenPanelPullRequestUrl: () => undefined,
}));
vi.mock("../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: fixture.clipboard }));
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => fixture.paletteOpen }));
vi.mock("../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => "drawer" }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: fixture.confirm } }) }));
vi.mock("../previewStateStore", () => ({
  useThreadPreviewState: () => ({ sessions: {}, desktopByTabId: {} }),
  setActivePreviewTab: vi.fn(),
}));
vi.mock("../state/preview", () => ({ previewEnvironment: { close: vi.fn() } }));
vi.mock("../panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelPresence: (present: boolean) => ({ present }),
}));
vi.mock("./ThreadTerminalDrawer", () => ({
  default: function Drawer(props: DrawerProps) {
    const key = scopedThreadKey(props.threadRef);
    useEffect(() => {
      fixture.drawers.set(key, props);
    }, [key, props]);
    useEffect(() => {
      fixture.mounts.set(key, (fixture.mounts.get(key) ?? 0) + 1);
      return () => {
        fixture.drawers.delete(key);
      };
    }, [key]);
    return null;
  },
}));
// Importing the conversation implementation would make this isolated document fail immediately.
vi.mock("./ChatView", () => {
  throw new Error("terminal document imported ChatView");
});

const environmentId = EnvironmentId.make("env-a");
const refA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const refB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));
const now = "2026-09-07T12:00:00.000Z";
const project: Project = {
  id: ProjectId.make("project"),
  environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  createdAt: now,
  updatedAt: now,
  scripts: [
    { id: "test", name: "Test", command: "vp test", icon: "test", runOnWorktreeCreate: false },
  ],
};
function thread(ref: ScopedThreadRef): Thread {
  return {
    id: ref.threadId,
    environmentId: ref.environmentId,
    projectId: project.id,
    title: ref.threadId,
    modelSelection: project.defaultModelSelection!,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
  };
}
function summary(terminalId: string, changes: Partial<TerminalSummary> = {}): TerminalSummary {
  return {
    threadId: refA.threadId,
    terminalId,
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 123,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: terminalId,
    updatedAt: now,
    ...changes,
  };
}
function binding(command: KeybindingCommand): ResolvedKeybindingsConfig {
  return [
    {
      command,
      shortcut: {
        key: "x",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        modKey: false,
      },
      whenAst: { type: "identifier", name: "terminalFocus" },
    },
  ];
}
class KeyPress extends Event {
  key = "x";
  ctrlKey = true;
  metaKey = false;
  altKey = false;
  shiftKey = false;
  constructor(readonly repeat = false) {
    super("keydown", { cancelable: true, bubbles: true });
  }
}
let renderer: ReactTestRenderer | null = null;
async function mount(ref = refA) {
  await act(() => {
    renderer = create(<ThreadTerminalDocument threadRef={ref} />);
  });
}
async function update(ref = refA) {
  await act(() => {
    renderer?.update(<ThreadTerminalDocument threadRef={ref} />);
  });
}
async function press(command: KeybindingCommand, repeat = false) {
  fixture.bindings = binding(command);
  await update();
  const event = new KeyPress(repeat);
  await act(() => {
    window.dispatchEvent(event);
  });
  return event;
}
const state = (ref = refA) =>
  selectThreadTerminalUiState(useTerminalUiStateStore.getState().terminalUiStateByThreadKey, ref);
const drawer = (ref = refA) => fixture.drawers.get(scopedThreadKey(ref))!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.project = project;
  fixture.threads = new Map([
    [scopedThreadKey(refA), thread(refA)],
    [scopedThreadKey(refB), thread(refB)],
  ]);
  fixture.refs = [refA, refB];
  fixture.summaries = [];
  fixture.bindings = [];
  fixture.drawers.clear();
  fixture.mounts.clear();
  fixture.paletteOpen = false;
  fixture.supportsThreads = true;
  for (const command of [
    fixture.open,
    fixture.write,
    fixture.close,
    fixture.settle,
    fixture.unsettle,
    fixture.pin,
    fixture.unpin,
  ])
    command.mockResolvedValue(AsyncResult.success(undefined));
  fixture.confirm.mockResolvedValue(true);
  fixture.clipboard.mockResolvedValue(true);
  const storage = new Map<string, string>();
  const listeners = new Map<string, Set<(event: Event) => void>>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.get(type)?.delete(listener),
    dispatchEvent: (event: Event) => {
      // Listeners installed during dispatch do not receive the current event.
      const dispatchedListeners = Array.from(listeners.get(event.type) ?? []);
      for (const listener of dispatchedListeners) listener(event);
      return !event.defaultPrevented;
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    t3Shell: { dispatch: fixture.dispatch },
  });
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
});
afterEach(async () => {
  await act(() => {
    renderer?.unmount();
  });
  renderer = null;
  vi.unstubAllGlobals();
});

describe("dedicated thread terminals", () => {
  it("keeps identical thread IDs isolated between environments", async () => {
    const remote = scopeThreadRef(EnvironmentId.make("env-b"), refA.threadId);
    fixture.refs = [refA, remote];
    fixture.threads.set(scopedThreadKey(remote), thread(remote));
    useTerminalUiStateStore.getState().setTerminalOpen(refA, true);
    useTerminalUiStateStore.getState().setTerminalOpen(remote, true);
    await mount();
    await update(remote);
    await act(() => drawer(remote).onNewTerminal());
    expect(fixture.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentId: remote.environmentId }),
    );
    expect(state(refA).terminalIds).toEqual(["term-1"]);
    expect(state(remote).terminalIds).toEqual(["term-1", "term-2"]);
    expect(fixture.mounts.get(scopedThreadKey(refA))).toBe(1);
    expect(fixture.mounts.get(scopedThreadKey(remote))).toBe(1);
  });

  it("does not forward selections from hidden retained drawers", async () => {
    useTerminalUiStateStore.getState().setTerminalOpen(refA, true);
    useTerminalUiStateStore.getState().setTerminalOpen(refB, true);
    await mount();
    const selection = {
      terminalId: "term-1",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "output",
    };
    await update(refB);
    await act(() => drawer(refA).onAddTerminalContext(selection));
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await act(() => drawer(refB).onAddTerminalContext(selection));
    expect(fixture.dispatch).toHaveBeenCalledWith("composer.terminalContext.add", selection);
    expect(drawer(refB).focusRequestId).toBeGreaterThan(0);
  });

  it("does not write after an interrupted close or a failed script open", async () => {
    useTerminalUiStateStore.getState().setTerminalOpen(refA, true);
    await mount();
    fixture.close.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    await press("terminal.close");
    expect(fixture.write).not.toHaveBeenCalled();
    fixture.open.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("open unavailable"))));
    await press(commandForProjectScript("test")!);
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it("closes terminal panel sessions without using the drawer exit fallback", async () => {
    useRightPanelStore.getState().openTerminal(refA, "term-2");
    fixture.close.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("close unavailable"))),
    );
    await mount();
    await press("rightPanel.close");
    expect(fixture.confirm).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: refA.threadId, terminalId: "term-2", deleteHistory: true },
    });
    expect(fixture.write).not.toHaveBeenCalled();
    expect(
      useRightPanelStore.getState().byThreadKey[scopedThreadKey(refA)]?.surfaces ?? [],
    ).toEqual([]);
  });

  it("keeps stored theme changes subscribed after removing ChatView", async () => {
    const classes = new Set<string>();
    const variables = new Map<string, string>();
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {},
        classList: {
          add: (name: string) => classes.add(name),
          remove: (name: string) => classes.delete(name),
          toggle: (name: string, enabled: boolean) =>
            enabled ? classes.add(name) : classes.delete(name),
        },
        style: {
          setProperty: (name: string, value: string) => variables.set(name, value),
          removeProperty: (name: string) => variables.delete(name),
        },
      },
    });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    await mount();
    for (const theme of ["dark", "light"]) {
      window.localStorage.setItem("t3code:theme", theme);
      await act(() => {
        window.dispatchEvent(Object.assign(new Event("storage"), { key: "t3code:theme" }));
      });
      expect(classes.has("dark")).toBe(theme === "dark");
    }
  });

  it("retains A across A → B → A and discards deleted threads", async () => {
    useTerminalUiStateStore.getState().setTerminalOpen(refA, true);
    useTerminalUiStateStore.getState().setTerminalOpen(refB, true);
    await mount();
    expect(drawer().visible).toBe(true);
    await update(refB);
    expect(drawer().visible).toBe(false);
    expect(drawer(refB).visible).toBe(true);
    await update();
    expect(fixture.mounts.get(scopedThreadKey(refA))).toBe(1);
    fixture.refs = [refA];
    fixture.threads.delete(scopedThreadKey(refB));
    await update();
    expect(fixture.drawers.has(scopedThreadKey(refB))).toBe(false);
  });

  it("allocates across optimistic, server, and panel IDs without destroying a new split", async () => {
    useTerminalUiStateStore.getState().setTerminalOpen(refA, true);
    useTerminalUiStateStore.getState().ensureTerminal(refA, "term-2");
    useRightPanelStore.getState().openTerminal(refA, "term-3");
    fixture.summaries = [summary("term-1"), summary("term-3")];
    await mount();
    await press("terminal.splitVertical");
    expect(fixture.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ terminalId: "term-4" }) }),
    );
    expect(
      state().terminalGroups.some(
        (group) => group.terminalIds.includes("term-4") && group.splitDirection === "vertical",
      ),
    ).toBe(true);
    await update();
    expect(state().terminalIds).toContain("term-2");
    expect(state().terminalIds).toContain("term-4");
    expect(drawer().terminalIds).not.toContain("term-3");
  });

  it("attaches using known session locations from another document", async () => {
    useTerminalUiStateStore.getState().setTerminalOpen(refA, true);
    fixture.summaries = [
      summary("term-1", { cwd: "/worktrees/task", worktreePath: "/worktrees/task" }),
    ];
    await mount();
    expect(drawer().terminalLaunchLocationsById?.get("term-1")).toMatchObject({
      cwd: "/worktrees/task",
      worktreePath: "/worktrees/task",
      runtimeEnv: { T3CODE_PROJECT_ROOT: "/repo", T3CODE_WORKTREE_PATH: "/worktrees/task" },
    });
  });

  it("waits for close confirmation, suppresses repeats, and uses the drawer's exit fallback", async () => {
    useTerminalUiStateStore.getState().setTerminalOpen(refA, true);
    await mount();
    const confirmation = deferred<boolean>();
    fixture.confirm.mockReturnValue(confirmation.promise);
    fixture.close.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("close unavailable"))),
    );
    expect((await press("terminal.close")).defaultPrevented).toBe(true);
    expect(fixture.close).not.toHaveBeenCalled();
    await press("terminal.close", true);
    await press("terminal.close");
    expect(fixture.confirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      confirmation.resolve(true);
      await confirmation.promise;
    });
    expect(fixture.close).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: refA.threadId, terminalId: "term-1", deleteHistory: true },
    });
    expect(fixture.write).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: refA.threadId, terminalId: "term-1", data: "exit\n" },
    });
  });

  it("runs script shortcuts once and waits for open before writing", async () => {
    await mount();
    const opened = deferred<ReturnType<typeof AsyncResult.success<void>>>();
    fixture.open.mockReturnValue(opened.promise);
    const command = commandForProjectScript("test")!;
    expect((await press(command)).defaultPrevented).toBe(true);
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.write).not.toHaveBeenCalled();
    await act(async () => {
      opened.resolve(AsyncResult.success(undefined));
      await opened.promise;
    });
    expect(fixture.write).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: refA.threadId, terminalId: "term-1", data: "vp test\r" },
    });
  });

  it("keeps terminal-focus-only thread/panel commands local and stamps only the observed completion", async () => {
    fixture.threads.set(scopedThreadKey(refA), {
      ...thread(refA),
      latestTurn: {
        turnId: TurnId.make("turn"),
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
    });
    await mount();
    expect(useUiStateStore.getState().threadLastVisitedAtById[scopedThreadKey(refA)]).toBe(now);
    await press("thread.pin");
    await press("thread.settle");
    await press("thread.copyReference");
    expect(fixture.pin).toHaveBeenCalledWith(refA);
    expect(fixture.settle).toHaveBeenCalledWith(refA);
    expect(fixture.clipboard).toHaveBeenCalledTimes(1);
    expect((await press("diff.toggle")).defaultPrevented).toBe(true);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(refA)]?.isOpen).toBe(true);
    await press("rightPanel.toggle");
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(refA)]?.isOpen).toBe(false);
    expect((await press("modelPicker.toggle")).defaultPrevented).toBe(true);
    expect((await press("rightPanel.toggleMaximized")).defaultPrevented).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("consumes unsupported thread actions but leaves panel-close without a surface untouched", async () => {
    fixture.supportsThreads = false;
    await mount();
    expect((await press("thread.pin")).defaultPrevented).toBe(true);
    expect((await press("thread.settle")).defaultPrevented).toBe(true);
    expect(fixture.pin).not.toHaveBeenCalled();
    expect(fixture.settle).not.toHaveBeenCalled();
    expect((await press("rightPanel.close")).defaultPrevented).toBe(false);
    fixture.paletteOpen = true;
    await press("terminal.new");
    expect(fixture.open).not.toHaveBeenCalled();
  });
});

describe("shared terminal launch state", () => {
  it("keeps script overrides local and clears them on thread switch", async () => {
    let actions!: ReturnType<typeof useThreadTerminalActions>;
    function Inline({ threadRef }: { threadRef: ScopedThreadRef }) {
      const terminals = useThreadTerminalSessionState(threadRef);
      const value = useThreadTerminalActions({
        environmentId: threadRef.environmentId,
        activeThreadRef: threadRef,
        activeThread: fixture.threads.get(scopedThreadKey(threadRef)),
        activeProject: project,
        terminals,
        setThreadError: () => {},
        focusComposer: () => {},
      });
      useEffect(() => {
        actions = value;
      }, [value]);
      return (
        <ThreadTerminals
          threadRef={threadRef}
          launchContext={value.activeTerminalLaunchContext}
          focusRequestId={value.terminalFocusRequestId}
          keybindings={[]}
          onAddTerminalContext={() => {}}
        />
      );
    }
    await act(() => {
      renderer = create(<Inline threadRef={refA} />);
    });
    await act(() =>
      actions.runProjectScript(project.scripts[0]!, {
        cwd: "/worktrees/new",
        worktreePath: "/worktrees/new",
      }),
    );
    await act(() => drawer().onNewTerminal());
    expect(fixture.open).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ cwd: "/worktrees/new", worktreePath: "/worktrees/new" }),
      }),
    );
    await act(() => actions.createNewTerminal());
    expect(fixture.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ cwd: "/repo" }) }),
    );
    await act(() => {
      renderer?.update(<Inline threadRef={refB} />);
    });
    expect(actions.activeTerminalLaunchContext).toBeNull();
    await act(() => {
      renderer?.unmount();
      renderer = null;
    });
    await mount();
    expect(drawer().cwd).toBe("/repo");
  });
});
