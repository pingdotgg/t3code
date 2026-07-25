import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  type CloseFocusContext,
  createCloseFocusTracker,
  sharedCloseFocusTracker,
} from "./closeFocus";

class MockElement extends EventTarget {
  isConnected = true;
  owner: "drawer" | "right-panel" | null = null;
  inRightPanel = false;
  inRightPanelDragRegion = false;
  inRightPanelTab = false;
  interactive = false;
  inPortaledInteractive = false;
  inPreviewViewport = false;
  previewTabId: string | null = null;
  tagName = "div";

  closest(selector: string): MockElement | null {
    if (!this.isConnected) return null;
    if (selector === "[data-terminal-owner]" && this.owner !== null) return this;
    if (selector === "[data-right-panel-drag-region]" && this.inRightPanelDragRegion) return this;
    if (selector.includes("[data-right-panel-tab]") && this.inRightPanelTab) return this;
    if (selector.startsWith("button") && this.interactive) return this;
    if (selector.includes('[data-slot="menu-popup"]') && this.inPortaledInteractive) return this;
    if (selector === "[data-preview-viewport]" && this.inPreviewViewport) return this;
    if (selector.includes("[data-preview-panel-mode]") && this.inRightPanel) return this;
    return null;
  }

  get dataset(): DOMStringMap {
    return { terminalOwner: this.owner ?? undefined } as DOMStringMap;
  }

  getAttribute(name: string): string | null {
    if (name === "data-preview-tab" || name === "data-preview-viewport") {
      return this.previewTabId;
    }
    return null;
  }
}

const originalDocument = globalThis.document;
const originalElement = globalThis.Element;

afterEach(() => {
  sharedCloseFocusTracker.clear();
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalElement === undefined) {
    delete (globalThis as { Element?: typeof Element }).Element;
  } else {
    globalThis.Element = originalElement;
  }
});

function installDom(
  activeElement: MockElement,
  body = new MockElement(),
  documentElement = body,
): void {
  globalThis.Element = MockElement as unknown as typeof Element;
  globalThis.document = { activeElement, body, documentElement } as unknown as Document;
}

function closeFocusContext(overrides: Partial<CloseFocusContext> = {}): CloseFocusContext {
  return {
    rightPanelOpen: true,
    rightPanelPreviewTabIds: [],
    rightPanelScopeKey: "thread-a",
    ...overrides,
  };
}

