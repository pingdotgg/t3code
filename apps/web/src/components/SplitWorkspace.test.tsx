// @vitest-environment jsdom
import { act, useEffect, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "~/rightPanelStore";
import { defaultWorkspaceLayout, moveWorkspaceSurface } from "~/rightPanelLayout";
import { SplitWorkspace } from "./SplitWorkspace";
import type { RightPanelTabsProps } from "./RightPanelTabs";

vi.mock("./RightPanelTabs", () => ({
  RightPanelTabs: (props: RightPanelTabsProps) => (
    <div>
      {props.surfaces.map((surface) => (
        <div key={surface.id}>
          <button
            aria-label={`${surface.id}:others`}
            onClick={() => props.onCloseOtherSurfaces(surface)}
          >
            Close others
          </button>
          <button
            aria-label={`${surface.id}:right`}
            onClick={() => props.onCloseSurfacesToRight(surface)}
          >
            Close to right
          </button>
          <button aria-label={`${surface.id}:all`} onClick={() => props.onCloseAllSurfaces()}>
            Close all
          </button>
        </div>
      ))}
    </div>
  ),
}));
it("keeps mounted resource identity and draft DOM state when moved, maximized and reset", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let starts = 0;
  let stops = 0;
  function Resource() {
    useEffect(() => {
      starts++;
      return () => {
        stops++;
      };
    }, []);
    return <textarea aria-label="Resource draft" defaultValue="Unsaved file text" />;
  }
  const ref = scopeThreadRef(EnvironmentId.make("desktop"), ThreadId.make("workspace"));
  const initial = useRightPanelStore.getState();
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.getState().openTerminal(ref, "persistent-pty");
  const state = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]!;
  const terminalId = state.surfaces[0]!.id;
  const tabs = makeTabs(ref.environmentId);
  const render = async (
    workspaceLayout = defaultWorkspaceLayout([terminalId]),
    maximizedPaneId: string | null = null,
  ) => {
    await act(async () =>
      root.render(
        <SplitWorkspace
          threadRef={ref}
          state={{ ...state, workspaceLayout, maximizedPaneId }}
          conversation={<input aria-label="Composer draft" defaultValue="Original prompt" />}
          renderSurface={() => <Resource />}
          tabs={tabs}
        />,
      ),
    );
  };
  try {
    await render();
    const input = container.querySelector("input")!;
    const resource = container.querySelector("textarea")!;
    input.value = "Still typing";
    resource.value = "Unsent edit";
    const moved = moveWorkspaceSurface(
      defaultWorkspaceLayout([terminalId]),
      terminalId,
      "conversation-pane",
      "bottom",
      "bottom-pane",
    );
    await render(moved);
    await render(moved, "bottom-pane");
    await render();
    expect(container.querySelector("input")).toBe(input);
    expect(container.querySelector("textarea")).toBe(resource);
    expect(input.value).toBe("Still typing");
    expect(resource.value).toBe("Unsent edit");
    expect(starts).toBe(1);
    expect(stops).toBe(0);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.surfaces).toEqual(
      state.surfaces,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useRightPanelStore.setState(initial, true);
  }
  expect(stops).toBe(1);
});

function makeTabs(environmentId: EnvironmentId): ComponentProps<typeof SplitWorkspace>["tabs"] {
  return {
    environmentId: environmentId,
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate: vi.fn(),
    onCloseSurface: vi.fn(),
    onCloseOtherSurfaces: vi.fn(),
    onCloseSurfacesToRight: vi.fn(),
    onCloseAllSurfaces: vi.fn(),
    onCopyFilePath: vi.fn(),
    onAddBrowser: vi.fn(),
    onAddBrowserInProfile: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddPullRequest: vi.fn(),
    onAddPullRequests: vi.fn(),
    onAddDevice: vi.fn(),
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: true,
    pullRequestsAvailable: true,
    deviceAvailable: false,
  };
}

