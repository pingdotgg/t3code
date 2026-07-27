import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runPreservingDocumentFocus } from "./documentFocus";

class MockHTMLElement {
  isConnected = true;
  readonly focus = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const setActiveElement = (activeElement: unknown): void => {
  vi.stubGlobal("HTMLElement", MockHTMLElement);
  vi.stubGlobal("document", { activeElement });
};

describe("document focus", () => {
  it("restores the active element without scrolling after success", async () => {
    const element = new MockHTMLElement();
    setActiveElement(element);

    await expect(runPreservingDocumentFocus(async () => "result")).resolves.toBe("result");
    expect(element.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("restores the active element after failure", async () => {
    const element = new MockHTMLElement();
    const cause = new Error("automation failed");
    setActiveElement(element);

    await expect(
      runPreservingDocumentFocus(async () => {
        throw cause;
      }),
    ).rejects.toBe(cause);
    expect(element.focus).toHaveBeenCalledOnce();
  });

  it("does not restore a focused element that was detached during the operation", async () => {
    const element = new MockHTMLElement();
    setActiveElement(element);

    await runPreservingDocumentFocus(async () => {
      element.isConnected = false;
    });

    expect(element.focus).not.toHaveBeenCalled();
  });
});
