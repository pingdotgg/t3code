import * as Cause from "effect/Cause";
import { act, createContext, useContext, useEffect, useState, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createExtensionHost } from "@t3tools/extension-sdk/host";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createTerminalExtension, type TerminalBindings } from "./index";
import { NativeTerminalDock } from "../nativePanels";
import {
  PersistentThreadTerminalDrawer,
  PersistentThreadTerminalPanel,
} from "./PersistentThreadTerminal";
import ThreadTerminalDrawer from "../../components/ThreadTerminalDrawer";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";

const fixture = vi.hoisted(() => ({
  project: { workspaceRoot: "/fixture/project" } as { workspaceRoot: string } | null,
  sessions: [
    {
      target: { terminalId: "term-1" },
      state: { summary: { cwd: "/fixture/one", worktreePath: null } },
    },
    {
      target: { terminalId: "term-2" },
      state: { summary: { cwd: "/fixture/two", worktreePath: "/fixture/worktree" } },
    },
  ],
  panels: [{ kind: "terminal", terminalIds: ["term-2"] }],
  mounts: 0,
  unmounts: 0,
  open: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  write: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  close: vi.fn(
    async (_input: unknown): Promise<{ _tag: string; cause?: Cause.Cause<unknown> }> => ({
      _tag: "Success",
    }),
  ),
}));
vi.mock("../../components/AgentsPanel", () => ({ AgentsPanel: () => null }));
vi.mock("../../components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("../../components/pullRequest/PullRequestGhosts", () => ({
  PullRequestDetailGhost: () => null,
}));
vi.mock("../../components/pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: () => null,
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (value: { getDraftThreadByRef: () => null }) => unknown) =>
    selector({ getDraftThreadByRef: () => null }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ projectId: "project" }),
  useThread: () => ({ environmentId: "env", projectId: "project", worktreePath: null }),
  useProject: () => fixture.project,
}));
vi.mock("../../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => fixture.sessions,
}));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: (selector: (value: { byThreadKey: object }) => unknown) =>
    selector({ byThreadKey: {} }),
  selectThreadRightPanelState: () => ({ surfaces: fixture.panels }),
}));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { open: "open", write: "write", close: "close" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "open" | "write" | "close") => fixture[name],
}));
// A stateful viewport test double observes React viewer retention. It does not emulate a PTY.
vi.mock("../../components/ThreadTerminalDrawer", () => ({
  default: function Viewport(props: ComponentProps<typeof ThreadTerminalDrawer>) {
    const [selection, setSelection] = useState("");
    useEffect(() => {
      fixture.mounts++;
      return () => {
        fixture.unmounts++;
      };
    }, []);
    return (
      <section>
        <button onClick={props.onNewTerminal}>new</button>
        <button onClick={props.onSplitTerminalVertical}>split vertically</button>
        <button onClick={() => props.onCloseTerminal(props.activeTerminalId)}>terminate</button>
        <button onClick={() => setSelection("選択 🌈")}>select</button>
        <output>{selection}</output>
      </section>
    );
  },
}));

const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
const Bindings = createContext<TerminalBindings | null>(null);
function useBindings() {
  const value = useContext(Bindings);
  if (!value) throw new Error("Missing terminal bindings");
  return value;
}
const record = (placement: "side-panel" | "bottom-dock"): ViewRecord => ({
  version: 1,
  surfaceId: "t3.terminal/view",
  stateVersion: 1,
  restoreState: null,
  placement,
  fallback: "Terminal unavailable",
  context: {
    client: "web",
    resource: {
      namespace: "t3.terminal",
      id: "viewer",
      environmentId: "env",
      projectId: "project",
      threadId: "thread",
    },
  },
});
function drawerBindings(): TerminalBindings {
  return {
    placement: "bottom-dock",
    props: {
      threadRef: ref,
      threadId: ref.threadId,
      active: true,
      launchContext: null,
      focusRequestId: 2,
      splitShortcutLabel: "split",
      splitVerticalShortcutLabel: "vertical",
      newShortcutLabel: "new",
      closeShortcutLabel: "close",
      keybindings: [],
      onAddTerminalContext: vi.fn(),
    },
  };
}
function panelBindings(): TerminalBindings {
  return {
    placement: "side-panel",
    props: {
      threadRef: ref,
      visible: true,
      launchContext: null,
      focusRequestId: 2,
      surface: {
        id: "terminal:term-2",
        kind: "terminal",
        resourceId: "term-2",
        terminalIds: ["term-2"],
        activeTerminalId: "term-2",
        splitDirection: "vertical",
      },
      keybindings: [],
      onAddTerminalContext: vi.fn(),
      onSplitTerminal: vi.fn(),
      onSplitTerminalVertical: vi.fn(),
      onNewTerminal: vi.fn(),
      onActiveTerminalChange: vi.fn(),
      onCloseTerminal: vi.fn(),
    },
  };
}
let renderer: ReactTestRenderer | undefined;
let host: ReturnType<typeof createExtensionHost<SurfaceRenderer>> | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  fixture.mounts = 0;
  fixture.unmounts = 0;
  fixture.project = { workspaceRoot: "/fixture/project" };
  fixture.close.mockResolvedValue({ _tag: "Success" });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useTerminalUiStateStore.getState().ensureTerminal(ref, "term-1");
  useTerminalUiStateStore.getState().setTerminalOpen(ref, true);
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    host?.dispose();
  });
  renderer = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});
