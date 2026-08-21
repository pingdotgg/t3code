import { describe, expect, it } from "vite-plus/test";

import {
  applyDesignElementState,
  captureDesignElementState,
  createDesignSelectionAnnotation,
  designElementStatesMatch,
  designPathFromUrl,
  discardPendingDesignObject,
  resolveDesignPosition,
  serializeDesignDocument,
} from "./DesignDocument.ts";

function textElement(textContent: string) {
  const attributes = new Map<string, string>();
  return {
    attributes,
    childElementCount: 0,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: (name: string) => attributes.delete(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    style: { cssText: "" },
    textContent,
  };
}

describe("designPathFromUrl", () => {
  it("accepts the marked workspace HTML design URL", () => {
    expect(
      designPathFromUrl(
        "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=.t3%2Fdesigns%2Fthread-1.html",
      ),
    ).toBe(".t3/designs/thread-1.html");
  });

  it.each([
    "http://127.0.0.1:3773/api/assets/token?t3-design-path=.t3%2Fdesigns%2Fthread-1.html",
    "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=..%2Fsecret.html",
    "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=%2Ftmp%2Fdesign.html",
    "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=index.html",
    "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=.t3%2Fdesigns%2Fthread-1.svg",
  ])("rejects a URL that cannot own a workspace design", (url) => {
    expect(designPathFromUrl(url)).toBeNull();
  });
});

describe("resolveDesignPosition", () => {
  it("starts from an existing CSS translation", () => {
    expect(resolveDesignPosition(null, null, "24px -12px", 200, 100)).toEqual({
      x: 24,
      y: -12,
    });
    expect(resolveDesignPosition(null, null, "50% 25%", 200, 100)).toEqual({
      x: 100,
      y: 25,
    });
  });

  it("prefers saved editor coordinates", () => {
    expect(resolveDesignPosition("8", "16", "24px 32px", 200, 100)).toEqual({
      x: 8,
      y: 16,
    });
  });
});

describe("serializeDesignDocument", () => {
  it("does not persist the editor dock state", () => {
    const document = {
      documentElement: {
        cloneNode: () => {
          let editorOpen = true;
          return {
            querySelectorAll: () => [],
            removeAttribute: (name: string) => {
              if (name === "data-t3code-design-open") editorOpen = false;
            },
            get outerHTML() {
              return `<html${editorOpen ? " data-t3code-design-open" : ""}></html>`;
            },
          };
        },
      },
    } as unknown as Document;

    expect(serializeDesignDocument(document)).toBe("<!doctype html>\n<html></html>");
  });
});

describe("discardPendingDesignObject", () => {
  it("removes an unfinished object", () => {
    let removed = false;

    discardPendingDesignObject({
      kind: "create",
      element: { remove: () => (removed = true) },
    });

    expect(removed).toBe(true);
  });
});

describe("design element state", () => {
  it("captures and restores leaf text for undo", () => {
    const element = textElement("Before");
    const before = captureDesignElementState(element as unknown as HTMLElement);
    element.textContent = "After";
    const after = captureDesignElementState(element as unknown as HTMLElement);

    expect(designElementStatesMatch(before, after)).toBe(false);
    applyDesignElementState(element as unknown as HTMLElement, before);
    expect(element.textContent).toBe("Before");
  });
});

describe("createDesignSelectionAnnotation", () => {
  it("builds stable composer context for one design element", () => {
    expect(
      createDesignSelectionAnnotation({
        id: "cta",
        pageUrl: "http://127.0.0.1:3773/api/assets/design",
        pageTitle: "Landing page",
        tagName: "button",
        selector: '[data-t3-design-id="cta"]',
        htmlPreview: '<button data-t3-design-id="cta">Start</button>',
        styles: "background-color: #111111;",
        rect: { x: 20, y: 30, width: 120, height: 40 },
        createdAt: "2026-08-18T00:00:00.000Z",
      }),
    ).toEqual({
      id: "design-cta",
      pageUrl: "http://127.0.0.1:3773/api/assets/design",
      pageTitle: "Landing page",
      comment: "Selected design element",
      elements: [
        {
          id: "cta",
          element: {
            pageUrl: "http://127.0.0.1:3773/api/assets/design",
            pageTitle: "Landing page",
            tagName: "button",
            selector: '[data-t3-design-id="cta"]',
            htmlPreview: '<button data-t3-design-id="cta">Start</button>',
            componentName: null,
            source: null,
            stack: [],
            styles: "background-color: #111111;",
            pickedAt: "2026-08-18T00:00:00.000Z",
          },
          rect: { x: 20, y: 30, width: 120, height: 40 },
        },
      ],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-08-18T00:00:00.000Z",
    });
  });
});
