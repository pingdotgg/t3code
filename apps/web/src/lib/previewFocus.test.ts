import { afterEach, describe, expect, it } from "vite-plus/test";

import { isPreviewFocused } from "./previewFocus";

class MockHTMLElement {
  isConnected = true;
  tagName = "WEBVIEW";
  previewTabId = "mini-player-tab";

  closest(): null {
    return null;
  }

  getAttribute(name: string): string | null {
    return name === "data-preview-server-tab" ? this.previewTabId : null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("isPreviewFocused", () => {
  it("only accepts a webview that matches the requested browser tab", () => {
    const webview = new MockHTMLElement();
    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: webview } as unknown as Document;

    expect(isPreviewFocused("right-panel-tab")).toBe(false);
    expect(isPreviewFocused("mini-player-tab")).toBe(true);
  });
});
