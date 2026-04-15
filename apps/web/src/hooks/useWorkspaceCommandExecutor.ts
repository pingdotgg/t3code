import type { KeybindingCommand, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  useFocusedWorkspaceSurface,
  useWorkspaceDocument,
  useWorkspaceStore,
} from "../workspace/store";
import type { WorkspaceSurfaceInstance } from "../workspace/types";

export const WORKSPACE_COMMAND_IDS = [
  "workspace.terminal.splitRight",
  "workspace.terminal.splitDown",
  "workspace.terminal.newTab",
  "workspace.pane.splitRight",
  "workspace.pane.splitDown",
  "workspace.focus.previous",
  "workspace.focus.next",
  "workspace.focus.left",
  "workspace.focus.right",
  "workspace.focus.up",
  "workspace.focus.down",
  "workspace.pane.close",
  "workspace.pane.toggleZoom",
  "workspace.pane.resizeLeft",
  "workspace.pane.resizeRight",
  "workspace.pane.resizeUp",
  "workspace.pane.resizeDown",
  "workspace.pane.equalize",
  "workspace.pane.moveLeft",
  "workspace.pane.moveRight",
  "workspace.pane.moveUp",
  "workspace.pane.moveDown",
  "workspace.tab.moveLeft",
  "workspace.tab.moveRight",
  "workspace.tab.moveUp",
  "workspace.tab.moveDown",
] as const satisfies readonly KeybindingCommand[];

export type WorkspaceCommandId = (typeof WORKSPACE_COMMAND_IDS)[number];

export const WORKSPACE_COMMAND_METADATA: Record<
  WorkspaceCommandId,
  {
    searchTerms: readonly string[];
    title: string;
  }
> = {
  "workspace.terminal.splitRight": {
    title: "Open terminal in split right",
    searchTerms: ["terminal", "split", "right", "pane", "workspace"],
  },
  "workspace.terminal.splitDown": {
    title: "Open terminal in split down",
    searchTerms: ["terminal", "split", "down", "bottom", "pane", "workspace"],
  },
  "workspace.terminal.newTab": {
    title: "Open terminal as tab",
    searchTerms: ["terminal", "tab", "pane", "workspace"],
  },
  "workspace.pane.splitRight": {
    title: "Open in split right",
    searchTerms: ["split", "pane", "right", "open", "workspace"],
  },
  "workspace.pane.splitDown": {
    title: "Open in split down",
    searchTerms: ["split", "pane", "down", "open", "workspace"],
  },
  "workspace.focus.left": {
    title: "Focus pane left",
    searchTerms: ["focus", "pane", "left", "workspace"],
  },
  "workspace.focus.previous": {
    title: "Focus previous pane",
    searchTerms: ["focus", "previous", "pane", "workspace"],
  },
  "workspace.focus.next": {
    title: "Focus next pane",
    searchTerms: ["focus", "next", "pane", "workspace"],
  },
  "workspace.focus.right": {
    title: "Focus pane right",
    searchTerms: ["focus", "pane", "right", "workspace"],
  },
  "workspace.focus.up": {
    title: "Focus pane up",
    searchTerms: ["focus", "pane", "up", "workspace"],
  },
  "workspace.focus.down": {
    title: "Focus pane down",
    searchTerms: ["focus", "pane", "down", "workspace"],
  },
  "workspace.pane.close": {
    title: "Close current pane",
    searchTerms: ["close", "pane", "window", "workspace"],
  },
  "workspace.pane.toggleZoom": {
    title: "Toggle pane zoom",
    searchTerms: ["zoom", "maximize", "pane", "workspace"],
  },
  "workspace.pane.resizeLeft": {
    title: "Resize pane left",
    searchTerms: ["resize", "pane", "left", "workspace"],
  },
  "workspace.pane.resizeRight": {
    title: "Resize pane right",
    searchTerms: ["resize", "pane", "right", "workspace"],
  },
  "workspace.pane.resizeUp": {
    title: "Resize pane up",
    searchTerms: ["resize", "pane", "up", "workspace"],
  },
  "workspace.pane.resizeDown": {
    title: "Resize pane down",
    searchTerms: ["resize", "pane", "down", "workspace"],
  },
  "workspace.pane.equalize": {
    title: "Equalize splits",
    searchTerms: ["equalize", "reset", "split", "pane", "workspace"],
  },
  "workspace.pane.moveLeft": {
    title: "Move pane left",
    searchTerms: ["move", "pane", "left", "workspace"],
  },
  "workspace.pane.moveRight": {
    title: "Move pane right",
    searchTerms: ["move", "pane", "right", "workspace"],
  },
  "workspace.pane.moveUp": {
    title: "Move pane up",
    searchTerms: ["move", "pane", "up", "workspace"],
  },
  "workspace.pane.moveDown": {
    title: "Move pane down",
    searchTerms: ["move", "pane", "down", "workspace"],
  },
  "workspace.tab.moveLeft": {
    title: "Move tab left",
    searchTerms: ["move", "tab", "left", "workspace"],
  },
  "workspace.tab.moveRight": {
    title: "Move tab right",
    searchTerms: ["move", "tab", "right", "workspace"],
  },
  "workspace.tab.moveUp": {
    title: "Move tab up",
    searchTerms: ["move", "tab", "up", "workspace"],
  },
  "workspace.tab.moveDown": {
    title: "Move tab down",
    searchTerms: ["move", "tab", "down", "workspace"],
  },
};

