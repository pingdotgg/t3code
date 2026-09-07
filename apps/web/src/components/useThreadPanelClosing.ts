import { type ScopedThreadRef } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { useCallback } from "react";
import { readLocalApi } from "../localApi";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import { setActivePreviewTab, useThreadPreviewState } from "../previewStateStore";
import { closePreviewSession } from "./preview/closePreviewSession";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { terminalEnvironment } from "../state/terminal";
import { agentControlledBrowserCloseConfirmation } from "./ChatView.logic";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
export function useThreadPanelClosing(
  activeThreadRef: ScopedThreadRef | null,
  activePreviewState: ReturnType<typeof useThreadPreviewState>,
  activeTerminalLabelsById: ReadonlyMap<string, string>,
) {
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const rightPanelState = useRightPanelStore((s) =>
    selectThreadRightPanelState(s.byThreadKey, activeThreadRef),
  );
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
        if (surface.kind === "terminal") {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(activeThreadRef, terminalId);
            void closeTerminalMutation({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [
      activeThreadRef,
      activePreviewState.sessions,
      closePreview,
      closeTerminalMutation,
      storeCloseTerminal,
    ],
  );
  const closeAfterAgentBrowserConfirmation = useCallback(
    (surfaces: readonly RightPanelSurface[], closeSurfaces: () => void) => {
      const message = agentControlledBrowserCloseConfirmation(
        surfaces,
        activePreviewState.desktopByTabId,
      );
      if (!message) {
        closeSurfaces();
        return;
      }
      const localApi = readLocalApi();
      if (!localApi) return;
      void localApi.dialogs.confirm(message, { variant: "destructive" }).then(
        (confirmed) => {
          if (confirmed) closeSurfaces();
        },
        () => undefined,
      );
    },
    [activePreviewState.desktopByTabId],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const finishRightPanelSurfaceClose = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      cleanupRightPanelSurfaces(surfaces);
      const store = useRightPanelStore.getState();
      for (const surface of surfaces) {
        store.closeSurface(activeThreadRef, surface.id);
      }
      syncActivePreviewSurface();
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  );
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const finishClose = () => finishRightPanelSurfaceClose([surface]);
      if (surface.kind === "preview") {
        closeAfterAgentBrowserConfirmation([surface], finishClose);
        return;
      }
      if (surface.kind !== "terminal") {
        finishClose();
        return;
      }
      const activeLabel =
        activeTerminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId);
      const otherLabels = surface.terminalIds
        .filter((terminalId) => terminalId !== surface.activeTerminalId)
        .map(
          (terminalId) => activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId),
        );
      void confirmTerminalClose([activeLabel, ...otherLabels]).then((confirmed) => {
        if (confirmed) finishClose();
      });
    },
    [
      activeThreadRef,
      activeTerminalLabelsById,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
    ],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      const finishClose = () => finishRightPanelSurfaceClose(surfaces);
      closeAfterAgentBrowserConfirmation(surfaces, finishClose);
    },
    [
      activeThreadRef,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
      rightPanelState.surfaces,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      const finishClose = () => finishRightPanelSurfaceClose(surfaces);
      closeAfterAgentBrowserConfirmation(surfaces, finishClose);
    },
    [
      activeThreadRef,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
      rightPanelState.surfaces,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    const finishClose = () => finishRightPanelSurfaceClose(rightPanelState.surfaces);
    closeAfterAgentBrowserConfirmation(rightPanelState.surfaces, finishClose);
  }, [
    activeThreadRef,
    closeAfterAgentBrowserConfirmation,
    finishRightPanelSurfaceClose,
    rightPanelState.surfaces,
  ]);

  return {
    closeRightPanelSurface,
    closeOtherRightPanelSurfaces,
    closeRightPanelSurfacesToRight,
    closeAllRightPanelSurfaces,
  };
}
