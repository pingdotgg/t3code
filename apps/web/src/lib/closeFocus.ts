export type CloseFocusOwner = "drawer-terminal" | "right-panel";

export interface CloseFocusContext {
  readonly rightPanelOpen: boolean;
  readonly rightPanelPreviewTabIds: readonly string[];
  readonly rightPanelScopeKey: string | null;
}

export interface CloseFocusTracker {
  recordFocus(target: EventTarget | null, context: CloseFocusContext): void;
  recordPointer(target: EventTarget | null, context: CloseFocusContext): void;
  recordFocusOut(
    relatedTarget: EventTarget | null,
    documentHasFocus: boolean,
    context: CloseFocusContext,
  ): void;
  current(context: CloseFocusContext): CloseFocusOwner | null;
  clear(owner?: CloseFocusOwner): void;
}

const RIGHT_PANEL_SELECTOR = "[data-preview-panel-mode], [data-right-panel-control]";
const RIGHT_PANEL_DRAG_INTERACTIVE_SELECTOR = "button, input, textarea, select, a";

function previewTabIdForElement(element: Element): string | null {
  if (element.tagName.toLowerCase() === "webview") {
    return element.getAttribute("data-preview-tab");
  }
  return (
    element
      .closest<HTMLElement>("[data-preview-viewport]")
      ?.getAttribute("data-preview-viewport") ?? null
  );
}

function ownerForElement(element: Element, context: CloseFocusContext): CloseFocusOwner | null {
  if (!element.isConnected) return null;

  if (
    element.closest("[data-right-panel-drag-region]") &&
    !element.closest(RIGHT_PANEL_DRAG_INTERACTIVE_SELECTOR)
  ) {
    return null;
  }

  const terminalOwner =
    element.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  if (terminalOwner === "drawer") return "drawer-terminal";
  if (terminalOwner === "right-panel") {
    return context.rightPanelOpen ? "right-panel" : null;
  }

  if (!context.rightPanelOpen) return null;
  const focusedPreviewTabId = previewTabIdForElement(element);
  if (focusedPreviewTabId !== null) {
    return context.rightPanelPreviewTabIds.includes(focusedPreviewTabId) ? "right-panel" : null;
  }

  return element.closest(RIGHT_PANEL_SELECTOR) ? "right-panel" : null;
}

export function createCloseFocusTracker(): CloseFocusTracker {
  let retainedOwner: CloseFocusOwner | null = null;
  let retainedElement: Element | null = null;
  let retainedPanelScopeKey: string | null = null;
  // undefined defers to live/retained focus; null records an explicit pointer hit outside.
  let explicitPointerOwner: CloseFocusOwner | null | undefined;
  let explicitPointerPanelScopeKey: string | null = null;
  let activeElementAtPointer: Element | null = null;

  const ownerForTarget = (
    target: EventTarget | null,
    context: CloseFocusContext,
  ): CloseFocusOwner | null =>
    target instanceof Element ? ownerForElement(target, context) : null;

  const clearRetained = () => {
    retainedOwner = null;
    retainedElement = null;
    retainedPanelScopeKey = null;
  };

  const resetExplicitPointer = () => {
    explicitPointerOwner = undefined;
    explicitPointerPanelScopeKey = null;
    activeElementAtPointer = null;
  };

  const clearExplicitPointer = () => {
    explicitPointerOwner = null;
    explicitPointerPanelScopeKey = null;
    activeElementAtPointer = null;
  };

  const retainTarget = (target: EventTarget | null, context: CloseFocusContext) => {
    const owner = ownerForTarget(target, context);
    retainedOwner = owner;
    retainedElement = owner !== null && target instanceof Element ? target : null;
    retainedPanelScopeKey = owner === "right-panel" ? context.rightPanelScopeKey : null;
    return owner;
  };

  const retainedRightPanelIsCurrent = (context: CloseFocusContext) =>
    retainedOwner === "right-panel" &&
    context.rightPanelOpen &&
    retainedPanelScopeKey === context.rightPanelScopeKey;

  const isRetainedPreview = (element: Element, context: CloseFocusContext) =>
    retainedRightPanelIsCurrent(context) &&
    retainedElement === element &&
    previewTabIdForElement(element) !== null;

  return {
    recordFocus: (target, context) => {
      resetExplicitPointer();
      retainTarget(target, context);
    },
    recordPointer: (target, context) => {
      const activeElement = document.activeElement;
      activeElementAtPointer =
        activeElement instanceof Element && activeElement.isConnected ? activeElement : null;
      explicitPointerOwner = retainTarget(target, context);
      explicitPointerPanelScopeKey =
        explicitPointerOwner === "right-panel" ? context.rightPanelScopeKey : null;
    },
    recordFocusOut: (relatedTarget, documentHasFocus, context) => {
      if (relatedTarget instanceof Element) {
        resetExplicitPointer();
        retainTarget(relatedTarget, context);
        return;
      }
      if (
        documentHasFocus &&
        !(
          retainedElement !== null &&
          retainedRightPanelIsCurrent(context) &&
          previewTabIdForElement(retainedElement) !== null
        )
      ) {
        clearRetained();
      }
    },
    current: (context) => {
      const activeElement = document.activeElement;
      const connectedActiveElement =
        activeElement instanceof Element && activeElement.isConnected ? activeElement : null;
      const activeElementIsDocumentRoot =
        connectedActiveElement === document.body ||
        connectedActiveElement === document.documentElement;
      const activeTerminalOwner =
        connectedActiveElement?.closest<HTMLElement>("[data-terminal-owner]")?.dataset
          .terminalOwner ?? null;

      if (
        explicitPointerOwner !== undefined &&
        activeElementAtPointer !== null &&
        connectedActiveElement !== null &&
        ((connectedActiveElement !== activeElementAtPointer && !activeElementIsDocumentRoot) ||
          activeTerminalOwner === "drawer" ||
          activeTerminalOwner === "right-panel")
      ) {
        resetExplicitPointer();
      }

      if (explicitPointerOwner !== undefined) {
        if (
          explicitPointerOwner === "right-panel" &&
          (!context.rightPanelOpen || explicitPointerPanelScopeKey !== context.rightPanelScopeKey)
        ) {
          clearExplicitPointer();
          clearRetained();
        }
        return explicitPointerOwner;
      }

      if (connectedActiveElement !== null) {
        const liveOwner = ownerForElement(connectedActiveElement, context);
        if (liveOwner !== null) {
          retainedOwner = liveOwner;
          retainedElement = connectedActiveElement;
          retainedPanelScopeKey = liveOwner === "right-panel" ? context.rightPanelScopeKey : null;
          return liveOwner;
        }
        if (!activeElementIsDocumentRoot) {
          if (isRetainedPreview(connectedActiveElement, context)) return "right-panel";
          clearRetained();
          return null;
        }
      }

      if (retainedOwner === "right-panel" && !retainedRightPanelIsCurrent(context)) clearRetained();
      return retainedOwner;
    },
    clear: (owner) => {
      if (owner === undefined) {
        clearRetained();
        clearExplicitPointer();
        return;
      }
      const ownerWasRetained = retainedOwner === owner;
      if (ownerWasRetained) clearRetained();
      if (ownerWasRetained || explicitPointerOwner === owner) {
        clearExplicitPointer();
      }
    },
  };
}