describe("close focus", () => {
  it("shares sheet-panel focus with global shortcut resolution", () => {
    const sheetPanel = new MockElement();
    sheetPanel.inRightPanel = true;
    installDom(sheetPanel);

    sharedCloseFocusTracker.recordFocus(sheetPanel, closeFocusContext());

    expect(sharedCloseFocusTracker.current(closeFocusContext())).toBe("right-panel");
  });

  it("does not let a hidden-panel control claim close ownership", () => {
    const panelControl = new MockElement();
    panelControl.inRightPanel = true;
    installDom(panelControl);

    const tracker = createCloseFocusTracker();

    expect(tracker.current(closeFocusContext({ rightPanelOpen: false }))).toBeNull();
    tracker.recordPointer(panelControl, closeFocusContext());
    expect(tracker.current(closeFocusContext({ rightPanelOpen: false }))).toBeNull();
  });

  it("distinguishes the drawer terminal from right-panel focus", () => {
    const tracker = createCloseFocusTracker();
    const context = closeFocusContext();

    const drawerTerminal = new MockElement();
    drawerTerminal.owner = "drawer";
    installDom(drawerTerminal);
    expect(tracker.current(context)).toBe("drawer-terminal");

    const panelTerminal = new MockElement();
    panelTerminal.owner = "right-panel";
    installDom(panelTerminal);
    expect(tracker.current(context)).toBe("right-panel");
  });

  it("owns only previews hosted by the current right panel", () => {
    const preview = new MockElement();
    preview.tagName = "webview";
    preview.previewTabId = "preview-a";
    installDom(preview);

    const tracker = createCloseFocusTracker();

    expect(tracker.current(closeFocusContext({ rightPanelPreviewTabIds: ["preview-a"] }))).toBe(
      "right-panel",
    );
    const inactiveTracker = createCloseFocusTracker();
    expect(
      inactiveTracker.current(closeFocusContext({ rightPanelPreviewTabIds: ["preview-b"] })),
    ).toBeNull();

    const viewport = new MockElement();
    viewport.inPreviewViewport = true;
    viewport.previewTabId = "preview-b";
    installDom(viewport);
    expect(
      inactiveTracker.current(closeFocusContext({ rightPanelPreviewTabIds: ["preview-b"] })),
    ).toBe("right-panel");
  });

  it("retains panel ownership when closing a preview activates the next tab", () => {
    const preview = new MockElement();
    preview.tagName = "webview";
    preview.previewTabId = "preview-a";
    const body = new MockElement();
    installDom(preview, body);

    const tracker = createCloseFocusTracker();
    tracker.recordFocus(preview, closeFocusContext({ rightPanelPreviewTabIds: ["preview-a"] }));
    installDom(body, body);

    expect(tracker.current(closeFocusContext({ rightPanelPreviewTabIds: ["preview-b"] }))).toBe(
      "right-panel",
    );
  });

  it("owns a connected preview after a surface switch without relying on a focus event", () => {
    const preview = new MockElement();
    preview.tagName = "webview";
    preview.previewTabId = "preview-a";
    const body = new MockElement();
    installDom(preview, body);

    const tracker = createCloseFocusTracker();
    const switchedContext = closeFocusContext({ rightPanelPreviewTabIds: ["preview-a"] });

    expect(tracker.current(switchedContext)).toBe("right-panel");
    tracker.recordFocusOut(null, true, switchedContext);
    installDom(body, body);
    expect(tracker.current(switchedContext)).toBe("right-panel");
    expect(
      tracker.current(
        closeFocusContext({ rightPanelPreviewTabIds: [], rightPanelScopeKey: "thread-b" }),
      ),
    ).toBeNull();
  });

  it("retains native blur, clears title-bar pointerdown, and restores panel clicks", () => {
    const panel = new MockElement();
    panel.inRightPanel = true;
    const body = new MockElement();
    installDom(panel, body);
    const context = closeFocusContext();
    const tracker = createCloseFocusTracker();

    tracker.recordFocus(panel, context);
    tracker.recordFocusOut(null, false, context);
    expect(tracker.current(context)).toBe("right-panel");

    installDom(body, body);
    tracker.recordFocusOut(null, true, context);
    expect(tracker.current(context)).toBeNull();
    installDom(panel, body);
    tracker.recordFocus(panel, context);

    tracker.recordPointer(body, context);
    expect(tracker.current(context)).toBeNull();

    tracker.recordPointer(panel, context);
    tracker.recordFocusOut(null, true, context);
    expect(tracker.current(context)).toBe("right-panel");
  });

  it("prefers live terminal focus over an outside pointer target", () => {
    const terminal = new MockElement();
    terminal.owner = "drawer";
    const outside = new MockElement();
    installDom(terminal);

    const tracker = createCloseFocusTracker();
    const context = closeFocusContext();
    tracker.recordFocus(terminal, context);
    tracker.recordPointer(outside, context);

    expect(tracker.current(context)).toBe("drawer-terminal");
  });

  it("does not restore terminal focus after that owner is explicitly cleared", () => {
    const terminal = new MockElement();
    terminal.owner = "drawer";
    installDom(terminal);

    const tracker = createCloseFocusTracker();
    const context = closeFocusContext();
    tracker.recordFocus(terminal, context);
    tracker.clear("drawer-terminal");

    expect(tracker.current(context)).toBeNull();
  });

  it("prefers meaningful focus that changes after pointerdown", () => {
    const panel = new MockElement();
    panel.inRightPanel = true;
    const globalControl = new MockElement();
    const body = new MockElement();
    installDom(body, body);

    const tracker = createCloseFocusTracker();
    const context = closeFocusContext();
    tracker.recordPointer(panel, context);
    installDom(globalControl, body);

    expect(tracker.current(context)).toBeNull();
  });

  it("retains ownership when native UI leaves focus on the document root", () => {
    const panel = new MockElement();
    panel.inRightPanel = true;
    const body = new MockElement();
    const documentElement = new MockElement();
    const context = closeFocusContext();
    const tracker = createCloseFocusTracker();
    installDom(panel, body, documentElement);

    tracker.recordFocus(panel, context);
    tracker.recordFocusOut(null, false, context);
    installDom(documentElement, body, documentElement);

    expect(tracker.current(context)).toBe("right-panel");

    tracker.recordPointer(documentElement, context);
    expect(tracker.current(context)).toBeNull();
  });

  it("excludes draggable panel chrome without excluding its controls", () => {
    const context = closeFocusContext();
    const tracker = createCloseFocusTracker();
    const dragRegion = new MockElement();
    dragRegion.inRightPanel = true;
    dragRegion.inRightPanelDragRegion = true;
    installDom(dragRegion);

    tracker.recordPointer(dragRegion, context);
    expect(tracker.current(context)).toBeNull();

    const panelControl = new MockElement();
    panelControl.inRightPanel = true;
    panelControl.inRightPanelDragRegion = true;
    panelControl.interactive = true;
    tracker.recordPointer(panelControl, context);
    expect(tracker.current(context)).toBe("right-panel");
  });

  it("keeps right-panel ownership when pointerdown lands on tab row chrome", () => {
    const context = closeFocusContext();
    const tracker = createCloseFocusTracker();
    const tabRow = new MockElement();
    tabRow.inRightPanel = true;
    tabRow.inRightPanelDragRegion = true;
    tabRow.inRightPanelTab = true;
    installDom(tabRow);

    tracker.recordPointer(tabRow, context);

    expect(tracker.current(context)).toBe("right-panel");
  });

  it("recognizes a tagged right-panel portal", () => {
    const context = closeFocusContext();
    const panelTrigger = new MockElement();
    panelTrigger.inRightPanel = true;
    const portalItem = new MockElement();
    portalItem.inPortaledInteractive = true;
    portalItem.inRightPanel = true;
    installDom(panelTrigger);

    const tracker = createCloseFocusTracker();
    tracker.recordFocus(panelTrigger, context);
    tracker.recordFocusOut(portalItem, true, context);
    tracker.recordFocus(portalItem, context);
    installDom(portalItem);

    expect(tracker.current(context)).toBe("right-panel");

    tracker.clear();
    tracker.recordFocus(portalItem, context);
    expect(tracker.current(context)).toBe("right-panel");

    tracker.recordFocus(panelTrigger, context);
    tracker.recordFocus(portalItem, { ...context, rightPanelOpen: false });
    expect(tracker.current({ ...context, rightPanelOpen: false })).toBeNull();
  });

  it("does not give an untagged global portal the panel's retained ownership", () => {
    const context = closeFocusContext();
    const panel = new MockElement();
    panel.inRightPanel = true;
    const globalPortalItem = new MockElement();
    globalPortalItem.inPortaledInteractive = true;
    installDom(panel);

    const tracker = createCloseFocusTracker();
    tracker.recordFocus(panel, context);
    tracker.recordFocusOut(globalPortalItem, true, context);
    tracker.recordFocus(globalPortalItem, context);
    installDom(globalPortalItem);

    expect(tracker.current(context)).toBeNull();
  });
});