async function mount(bindings: TerminalBindings, registered = true) {
  host = createExtensionHost<SurfaceRenderer>({ authorize: () => false });
  host.register(createTerminalExtension(useBindings));
  const viewId = await host.open(record(bindings.placement));
  await act(async () => {
    renderer = create(
      <Bindings value={bindings}>
        {registered ? (
          <ExtensionSurface host={host!} viewId={viewId} />
        ) : bindings.placement === "bottom-dock" ? (
          <PersistentThreadTerminalDrawer {...bindings.props} />
        ) : (
          <PersistentThreadTerminalPanel {...bindings.props} />
        )}
      </Bindings>,
    );
  });
  return viewId;
}
const viewport = () =>
  renderer!.root.findByType(ThreadTerminalDrawer).props as ComponentProps<
    typeof ThreadTerminalDrawer
  >;
async function click(label: string) {
  await act(async () =>
    renderer!.root
      .findAllByType("button")
      .find((button) => button.children[0] === label)!
      .props.onClick(),
  );
}
const state = () =>
  selectThreadTerminalUiState(useTerminalUiStateStore.getState().terminalUiStateByThreadKey, ref);

describe.each([false, true])("terminal native composition (registered=%s)", (registered) => {
  it("allocates against panel sessions and optimistic client IDs while preserving vertical split groups", async () => {
    await mount(drawerBindings(), registered);
    await click("split vertically");
    expect(state().terminalIds).toEqual(["term-1", "term-3"]);
    expect(state().terminalGroups[0]?.splitDirection).toBe("vertical");
    await click("new");
    expect(state().terminalIds).toEqual(["term-1", "term-3", "term-4"]);
    expect(fixture.open.mock.calls.map(([input]) => input)).toEqual([
      {
        environmentId: "env",
        input: {
          threadId: "thread",
          terminalId: "term-3",
          cwd: "/fixture/project",
          env: expect.any(Object),
        },
      },
      {
        environmentId: "env",
        input: {
          threadId: "thread",
          terminalId: "term-4",
          cwd: "/fixture/project",
          env: expect.any(Object),
        },
      },
    ]);
  });
  it("explicit termination removes the terminal and preserves the close-failure exit fallback", async () => {
    fixture.close.mockResolvedValue({ _tag: "Failure", cause: Cause.fail("offline") });
    await mount(drawerBindings(), registered);
    await click("terminate");
    expect(fixture.close).toHaveBeenCalledWith({
      environmentId: "env",
      input: { threadId: "thread", terminalId: "term-1", deleteHistory: true },
    });
    expect(fixture.write).toHaveBeenCalledWith({
      environmentId: "env",
      input: { threadId: "thread", terminalId: "term-1", data: "exit\n" },
    });
    expect(state().terminalOpen).toBe(false);
  });
  it("keeps panel-specific launch directory, environment and vertical layout", async () => {
    await mount(panelBindings(), registered);
    expect(viewport().cwd).toBe("/fixture/two");
    expect(viewport().worktreePath).toBe("/fixture/worktree");
    expect(viewport().terminalGroups).toEqual([
      { id: "terminal:term-2", terminalIds: ["term-2"], splitDirection: "vertical" },
    ]);
    expect(viewport().terminalLaunchLocationsById?.get("term-2")?.cwd).toBe("/fixture/two");
  });
  it("renders nothing until the project is available", async () => {
    fixture.project = null;
    await mount(drawerBindings(), registered);
    expect(renderer!.root.findAllByType(ThreadTerminalDrawer)).toHaveLength(0);
    expect(fixture.open).not.toHaveBeenCalled();
  });
});

