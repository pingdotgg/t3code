import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerKeybindingsAtom } from "../state/server";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isEditableFocused } from "../lib/editableFocus";
import {
  createWorkspaceFocusController,
  WORKSPACE_FOCUS_EVENT,
  WORKSPACE_FOCUS_TARGET_EVENT,
  type WorkspaceFocusTarget,
  requestWorkspaceFocus,
} from "../lib/workspaceFocus";
import { useAccessibilitySupport } from "../hooks/useAccessibilitySupport";

export function useWorkspaceArea(name: string, order: number, label: string) {
  const accessible = useAccessibilitySupport();
  return {
    "data-workspace-area": name,
    "data-workspace-order": order,
    "aria-label": label,
    "aria-description": accessible
      ? "Use the next or previous workspace area command to move between areas."
      : undefined,
    role: "region",
    tabIndex: -1,
  } as const;
}

/** Runs once per page entry; section changes and background data retain deliberate focus. */
export function useWorkspacePageFocus(area: string, selector?: string) {
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      requestWorkspaceFocus({ area, ...(selector ? { selector } : {}) }),
    );
    return () => cancelAnimationFrame(frame);
  }, [area, selector]);
}

export function WorkspaceNavigation() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const controller = createWorkspaceFocusController(document);
    let frame = 0;
    let pending: WorkspaceFocusTarget | undefined;
    let cancelOnInput = false;
    const observer = new MutationObserver(() => scheduleFocus());
    const cancelPending = () => {
      pending = undefined;
      cancelOnInput = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
    const applyFocus = () => {
      if (pending && controller.focus(pending.area, pending.restore, pending.selector))
        cancelPending();
    };
    const scheduleFocus = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(applyFocus);
    };
    const onTargetRequest = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      cancelPending();
      pending = event.detail as WorkspaceFocusTarget;
      const request = pending;
      // The originating key/click may still be propagating through the window.
      queueMicrotask(() => {
        if (pending === request) cancelOnInput = true;
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["inert", "aria-hidden", "data-workspace-unavailable"],
      });
      scheduleFocus();
    };
    const onUserInput = () => {
      if (cancelOnInput) cancelPending();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        (event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          editableFocus: isEditableFocused(event.target),
        },
      });
      if (command !== "workspace.focusNext" && command !== "workspace.focusPrevious") return;
      // Consume the chord even inside dialogs, where the controller deliberately does not move.
      event.preventDefault();
      event.stopPropagation();
      cancelPending();
      controller.move(command === "workspace.focusNext" ? 1 : -1);
    };
    const onRequest = (event: Event) => {
      if (event instanceof CustomEvent && (event.detail === 1 || event.detail === -1))
        controller.move(event.detail, undefined, true);
    };
    const stop = window.desktopBridge?.onMenuAction((command) => {
      if (command === "workspace.focusNext" || command === "workspace.focusPrevious") {
        controller.move(command === "workspace.focusNext" ? 1 : -1, "panel");
      }
    });
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(WORKSPACE_FOCUS_EVENT, onRequest);
    window.addEventListener(WORKSPACE_FOCUS_TARGET_EVENT, onTargetRequest);
    window.addEventListener("pointerdown", onUserInput, true);
    window.addEventListener("keydown", onUserInput, true);
    return () => {
      cancelPending();
      controller.dispose();
      stop?.();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(WORKSPACE_FOCUS_EVENT, onRequest);
      window.removeEventListener(WORKSPACE_FOCUS_TARGET_EVENT, onTargetRequest);
      window.removeEventListener("pointerdown", onUserInput, true);
      window.removeEventListener("keydown", onUserInput, true);
    };
  }, [keybindings]);
  return null;
}
