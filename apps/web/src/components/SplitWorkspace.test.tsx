// @vitest-environment jsdom
import { act, useEffect, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "~/rightPanelStore";
import { defaultWorkspaceLayout, moveWorkspaceSurface } from "~/rightPanelLayout";
import { SplitWorkspace } from "./SplitWorkspace";

vi.mock("./RightPanelTabs", () => ({ RightPanelTabs: () => null }));
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
  const tabs: ComponentProps<typeof SplitWorkspace>["tabs"] = {
    environmentId: ref.environmentId,
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
