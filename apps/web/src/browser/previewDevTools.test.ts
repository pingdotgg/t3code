import { beforeEach, describe, expect, it } from "vite-plus/test";

import { splitDockedDevToolsRect, usePreviewDevToolsStore } from "./previewDevTools";

describe("previewDevTools", () => {
  beforeEach(() => {
    usePreviewDevToolsStore.setState({ byTabId: {} });
  });

  it("gives docked DevTools the right or bottom share of the panel", () => {
    const panel = { x: 100, y: 50, width: 800, height: 600 };

    expect(splitDockedDevToolsRect(panel, "right", 0.25)).toEqual({
      page: { x: 100, y: 50, width: 600, height: 600 },
      devTools: { x: 700, y: 50, width: 200, height: 600 },
    });
    expect(splitDockedDevToolsRect(panel, "bottom", 0.5)).toEqual({
      page: { x: 100, y: 50, width: 800, height: 300 },
      devTools: { x: 100, y: 350, width: 800, height: 300 },
    });
  });

  it("keeps a dock until DevTools that opened close again", () => {
    const store = usePreviewDevToolsStore.getState();
    store.request("tab", "right");

    // The desktop still reports DevTools closed until they finish opening.
    store.syncOpen("tab", false);
    expect(usePreviewDevToolsStore.getState().byTabId["tab"]?.opened).toBe(false);

    store.syncOpen("tab", true);
    expect(usePreviewDevToolsStore.getState().byTabId["tab"]?.opened).toBe(true);

    store.syncOpen("tab", false);
    expect(usePreviewDevToolsStore.getState().byTabId["tab"]).toBeUndefined();
  });

  it("clamps the dock size and keeps it when the side changes", () => {
    const store = usePreviewDevToolsStore.getState();
    store.request("tab", "right");
    store.resize("tab", 0.95);
    expect(usePreviewDevToolsStore.getState().byTabId["tab"]?.fraction).toBe(0.8);

    store.resize("tab", 0.3);
    store.request("tab", "bottom");
    expect(usePreviewDevToolsStore.getState().byTabId["tab"]).toEqual({
      side: "bottom",
      fraction: 0.3,
      opened: false,
    });
  });
});