function threadRefForWorkspaceSurface(
  surface: WorkspaceSurfaceInstance | null | undefined,
): ScopedThreadRef | null {
  if (!surface) {
    return null;
  }

  if (surface.kind === "terminal") {
    return surface.input.threadRef;
  }

  if (surface.input.scope === "server") {
    return surface.input.threadRef;
  }

  return null;
}

export function isWorkspaceCommandId(
  command: string | null | undefined,
): command is WorkspaceCommandId {
  return WORKSPACE_COMMAND_IDS.includes(command as WorkspaceCommandId);
}

export function useWorkspaceCommandExecutor() {
  const document = useWorkspaceDocument();
  const focusedSurface = useFocusedWorkspaceSurface();
  const openWorkspaceTarget = useCommandPaletteStore((state) => state.openWorkspaceTarget);
  const closeFocusedWindow = useWorkspaceStore((state) => state.closeFocusedWindow);
  const equalizeSplits = useWorkspaceStore((state) => state.equalizeSplits);
  const focusWindowByStep = useWorkspaceStore((state) => state.focusWindowByStep);
  const focusAdjacentWindow = useWorkspaceStore((state) => state.focusAdjacentWindow);
  const moveActiveTabToAdjacentWindow = useWorkspaceStore(
    (state) => state.moveActiveTabToAdjacentWindow,
  );
  const moveFocusedWindow = useWorkspaceStore((state) => state.moveFocusedWindow);
  const openTerminalSurfaceForThread = useWorkspaceStore(
    (state) => state.openTerminalSurfaceForThread,
  );
  const resizeFocusedWindow = useWorkspaceStore((state) => state.resizeFocusedWindow);
  const toggleFocusedWindowZoom = useWorkspaceStore((state) => state.toggleFocusedWindowZoom);

  const focusedWindowId = useMemo(() => {
    if (document.focusedWindowId && document.windowsById[document.focusedWindowId]) {
      return document.focusedWindowId;
    }

    return Object.keys(document.windowsById)[0] ?? null;
  }, [document]);

  const focusedThreadRef = useMemo(
    () => threadRefForWorkspaceSurface(focusedSurface),
    [focusedSurface],
  );

  const executeWorkspaceCommand = useCallback(
    async (command: WorkspaceCommandId): Promise<boolean> => {
      switch (command) {
        case "workspace.terminal.splitRight":
          if (!focusedThreadRef) {
            return false;
          }
          openTerminalSurfaceForThread(focusedThreadRef, "split-right");
          return true;
        case "workspace.terminal.splitDown":
          if (!focusedThreadRef) {
            return false;
          }
          openTerminalSurfaceForThread(focusedThreadRef, "split-down");
          return true;
        case "workspace.terminal.newTab":
          if (!focusedThreadRef) {
            return false;
          }
          openTerminalSurfaceForThread(focusedThreadRef, "new-tab");
          return true;
        case "workspace.pane.splitRight":
          if (!focusedWindowId) {
            return false;
          }
          openWorkspaceTarget({ disposition: "split-right" });
          return true;
        case "workspace.pane.splitDown":
          if (!focusedWindowId) {
            return false;
          }
          openWorkspaceTarget({ disposition: "split-down" });
          return true;
        case "workspace.focus.left":
          focusAdjacentWindow("left");
          return true;
        case "workspace.focus.previous":
          focusWindowByStep(-1);
          return true;
        case "workspace.focus.next":
          focusWindowByStep(1);
          return true;
        case "workspace.focus.right":
          focusAdjacentWindow("right");
          return true;
        case "workspace.focus.up":
          focusAdjacentWindow("up");
          return true;
        case "workspace.focus.down":
          focusAdjacentWindow("down");
          return true;
        case "workspace.pane.close":
          closeFocusedWindow();
          return true;
        case "workspace.pane.toggleZoom":
          toggleFocusedWindowZoom();
          return true;
        case "workspace.pane.resizeLeft":
          resizeFocusedWindow("left");
          return true;
        case "workspace.pane.resizeRight":
          resizeFocusedWindow("right");
          return true;
        case "workspace.pane.resizeUp":
          resizeFocusedWindow("up");
          return true;
        case "workspace.pane.resizeDown":
          resizeFocusedWindow("down");
          return true;
        case "workspace.pane.equalize":
          equalizeSplits();
          return true;
        case "workspace.pane.moveLeft":
          moveFocusedWindow("left");
          return true;
        case "workspace.pane.moveRight":
          moveFocusedWindow("right");
          return true;
        case "workspace.pane.moveUp":
          moveFocusedWindow("up");
          return true;
        case "workspace.pane.moveDown":
          moveFocusedWindow("down");
          return true;
        case "workspace.tab.moveLeft":
          moveActiveTabToAdjacentWindow("left");
          return true;
        case "workspace.tab.moveRight":
          moveActiveTabToAdjacentWindow("right");
          return true;
        case "workspace.tab.moveUp":
          moveActiveTabToAdjacentWindow("up");
          return true;
        case "workspace.tab.moveDown":
          moveActiveTabToAdjacentWindow("down");
          return true;
      }
    },
    [
      closeFocusedWindow,
      equalizeSplits,
      focusAdjacentWindow,
      focusWindowByStep,
      focusedThreadRef,
      focusedWindowId,
      moveActiveTabToAdjacentWindow,
      moveFocusedWindow,
      openTerminalSurfaceForThread,
      openWorkspaceTarget,
      resizeFocusedWindow,
      toggleFocusedWindowZoom,
    ],
  );

  return {
    canOpenTerminalSurface: focusedThreadRef !== null,
    canSplitFocusedPane: focusedWindowId !== null,
    executeWorkspaceCommand,
    focusedSurface,
    focusedThreadRef,
    focusedWindowId,
  };
}
