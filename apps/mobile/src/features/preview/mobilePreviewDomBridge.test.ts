import { describe, expect, it } from "vite-plus/test";

import {
  decodeMobilePreviewDomErrorMessage,
  decodeMobilePreviewDomMessage,
  mobilePreviewDomCaptureScript,
} from "./mobilePreviewDomBridge";

function message(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    kind: "t3.preview.capture",
    version: 1,
    requestId: "request-1",
    url: "http://192.168.1.20:5173/checkout",
    title: "Checkout",
    loading: false,
    viewport: {
      width: 1_000,
      height: 800,
      scrollX: 0,
      scrollY: 240,
      devicePixelRatio: 2,
    },
    elements: [
      {
        tag: "BUTTON",
        role: " button ",
        name: "  Pay\n now ",
        selector: "#pay",
        rect: { x: -10, y: 100, width: 150, height: 50 },
      },
      {
        tag: "button",
        role: null,
        name: "Offscreen",
        selector: "#offscreen",
        rect: { x: 1_100, y: 100, width: 100, height: 40 },
      },
    ],
    ...overrides,
  });
}

describe("mobile preview DOM bridge", () => {
  it("decodes, normalizes, and clips the current request", () => {
    expect(decodeMobilePreviewDomMessage(message(), "request-1")).toEqual({
      url: "http://192.168.1.20:5173/checkout",
      title: "Checkout",
      loading: false,
      viewport: {
        width: 1_000,
        height: 800,
        scrollX: 0,
        scrollY: 240,
        devicePixelRatio: 2,
      },
      elements: [
        {
          id: "mobile-element-0",
          tag: "button",
          role: "button",
          name: "Pay now",
          selector: "#pay",
          rect: { x: 0, y: 100, width: 140, height: 50 },
        },
      ],
    });
  });

  it("ignores unrelated page messages and stale capture responses", () => {
    expect(decodeMobilePreviewDomMessage("not json", "request-1")).toBeNull();
    expect(
      decodeMobilePreviewDomMessage(JSON.stringify({ kind: "page-message" }), "request-1"),
    ).toBeNull();
    expect(decodeMobilePreviewDomMessage(message(), "request-2")).toBeNull();
  });

  it("decodes only capture errors for the current request", () => {
    const error = JSON.stringify({
      kind: "t3.preview.capture-error",
      version: 1,
      requestId: "request-1",
      message: "Selector inspection failed",
    });
    expect(decodeMobilePreviewDomErrorMessage(error, "request-1")).toBe(
      "Selector inspection failed",
    );
    expect(decodeMobilePreviewDomErrorMessage(error, "request-2")).toBeNull();
  });

  it("rejects invalid viewport data and drops malformed elements", () => {
    expect(
      decodeMobilePreviewDomMessage(
        message({
          viewport: {
            width: Number.POSITIVE_INFINITY,
            height: 800,
            scrollX: 0,
            scrollY: 0,
            devicePixelRatio: 2,
          },
        }),
        "request-1",
      ),
    ).toBeNull();
    const decoded = decodeMobilePreviewDomMessage(
      message({
        elements: [
          {
            tag: "button",
            role: null,
            name: "Broken",
            selector: "#broken",
            rect: { x: 0, y: 0, width: Number.NaN, height: 40 },
          },
        ],
      }),
      "request-1",
    );
    expect(decoded?.elements).toEqual([]);
  });

  it("caps semantic output before it reaches markup", () => {
    const decoded = decodeMobilePreviewDomMessage(
      message({
        elements: Array.from({ length: 250 }, (_, index) => ({
          tag: "button",
          role: null,
          name: `Button ${index}`,
          selector: `#button-${index}`,
          rect: { x: 0, y: 0, width: 20, height: 20 },
        })),
      }),
      "request-1",
    );
    expect(decoded?.elements).toHaveLength(200);
    expect(decoded?.elements.at(-1)?.id).toBe("mobile-element-199");
  });

  it("quotes the request id and retains bounded collection logic in the injected script", () => {
    const script = mobilePreviewDomCaptureScript('request-"quoted"');
    expect(script).toContain('const requestId = "request-\\"quoted\\"";');
    expect(script).toContain("window.ReactNativeWebView?.postMessage");
    expect(script).toContain('kind: "t3.preview.capture-error"');
    expect(script).toContain(".slice(0, 200)");
    expect(script).toContain("document.querySelectorAll(selector)");
    expect(script).toContain("Number.POSITIVE_INFINITY");
    expect(script).toContain("current = current.parentElement");
    expect(script.trimEnd().endsWith("true;")).toBe(true);
  });
});
