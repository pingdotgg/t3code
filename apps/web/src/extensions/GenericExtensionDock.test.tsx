import { useEffect, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { GenericExtensionDock } from "./GenericExtensionDock";
import { NativeRightPanel, NativeTerminalDock, type NativePanelBindings } from "./nativePanels";
import { registerWorkspaceExtension } from "./workspaceRegistry";
import {
  extensionPanelSurface,
  selectThreadExtensionDock,
  useRightPanelStore,
} from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

const native = vi.hoisted(() => ({ mounts: 0, disposals: 0 }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (value: { panelAnimationDurationMs: number }) => unknown) =>
    select({ panelAnimationDurationMs: 0 }),
}));
// The actual NativeTerminalDock/SDK bridge stays mounted; this stateful engine probe
// detects sibling teardown. It is not a PTY or native-terminal rendering proof.
vi.mock("./terminal/PersistentThreadTerminal", () => ({
  PersistentThreadTerminalDrawer: function TerminalEngineProbe() {
    const [text, setText] = useState("retained");
    useEffect(() => {
      native.mounts++;
      return () => {
        native.disposals++;
      };
    }, []);
    return (
      <button aria-label="Native terminal probe" onClick={() => setText("typed")}>
        {text}
      </button>
    );
  },
  PersistentThreadTerminalPanel: () => null,
}));
vi.mock("../components/AgentsPanel", () => ({ AgentsPanel: () => null }));
vi.mock("../components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("../components/pullRequest/PullRequestGhosts", () => ({
  PullRequestDetailGhost: () => null,
}));
vi.mock("../components/pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: () => null,
}));
vi.mock("../state/entities", () => ({ useThreadShell: () => ({ projectId: "shared-project" }) }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (state: { getDraftThreadByRef: () => null }) => unknown) =>
    select({ getDraftThreadByRef: () => null }),
}));

const a = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("a"));
const b = scopeThreadRef(a.environmentId, ThreadId.make("b"));
const record: ViewRecord = {
  version: 1,
  surfaceId: "community.dock/view",
  stateVersion: 1,
  placement: "bottom-dock",
  restoreState: 0,
  fallback: "Dock contribution unavailable",
  context: {
    client: "web",
    resource: {
      namespace: "community.dock",
      id: "counter",
      environmentId: a.environmentId,
      projectId: "shared-project",
    },
  },
};
const dock = (ref = a) =>
  selectThreadExtensionDock(useRightPanelStore.getState().extensionDockByThreadKey, ref);
