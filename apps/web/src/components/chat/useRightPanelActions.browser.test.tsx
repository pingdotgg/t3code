import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { __testing } from "../../previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useDeviceState } from "../../state/device";
import { useRightPanelActions } from "./useRightPanelActions";

it("remembers the browser's maximized size when toggling the side panel", async () => {
  const ref = scopeThreadRef(EnvironmentId.make("panel-test"), ThreadId.make("panel-test"));
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.getState().openBrowser(ref, null);
  useRightPanelStore.getState().setMaximized(ref, true);

  function Panel() {
    const panel = useRightPanelStore((state) =>
      selectThreadRightPanelState(state.byThreadKey, ref),
    );
    const device = useDeviceState(null);
    const actions = useRightPanelActions({
      activeThreadRef: ref,
      activeProject: null,
      activeRightPanelSurface:
        panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null,
      activePreviewState: __testing.EMPTY_THREAD_PREVIEW_STATE,
      deviceState: device.state,
      deviceStateLoaded: false,
      pullRequestPanelTarget: null,
      threadPanelPresentation: "inline",
      isServerThread: true,
      embedded: false,
      isGitRepo: false,
      browserAvailable: true,
      canOperatePreview: true,
      diffOpen: false,
      previewPanelOpen: panel.isOpen,
      rightPanelOpen: panel.isOpen,
      canMaximizeRightPanel: panel.isOpen,
      rightPanelMaximized: panel.isOpen && panel.maximized === true,
      supportsPullRequests: false,
      pullRequestsSurfaceAvailable: false,
      gitCwd: null,
      activeProjectCwd: null,
      explicitDiffOpenRef: { current: null },
      onDiffPanelOpen: undefined,
      closeRightPanelSurface: () => undefined,
    });
    return <button onClick={actions.toggleRightPanelStable}>Toggle panel</button>;
  }

  await using screen = await render(<Panel />);
  const toggle = screen.getByRole("button", { name: "Toggle panel" });
  await toggle.click();
  expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
    false,
  );
  await toggle.click();
  const reopened = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  expect(reopened.isOpen).toBe(true);
  expect(reopened.maximized).toBe(true);
});
