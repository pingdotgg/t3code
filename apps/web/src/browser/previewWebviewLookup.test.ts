import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVE_PREVIEW_WEBVIEW_SELECTOR,
  findActivePreviewWebContentsId,
  findActivePreviewWebview,
} from "./previewWebviewLookup";

interface TestWebview {
  readonly attributes: Readonly<Record<string, string>>;
  getAttribute(name: string): string | null;
  getWebContentsId(): number;
}

const webview = (
  attributes: Readonly<Record<string, string>>,
  webContentsId = 42,
): TestWebview => ({
  attributes,
  getAttribute: (name) => attributes[name] ?? null,
  getWebContentsId: () => webContentsId,
});

describe("findActivePreviewWebview", () => {
  it("selects the live guest when a retired capture guest has the same tab id", () => {
    const retired = webview({
      "data-preview-tab": "tab-1",
      "data-preview-capture-retired": "true",
    });
    const live = webview({ "data-preview-tab": "tab-1" });
    const root = {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe(ACTIVE_PREVIEW_WEBVIEW_SELECTOR);
        return [retired, live];
      },
    };

    expect(
      findActivePreviewWebview<TestWebview & Element>(root as unknown as ParentNode, "tab-1"),
    ).toBe(live);
  });

  it("reads the live guest id and rejects a destroyed guest", () => {
    const live = webview({ "data-preview-tab": "tab-1" }, 43);
    const root = {
      querySelectorAll: () => [live],
    };

    expect(findActivePreviewWebContentsId(root as unknown as ParentNode, "tab-1")).toBe(43);
    live.getWebContentsId = () => {
      throw new Error("guest destroyed");
    };
    expect(findActivePreviewWebContentsId(root as unknown as ParentNode, "tab-1")).toBeNull();
  });
});