const unusedBindings: NativePanelBindings = {
  browser: null,
  files: null,
  terminal: null,
  versionControl: null,
  get diff(): NativePanelBindings["diff"] {
    throw new Error("Unexpected diff bindings");
  },
  get agents(): NativePanelBindings["agents"] {
    throw new Error("Unexpected agents bindings");
  },
};
function registerCounter() {
  const restored: number[] = [];
  const visibility: boolean[] = [];
  let disposals = 0;
  const unregister = registerWorkspaceExtension({
    manifest: {
      id: "community.dock",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [
        {
          id: record.surfaceId,
          title: "Counter",
          scope: "project",
          clients: ["web"],
          placements: ["side-panel", "bottom-dock", "full-page", "compact-detail"],
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
    surfaces: [
      {
        id: record.surfaceId,
        validateRestore: (value) => typeof value === "number",
        createView(session) {
          const initial = session.restoreState;
          if (typeof initial !== "number") throw new Error("Invalid counter state");
          restored.push(initial);
          session.onVisibility((visible) => visibility.push(visible));
          return {
            dispose() {
              disposals++;
            },
            renderer: function Counter() {
              const [count, setCount] = useState(initial);
              return (
                <button
                  aria-label="Increment dock counter"
                  onClick={() => {
                    setCount(count + 1);
                    session.save(count + 1);
                  }}
                >
                  {count}
                </button>
              );
            },
          };
        },
      },
    ],
  });
  return { unregister, restored, visibility, disposals: () => disposals };
}
function button(root: ReactTestRenderer, name: string) {
  const found = root.root.findAllByType("button").find((node) => node.props["aria-label"] === name);
  if (!found) throw new Error("Missing button: " + name);
  return found;
}
function Shell({ threadRef }: { threadRef: ScopedThreadRef }) {
  return (
    <>
      <GenericExtensionDock threadRef={threadRef} />
      <NativeTerminalDock
        key="native-terminal"
        threadRef={a}
        threadId={a.threadId}
        active
        launchContext={null}
        focusRequestId={0}
        splitShortcutLabel={undefined}
        splitVerticalShortcutLabel={undefined}
        newShortcutLabel={undefined}
        closeShortcutLabel={undefined}
        keybindings={[]}
        onAddTerminalContext={() => {}}
      />
    </>
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.mounts = 0;
  native.disposals = 0;
  useRightPanelStore.setState({
    byThreadKey: {},
    extensionDockByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useTerminalUiStateStore.getState().ensureTerminal(a, "term-1");
  useTerminalUiStateStore.getState().setTerminalOpen(a, true);
});

describe("generic extension dock composition", () => {
  it("retains hidden state, restores separate project counters for A/B, and does not tear down the native terminal sibling", async () => {
    const counter = registerCounter();
    const store = useRightPanelStore.getState();
    const terminalState = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
    store.openExtension(a, record);
    store.openExtension(b, record);
    let root: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        root = create(<Shell threadRef={a} />);
      });
      await act(async () => {
        button(root!, "Native terminal probe").props.onClick();
      });
      await act(async () => {
        button(root!, "Increment dock counter").props.onClick();
      });
      await act(async () => {
        button(root!, "Hide extension dock").props.onClick();
      });
      expect(counter.visibility.at(-1)).toBe(false);
      expect(counter.disposals()).toBe(0);
      expect(dock().surfaces[0]?.record.restoreState).toBe(1);
      await act(async () => {
        store.showExtensionDock(a);
      });
      expect(button(root!, "Increment dock counter").children).toEqual(["1"]);
      expect(counter.restored).toEqual([0]);
      await act(async () => {
        root!.update(<Shell threadRef={b} />);
      });
      expect(button(root!, "Increment dock counter").children).toEqual(["0"]);
      await act(async () => {
        button(root!, "Increment dock counter").props.onClick();
      });
      await act(async () => {
        button(root!, "Increment dock counter").props.onClick();
      });
      expect(dock(a).surfaces[0]?.record.restoreState).toBe(1);
      expect(dock(b).surfaces[0]?.record.restoreState).toBe(2);
      await act(async () => {
        root!.update(<Shell threadRef={a} />);
      });
      expect(button(root!, "Increment dock counter").children).toEqual(["1"]);
      await act(async () => {
        root!.update(<Shell threadRef={b} />);
      });
      expect(button(root!, "Increment dock counter").children).toEqual(["2"]);
      expect(counter.restored).toEqual([0, 0, 1, 2]);
      await act(async () => {
        button(root!, "Close Counter").props.onClick();
      });
      expect(dock(b).surfaces).toEqual([]);
      expect(button(root!, "Native terminal probe").children).toEqual(["typed"]);
      expect(native.mounts).toBe(1);
      expect(native.disposals).toBe(0);
      expect(useTerminalUiStateStore.getState().terminalUiStateByThreadKey).toBe(terminalState);
    } finally {
      await act(async () => {
        root?.unmount();
        counter.unregister();
      });
    }
  });

  it("does not start a cold hidden record and recovers saved state after unregister/re-register", async () => {
    const store = useRightPanelStore.getState();
    store.openExtension(a, { ...record, restoreState: 4 });
    store.hideExtensionDock(a);
    let counter = registerCounter();
    let root: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        root = create(<GenericExtensionDock threadRef={a} />);
      });
      expect(counter.restored).toEqual([]);
      await act(async () => {
        store.showExtensionDock(a);
      });
      expect(button(root!, "Increment dock counter").children).toEqual(["4"]);
      await act(async () => {
        button(root!, "Increment dock counter").props.onClick();
      });
      await act(async () => {
        counter.unregister();
      });
      expect(root!.root.findByProps({ role: "status" }).children).toEqual([record.fallback]);
      expect(dock().surfaces[0]?.record.restoreState).toBe(5);
      await act(async () => {
        counter = registerCounter();
      });
      expect(button(root!, "Increment dock counter").children).toEqual(["5"]);
      expect(counter.restored).toEqual([5]);
    } finally {
      await act(async () => {
        root?.unmount();
        counter.unregister();
      });
    }
  });

  it("keeps explicitly opened side and dock viewers independent", async () => {
    const counter = registerCounter();
    const store = useRightPanelStore.getState();
    const sideRecord: ViewRecord = { ...record, placement: "side-panel" };
    store.openExtension(a, sideRecord);
    store.openExtension(a, record);
    const surface = Object.values(useRightPanelStore.getState().byThreadKey)[0]!.surfaces.find(
      (entry) => entry.kind === "extension",
    )!;
    let root: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        root = create(
          <>
            <section aria-label="Side viewer">
              <NativeRightPanel
                surface={surface}
                threadRef={a}
                context={record.context}
                visible
                bindings={unusedBindings}
              />
            </section>
            <GenericExtensionDock threadRef={a} />
          </>,
        );
      });
      const sideButton = root!.root.findByType("section").findByType("button");
      await act(async () => {
        sideButton.props.onClick();
      });
      const dockButton = root!.root
        .findByType("aside")
        .findAllByType("button")
        .find((node) => node.props["aria-label"] === "Increment dock counter");
      if (!dockButton) throw new Error("Missing dock counter");
      await act(async () => {
        dockButton.props.onClick();
      });
      await act(async () => {
        dockButton.props.onClick();
      });
      expect(root!.root.findByType("section").findByType("button").children).toEqual(["1"]);
      expect(dock().surfaces[0]?.record.restoreState).toBe(2);
      expect(
        Object.values(useRightPanelStore.getState().byThreadKey)[0]?.surfaces[0],
      ).toMatchObject({
        record: { placement: "side-panel", restoreState: 1 },
      });
      await act(async () => {
        store.closeDockExtension(a, dock().surfaces[0]!.id);
      });
      expect(counter.disposals()).toBe(1);
      expect(root!.root.findByType("section").findByType("button").children).toEqual(["1"]);
    } finally {
      await act(async () => {
        root?.unmount();
        counter.unregister();
      });
    }
  });

  it.each(["bottom-dock", "full-page", "compact-detail"] as const)(
    "never activates a %s record through NativeRightPanel",
    async (placement) => {
      const counter = registerCounter();
      let root: ReactTestRenderer | undefined;
      try {
        const surface = extensionPanelSurface(a, { ...record, placement });
        if (!surface) throw new Error("Invalid fixture");
        await act(async () => {
          root = create(
            <NativeRightPanel
              surface={surface}
              threadRef={a}
              context={record.context}
              visible
              bindings={unusedBindings}
            />,
          );
        });
        expect(root!.root.findByProps({ role: "status" }).children.join("")).toContain(
          "unavailable here",
        );
        expect(counter.restored).toEqual([]);
      } finally {
        await act(async () => {
          root?.unmount();
          counter.unregister();
        });
      }
    },
  );
});