describe("registered Terminal lifetime", () => {
  it("closing one registered viewer preserves another viewer of the same terminal", async () => {
    const bindings = panelBindings();
    const first = await mount(bindings);
    const second = await host!.open(record("side-panel"));
    await act(async () => {
      renderer!.update(
        <Bindings value={bindings}>
          <ExtensionSurface host={host!} viewId={first} />
          <ExtensionSurface host={host!} viewId={second} />
        </Bindings>,
      );
    });
    await act(async () => {
      host!.hide(first);
    });
    expect(
      renderer!.root.findAllByType(ThreadTerminalDrawer).map((node) => node.props.visible),
    ).toEqual([false, true]);
    await act(async () => {
      host!.close(first);
    });
    expect(renderer!.root.findAllByType(ThreadTerminalDrawer)).toHaveLength(1);
    expect(viewport().visible).toBe(true);
    expect(host!.getSnapshot(second)?.status).toBe("ready");
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it.each([drawerBindings, panelBindings])(
    "retains selection through 100 hide/show cycles and releases viewer without termination",
    async (bindings) => {
      const id = await mount(bindings());
      await click("select");
      for (let index = 0; index < 100; index++) {
        await act(async () => {
          host!.hide(id);
        });
        expect(viewport().visible).toBe(false);
        await act(async () => {
          host!.show(id);
        });
        expect(viewport().visible).toBe(true);
      }
      expect(renderer!.root.findByType("output").children).toEqual(["選択 🌈"]);
      expect(fixture.mounts).toBe(1);
      expect(fixture.unmounts).toBe(0);
      await act(async () => {
        host!.close(id);
      });
      expect(fixture.unmounts).toBe(1);
      expect(fixture.close).not.toHaveBeenCalled();
      expect(fixture.write).not.toHaveBeenCalled();
      expect(host!.records()).toEqual([]);
    },
  );
  it("rejects incompatible restore before mounting the native viewer", async () => {
    host = createExtensionHost<SurfaceRenderer>({ authorize: () => false });
    host.register(createTerminalExtension(useBindings));
    const bindings = panelBindings();
    const id = await host.restore({ ...record("side-panel"), restoreState: { stale: true } });
    await act(async () => {
      renderer = create(
        <Bindings value={bindings}>
          <ExtensionSurface host={host!} viewId={id} />
        </Bindings>,
      );
    });
    expect(host.getSnapshot(id)?.status).toBe("unavailable");
    expect(fixture.mounts).toBe(0);
    expect(fixture.open).not.toHaveBeenCalled();
  });
});

it("hides the real dock SDK view while retaining its thread-owned engine and collapse subtree", async () => {
  const bindings = drawerBindings();
  if (bindings.placement !== "bottom-dock") throw new Error("Expected drawer fixture");
  await act(async () => {
    renderer = create(<NativeTerminalDock {...bindings.props} />);
  });
  const sdkView = renderer!.root.findByType(ExtensionSurface);
  const snapshot = () => sdkView.props.host.getSnapshot(sdkView.props.viewId);
  const initialViewport = renderer!.root.findByType(ThreadTerminalDrawer);
  await click("select");
  expect(snapshot().status).toBe("ready");
  await act(async () => {
    useTerminalUiStateStore.getState().setTerminalOpen(ref, false);
  });
  expect(snapshot().status).toBe("hidden");
  expect(sdkView.props.retainHiddenPresentation).toBe(true);
  expect(renderer!.root.findByType(ThreadTerminalDrawer)).toBe(initialViewport);
  expect(viewport().visible).toBe(false);
  expect(
    renderer!.root.findByProps({ presentationVisible: false, active: true }).props.threadRef,
  ).toBe(ref);
  expect(
    renderer!.root
      .findAllByType("div")
      .some((node) => node.props.className?.includes("grid-rows-[0fr]")),
  ).toBe(true);
  expect(renderer!.root.findAllByType("div").some((node) => node.props.inert === true)).toBe(true);
  await act(async () => {
    useTerminalUiStateStore.getState().setTerminalOpen(ref, true);
  });
  expect(snapshot().status).toBe("ready");
  expect(viewport().visible).toBe(true);
  expect(renderer!.root.findByType(ThreadTerminalDrawer)).toBe(initialViewport);
  await act(async () => {
    renderer!.update(<NativeTerminalDock {...bindings.props} active={false} />);
  });
  expect(snapshot().status).toBe("hidden");
  expect(viewport().visible).toBe(false);
  expect(renderer!.root.findByType(ThreadTerminalDrawer)).toBe(initialViewport);
  await act(async () => {
    renderer!.update(<NativeTerminalDock {...bindings.props} />);
  });
  expect(snapshot().status).toBe("ready");
  expect(renderer!.root.findByType("output").children).toEqual(["選択 🌈"]);
  expect(fixture.mounts).toBe(1);
  expect(fixture.unmounts).toBe(0);
  expect(fixture.close).not.toHaveBeenCalled();
  expect(fixture.write).not.toHaveBeenCalled();
  expect(viewport().terminalIds).toContain("term-1");
});
