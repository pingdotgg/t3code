import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { OpenPreviewMutation } from "../browser/openFileInPreview";
import { readThreadPreviewState, setActivePreviewTab } from "../previewStateStore";
import { type RightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { openPreviewSession } from "../components/preview/openPreviewSession";

export async function copyForkWorkspace<E>(
  source: ScopedThreadRef,
  target: ScopedThreadRef,
  openPreview: OpenPreviewMutation<E>,
) {
  const sourceKey = scopedThreadKey(source);
  const targetKey = scopedThreadKey(target);
  const width = localStorage.getItem(`t3code:preview-panel-width:${sourceKey}`);
  if (width !== null) localStorage.setItem(`t3code:preview-panel-width:${targetKey}`, width);
  const panels = useRightPanelStore.getState();
  const sourcePanel = panels.byThreadKey[sourceKey];
  const visibility = panels.threadPanelVisibilityByThreadKey[sourceKey];
  const terminal = useTerminalUiStateStore.getState().terminalUiStateByThreadKey[sourceKey];
  if (terminal)
    useTerminalUiStateStore.setState((state) => ({
      terminalUiStateByThreadKey: {
        ...state.terminalUiStateByThreadKey,
        [targetKey]: structuredClone(terminal),
      },
    }));
  if (!sourcePanel) return;

  const previews = readThreadPreviewState(source);
  const surfaces: RightPanelSurface[] = [];
  let activeSurfaceId: string | null = null;
  let failed = false;
  for (const surface of sourcePanel.surfaces) {
    let copied = surface;
    if (surface.kind === "preview" && surface.resourceId !== null) {
      const snapshot = previews.sessions[surface.resourceId];
      if (!snapshot) {
        failed = true;
        continue;
      }
      const desktopNav = previews.desktopByTabId[surface.resourceId]?.navStatus;
      const nav = desktopNav && desktopNav._tag !== "Idle" ? desktopNav : snapshot.navStatus;
      const result = await openPreviewSession({
        openPreview,
        threadRef: target,
        ...(nav._tag === "Idle" ? {} : { url: nav.url }),
        ...(snapshot.profileId === undefined ? {} : { profileId: snapshot.profileId }),
        ...(snapshot.viewport === undefined ? {} : { viewport: snapshot.viewport }),
        runtime: snapshot.runtime ?? "desktop",
      });
      if (result._tag === "Failure") {
        failed = true;
        continue;
      }
      copied = {
        kind: "preview",
        id: `browser:${result.value.tabId}`,
        resourceId: result.value.tabId,
      };
    }
    surfaces.push(copied);
    if (sourcePanel.activeSurfaceId === surface.id) activeSurfaceId = copied.id;
  }
  const active = surfaces.find((surface) => surface.id === activeSurfaceId) ?? surfaces[0];
  if (active?.kind === "preview" && active.resourceId)
    setActivePreviewTab(target, active.resourceId);
  useRightPanelStore.setState((state) => ({
    byThreadKey: {
      ...state.byThreadKey,
      [targetKey]: { ...sourcePanel, surfaces, activeSurfaceId: active?.id ?? null },
    },
    threadPanelVisibilityByThreadKey: {
      ...state.threadPanelVisibilityByThreadKey,
      ...(visibility ? { [targetKey]: { ...visibility } } : {}),
    },
  }));
  if (failed)
    throw new Error("The new thread was created, but a browser tab could not be restored.");
}
