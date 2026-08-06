import { describe, expect, it, beforeEach } from "vitest";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";

import {
  selectThreadBrowserOpen,
  selectThreadRightPanelState,
  setThreadPlanSidebarOpen,
  useRightPanelStore,
} from "./rightPanelStore";

const ref = scopeThreadRef(EnvironmentId.make("environment-test"), ThreadId.make("thread-test"));

describe("rightPanelStore", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {} });
  });

  it("returns a stable empty snapshot", () => {
    const state = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(state, ref)).toBe(selectThreadRightPanelState(state, ref));
  });

  it("orders, activates, reconciles, and bulk closes surfaces", () => {
    const store = useRightPanelStore.getState();
    store.open(ref, "files");
    store.openFile(ref, "src/index.ts", 12);
    store.openBrowser(ref, "preview-a");
    store.openBrowser(ref, "preview-b");

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces,
    ).toMatchObject([
      { id: "files" },
      { id: "file:src/index.ts" },
      { id: "browser:preview-a" },
      { id: "browser:preview-b" },
    ]);

    store.activateSurface(ref, "file:src/index.ts");
    store.closeSurfacesToRight(ref, "file:src/index.ts");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces,
    ).toHaveLength(2);

    store.openBrowser(ref, "preview-a");
    store.openBrowser(ref, "preview-b");
    store.closeOtherSurfaces(ref, "browser:preview-a");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces,
    ).toEqual([{ id: "browser:preview-a", kind: "preview", resourceId: "preview-a" }]);

    store.reconcileBrowserSurfaces(ref, ["preview-b"]);
    const reconciled = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(reconciled.surfaces).toEqual([
      { id: "browser:preview-b", kind: "preview", resourceId: "preview-b" },
    ]);
    store.closeAllSurfaces(ref);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
      false,
    );
  });

  it("preserves a new browser surface until a session exists", () => {
    const store = useRightPanelStore.getState();
    store.open(ref, "preview");
    store.reconcileBrowserSurfaces(ref, []);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({
      activeSurfaceId: "browser:new",
      surfaces: [{ id: "browser:new", kind: "preview", resourceId: null }],
    });

    store.reconcileBrowserSurfaces(ref, ["preview-a"]);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({
      activeSurfaceId: "browser:preview-a",
      surfaces: [{ id: "browser:preview-a", kind: "preview", resourceId: "preview-a" }],
    });
  });

  it("reports browser-open only while a preview surface is visible", () => {
    const store = useRightPanelStore.getState();
    expect(selectThreadBrowserOpen(useRightPanelStore.getState().byThreadKey, ref)).toBe(false);

    store.openBrowser(ref, "preview-a");
    expect(selectThreadBrowserOpen(useRightPanelStore.getState().byThreadKey, ref)).toBe(true);

    store.close(ref);
    expect(selectThreadBrowserOpen(useRightPanelStore.getState().byThreadKey, ref)).toBe(false);
  });

  it("closes plan without collapsing an open browser panel", () => {
    const store = useRightPanelStore.getState();
    store.openBrowser(ref, "preview-a");
    store.open(ref, "plan");

    setThreadPlanSidebarOpen(ref, false);

    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(panel.isOpen).toBe(true);
    expect(panel.surfaces).toEqual([
      { id: "browser:preview-a", kind: "preview", resourceId: "preview-a" },
    ]);
    expect(panel.activeSurfaceId).toBe("browser:preview-a");
    expect(selectThreadBrowserOpen(useRightPanelStore.getState().byThreadKey, ref)).toBe(true);
  });

  it("switches and closes independently identified terminal surfaces", () => {
    const store = useRightPanelStore.getState();
    store.openTerminal(ref, "terminal-a");
    store.openTerminal(ref, "terminal-b");

    store.activateSurface(ref, "terminal:terminal-a");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({
      activeSurfaceId: "terminal:terminal-a",
      surfaces: [
        { id: "terminal:terminal-a", kind: "terminal", resourceId: "terminal-a" },
        { id: "terminal:terminal-b", kind: "terminal", resourceId: "terminal-b" },
      ],
    });

    store.closeSurface(ref, "terminal:terminal-a");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({
      activeSurfaceId: "terminal:terminal-b",
      surfaces: [{ id: "terminal:terminal-b", kind: "terminal", resourceId: "terminal-b" }],
    });

    store.closeSurface(ref, "terminal:terminal-b");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
      false,
    );
  });
});