it.each(["others", "right", "all"])(
  "scopes %s to the pane's own tab order without disturbing another pane",
  async (action) => {
    const initial = useRightPanelStore.getState();
    const ref = scopeThreadRef(EnvironmentId.make("desktop"), ThreadId.make("close-menu"));
    useRightPanelStore.setState({ byThreadKey: {} });
    for (const id of ["a", "b", "c"]) useRightPanelStore.getState().openTerminal(ref, id);
    useRightPanelStore.getState().setWorkspaceLayout(ref, {
      type: "split",
      id: "root",
      axis: "horizontal",
      ratio: 0.5,
      first: {
        type: "group",
        id: "left",
        tabs: ["terminal:c", "terminal:a"],
        active: "terminal:c",
      },
      second: {
        type: "group",
        id: "right",
        tabs: ["conversation", "terminal:b"],
        active: "terminal:b",
      },
    });
    const closed: string[] = [];
    const tabs = {
      ...makeTabs(ref.environmentId),
      onCloseSurface: (surface: RightPanelTabsProps["surfaces"][number]) => {
        closed.push(surface.id);
        useRightPanelStore.getState().closeSurface(ref, surface.id);
      },
    };
    function Workspace() {
      const state = useRightPanelStore((store) => store.byThreadKey[scopedThreadKey(ref)]!);
      return (
        <SplitWorkspace
          threadRef={ref}
          state={state}
          tabs={tabs}
          conversation={<div>Conversation</div>}
          renderSurface={(surface) => (
            <textarea aria-label={surface.id} defaultValue="Unsaved input" />
          )}
        />
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Workspace />));
      const unaffected = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="terminal:b"]',
      )!;
      unaffected.value = "Still working";
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(`button[aria-label="terminal:c:${action}"]`)!
          .click(),
      );
      expect(closed).toEqual(action === "all" ? ["terminal:c", "terminal:a"] : ["terminal:a"]);
      expect(container.querySelector('textarea[aria-label="terminal:b"]')).toBe(unaffected);
      expect(unaffected.value).toBe("Still working");
      expect(
        useRightPanelStore
          .getState()
          .byThreadKey[scopedThreadKey(ref)]!.surfaces.map((surface) => surface.id),
      ).toEqual(action === "all" ? ["terminal:b"] : ["terminal:b", "terminal:c"]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useRightPanelStore.setState(initial, true);
    }
  },
);

it.each(["pointerup", "pointercancel", "lostpointercapture"])(
  "previews a resize without persistence and handles %s without remounting resources",
  async (finish) => {
    const initial = useRightPanelStore.getState();
    const ref = scopeThreadRef(EnvironmentId.make("desktop"), ThreadId.make("resize"));
    useRightPanelStore.setState({ byThreadKey: {} });
    useRightPanelStore.getState().openTerminal(ref, "pty");
    const persisted = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]!;
    const tabs = makeTabs(ref.environmentId);
    function Workspace() {
      const state = useRightPanelStore((store) => store.byThreadKey[scopedThreadKey(ref)]!);
      return (
        <SplitWorkspace
          threadRef={ref}
          state={state}
          tabs={tabs}
          conversation={<input defaultValue="Prompt" />}
          renderSurface={() => <textarea defaultValue="Unsaved" />}
        />
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let saves = 0;
    const unsubscribe = useRightPanelStore.subscribe(() => {
      saves++;
    });
    const dispatch = async (target: Element, type: string, clientX = 0) => {
      const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      await act(async () => {
        target.dispatchEvent(event);
      });
    };
    try {
      await act(async () => root.render(<Workspace />));
      const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
      separator.setPointerCapture = vi.fn();
      separator.releasePointerCapture = vi.fn();
      const workspace = container.querySelector<HTMLElement>("[data-workspace-scope]")!;
      workspace.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        toJSON() {},
      });
      const draft = container.querySelector("textarea")!;
      draft.value = "Still typing";
      await dispatch(separator, "pointerdown", 550);
      await dispatch(separator, "pointermove", 600);
      await dispatch(separator, "pointermove", 700);
      expect(separator.getAttribute("aria-valuenow")).toBe("70");
      expect(saves).toBe(0);
      expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toBe(persisted);
      await dispatch(separator, finish, 700);
      expect(saves).toBe(finish === "pointerup" ? 1 : 0);
      expect(separator.getAttribute("aria-valuenow")).toBe(finish === "pointerup" ? "70" : "55");
      expect(container.querySelector("textarea")).toBe(draft);
      expect(draft.value).toBe("Still typing");
      await act(async () => {
        separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      });
      expect(saves).toBe(finish === "pointerup" ? 2 : 1);
      expect(separator.getAttribute("aria-valuenow")).toBe(finish === "pointerup" ? "75" : "60");
    } finally {
      unsubscribe();
      await act(async () => root.unmount());
      container.remove();
      useRightPanelStore.setState(initial, true);
    }
  },
);
