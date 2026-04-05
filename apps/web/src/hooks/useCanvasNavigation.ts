/**
 * useCanvasNavigation — Keyboard + mouse/trackpad handler for canvas mode.
 *
 * Intercepts key events and dispatches to canvas store actions.
 * Only active when canvas mode is enabled.
 */
import { useCallback, useEffect } from "react";
import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useCanvasStore } from "../canvasStore";
import {
  resolveShortcutCommand,
  isCanvasCommand,
  canvasJumpProjectIndexFromCommand,
} from "../keybindings";

export interface UseCanvasNavigationOptions {
  keybindings: ResolvedKeybindingsConfig;
  platform?: string;
}

function handleOverviewKeyDown(event: KeyboardEvent): void {
  const key = event.key.toLowerCase();
  const store = useCanvasStore.getState();

  let handled = true;
  switch (key) {
    case "h":
    case "arrowleft":
      store.navigateLeft();
      break;
    case "l":
    case "arrowright":
      store.navigateRight();
      break;
    case "k":
    case "arrowup":
      store.navigateUp();
      break;
    case "j":
    case "arrowdown":
      store.navigateDown();
      break;
    case "enter":
      store.toggleOverview(); // Exit overview, navigate to cursor position
      break;
    case "escape":
      store.toggleOverview(); // Exit overview without changing focus
      break;
    default:
      handled = false;
  }

  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}

export function useCanvasNavigation({ keybindings, platform }: UseCanvasNavigationOptions): void {
  const enabled = useCanvasStore((s) => s.enabled);
  const mode = useCanvasStore((s) => s.mode);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      // In launcher mode, let the launcher handle its own keyboard events
      if (mode === "launcher") return;

      // In overview mode, handle HJKL/arrows for cursor movement
      if (mode === "overview") {
        handleOverviewKeyDown(event);
        return;
      }

      // Navigate mode — resolve command from keybindings
      const options = platform ? { platform } : undefined;
      const command = resolveShortcutCommand(event, keybindings, options);
      if (!command || !isCanvasCommand(command)) return;

      event.preventDefault();
      event.stopPropagation();

      const store = useCanvasStore.getState();

      switch (command) {
        case "canvas.focusLeft":
          store.navigateLeft();
          break;
        case "canvas.focusRight":
          store.navigateRight();
          break;
        case "canvas.focusUp":
          store.navigateUp();
          break;
        case "canvas.focusDown":
          store.navigateDown();
          break;
        case "canvas.toggleOverview":
          store.toggleOverview();
          break;
        case "canvas.openLauncher":
          store.openLauncher();
          break;
        case "canvas.cycleWidth":
          store.cycleColumnWidth();
          break;
        case "canvas.togglePrevious":
          store.togglePreviousProject();
          break;
        default: {
          // Check if it's a jump-to-project command
          const jumpIndex = canvasJumpProjectIndexFromCommand(command);
          if (jumpIndex !== null) {
            store.jumpToProject(jumpIndex);
          }
          break;
        }
      }
    },
    [enabled, mode, keybindings, platform],
  );

  // Wheel handler for Mod+Scroll navigation
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!enabled || mode !== "navigate") return;

      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod) return;

      event.preventDefault();
      const store = useCanvasStore.getState();

      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        // Vertical scroll → navigate projects
        if (event.deltaY < 0) store.navigateUp();
        else store.navigateDown();
      } else {
        // Horizontal scroll → navigate threads
        if (event.deltaX < 0) store.navigateLeft();
        else store.navigateRight();
      }
    },
    [enabled, mode],
  );

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("wheel", handleWheel);
    };
  }, [enabled, handleKeyDown, handleWheel]);
}
