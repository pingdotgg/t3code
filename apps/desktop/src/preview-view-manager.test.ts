import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fromId = vi.fn(() => null);

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
  },
}));

describe("PreviewViewManager automation status", () => {
  beforeEach(() => {
    fromId.mockClear();
  });

  it("reports an unregistered webview as temporarily unavailable", async () => {
    const { PreviewViewManager } = await import("./preview-view-manager.ts");
    const manager = new PreviewViewManager();

    expect(manager.automationStatus("tab_1")).toEqual({
      available: false,
      visible: true,
      tabId: "tab_1",
      url: null,
      title: null,
      loading: false,
    });

    manager.createTab("tab_1");

    expect(manager.automationStatus("tab_1")).toEqual({
      available: false,
      visible: true,
      tabId: "tab_1",
      url: null,
      title: null,
      loading: false,
    });
    expect(fromId).not.toHaveBeenCalled();
  });
});