it("drags the dock frame taller and persists the height per thread", async () => {
  const counter = registerCounter();
  const store = useRightPanelStore.getState();
  store.openExtension(a, record);
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    value: { innerHeight: 1200 },
    configurable: true,
    writable: true,
  });
  let root: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      root = create(<GenericExtensionDock threadRef={a} />);
    });
    const frame = () => root!.root.findByProps({ "aria-label": "Extension dock" });
    expect(frame().props.style.height).toBe("256px");
    const handle = root!.root
      .findAllByType("div")
      .find((node) => typeof node.props.onPointerDown === "function")!;
    const target = {
      setPointerCapture: () => {},
      hasPointerCapture: () => true,
      releasePointerCapture: () => {},
    };
    await act(async () => {
      handle.props.onPointerDown({
        button: 0,
        pointerId: 1,
        clientY: 700,
        currentTarget: target,
        preventDefault: () => {},
      });
      handle.props.onPointerMove({
        pointerId: 1,
        clientY: 400,
        currentTarget: target,
        preventDefault: () => {},
      });
    });
    expect(frame().props.style.height).toBe("556px");
    await act(async () => {
      handle.props.onPointerUp({ pointerId: 1, currentTarget: target });
    });
    expect(dock().height).toBe(556);
    expect(frame().props.style.height).toBe("556px");
    await act(async () => {
      handle.props.onPointerDown({
        button: 0,
        pointerId: 2,
        clientY: 100,
        currentTarget: target,
        preventDefault: () => {},
      });
      handle.props.onPointerMove({
        pointerId: 2,
        clientY: 5000,
        currentTarget: target,
        preventDefault: () => {},
      });
      handle.props.onPointerUp({ pointerId: 2, currentTarget: target });
    });
    expect(dock().height).toBe(160);
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      globalThis.window = previousWindow;
    }
    await act(async () => {
      root?.unmount();
      counter.unregister();
    });
  }
});

it("does not activate a cold successor when the visible viewer is closed while hidden", async () => {
  const counter = registerCounter(),
    store = useRightPanelStore.getState();
  const second = {
    ...record,
    restoreState: 8,
    context: { ...record.context, resource: { ...record.context.resource, id: "second-counter" } },
  };
  store.openExtension(a, second);
  store.openExtension(a, record);
  const firstId = dock().activeSurfaceId!;
  let root: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      root = create(<GenericExtensionDock threadRef={a} />);
    });
    expect(counter.restored).toEqual([0]);
    await act(async () => {
      store.hideExtensionDock(a);
    });
    await act(async () => {
      store.closeDockExtension(a, firstId);
    });
    expect(counter.restored).toEqual([0]);
    expect(counter.disposals()).toBe(1);
    expect(root!.root.findAllByProps({ "aria-label": "Increment dock counter" })).toHaveLength(0);
    await act(async () => {
      store.showExtensionDock(a);
    });
    expect(counter.restored).toEqual([0, 8]);
    expect(button(root!, "Increment dock counter").children).toEqual(["8"]);
  } finally {
    await act(async () => {
      root?.unmount();
      counter.unregister();
    });
  }
});
