// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewFeedbackOverlay } from "./PreviewFeedbackOverlay.tsx";
import type { PreviewFeedbackAnnotation, PreviewFeedbackScope } from "./types.ts";

const scope: PreviewFeedbackScope = {
  scenarioId: "default",
  scenarioName: "Default",
  argOverrides: {},
  argOverridesHash: "hash",
  viewport: { id: "desktop", width: 1280, height: 800 },
};

function makeAnnotation(input?: Partial<PreviewFeedbackAnnotation>): PreviewFeedbackAnnotation {
  return {
    id: "annotation-1",
    previewFileRelativePath: "src/Button.preview.tsx",
    componentRelativePath: "src/Button.tsx",
    runtimeInstanceId: "runtime-1",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
    sentAt: null,
    status: "unsent",
    comment: "Make this primary.",
    scope,
    target: {
      kind: "element",
      element: 'button "Save"',
      elementPath: ".toolbar > button",
      fullPath: "html > body > div > button",
      cssClasses: "primary, button",
      computedStyles: "font-size: 14px",
      computedStyleMap: { fontSize: "14px" },
      accessibility: "role: button",
      nearbyText: "Save",
      nearbyElements: null,
      reactComponents: "<Button>",
      sourceFile: "src/Button.tsx:12",
      boundingBox: { x: 40, y: 50, width: 100, height: 32 },
      marker: { xPercent: 10, yDocument: 66, isFixed: false },
    },
    ...input,
  };
}

describe("PreviewFeedbackOverlay", () => {
  let container: HTMLDivElement;
  let root: Root;
  let targetButton: HTMLButtonElement;
  let elementFromPointMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    document.body.innerHTML = "";
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    elementFromPointMock = vi.fn();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPointMock,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  async function renderOverlay(props?: {
    annotations?: readonly PreviewFeedbackAnnotation[];
    enabled?: boolean;
    showMarkers?: boolean;
    onAnnotationCreate?: (annotation: PreviewFeedbackAnnotation) => void;
  }) {
    await act(async () => {
      root.render(
        <PreviewFeedbackOverlay
          annotations={props?.annotations ?? []}
          componentRelativePath="src/Button.tsx"
          enabled={props?.enabled ?? true}
          previewFileRelativePath="src/Button.preview.tsx"
          runtimeInstanceId="runtime-1"
          scope={scope}
          showMarkers={props?.showMarkers ?? true}
          onAnnotationCreate={props?.onAnnotationCreate ?? vi.fn()}
        >
          <button className="primary_button" data-target-button type="button">
            Save
          </button>
        </PreviewFeedbackOverlay>,
      );
    });

    targetButton = document.querySelector("[data-target-button]") as HTMLButtonElement;
    elementFromPointMock.mockReturnValue(targetButton);
    vi.spyOn(targetButton, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 50, 100, 32));
  }

  it("updates the hover frame on pointer move", async () => {
    await renderOverlay();

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 50, clientY: 60, bubbles: true }),
      );
    });

    expect(document.querySelector("[data-preview-feedback-hover-frame]")).not.toBeNull();
    expect(document.querySelector("[data-preview-feedback-hover-label]")?.textContent).toContain(
      "button",
    );
  });

  it("opens the composer on click and submits an element annotation", async () => {
    const onAnnotationCreate = vi.fn();
    await renderOverlay({ onAnnotationCreate });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("click", { clientX: 50, clientY: 60, bubbles: true, cancelable: true }),
      );
    });

    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();

    await act(async () => {
      if (textarea instanceof HTMLTextAreaElement) {
        textarea.dispatchEvent(new Event("focus", { bubbles: true }));
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(textarea, "Tighten spacing");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    await act(async () => {
      Array.from(document.querySelectorAll("[data-preview-feedback-composer] button"))
        .find((button) => button.textContent === "Add")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAnnotationCreate).toHaveBeenCalledTimes(1);
    expect(onAnnotationCreate.mock.calls[0]?.[0]).toMatchObject({
      comment: "Tighten spacing",
      target: expect.objectContaining({ kind: "element" }),
    });
  });

  it("creates a text annotation from selection", async () => {
    const onAnnotationCreate = vi.fn();
    await renderOverlay({ onAnnotationCreate });

    const selection = {
      rangeCount: 1,
      toString: () => "Save now",
      removeAllRanges: vi.fn(),
      getRangeAt: () => ({
        commonAncestorContainer: targetButton.firstChild,
        getBoundingClientRect: () => new DOMRect(42, 54, 36, 16),
      }),
    } as unknown as Selection;
    vi.spyOn(window, "getSelection").mockReturnValue(selection);

    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });

    expect(document.querySelector("[data-preview-feedback-composer]")?.textContent).toContain(
      "Save now",
    );

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "Update selected text");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      Array.from(document.querySelectorAll("[data-preview-feedback-composer] button"))
        .find((button) => button.textContent === "Add")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAnnotationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        comment: "Update selected text",
        target: expect.objectContaining({
          kind: "text",
          selectedText: "Save now",
        }),
      }),
    );
  });

  it("clears pending feedback on Escape", async () => {
    const selection = {
      removeAllRanges: vi.fn(),
    } as unknown as Selection;
    vi.spyOn(window, "getSelection").mockReturnValue(selection);
    await renderOverlay();

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("click", { clientX: 50, clientY: 60, bubbles: true, cancelable: true }),
      );
    });
    expect(document.querySelector("[data-preview-feedback-composer]")).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(document.querySelector("[data-preview-feedback-composer]")).toBeNull();
    expect(selection.removeAllRanges).toHaveBeenCalled();
  });

  it("ignores feedback UI targets during hit testing", async () => {
    await renderOverlay({ annotations: [makeAnnotation()] });

    const marker = document.querySelector("[data-annotation-marker]");
    expect(marker).not.toBeNull();

    await act(async () => {
      marker?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(document.querySelector("[data-preview-feedback-composer]")).toBeNull();
  });

  it("renders scroll and fixed markers in separate layers with marker tooltip hover", async () => {
    await renderOverlay({
      annotations: [
        makeAnnotation({ id: "scroll-1" }),
        makeAnnotation({
          id: "fixed-1",
          target: {
            ...makeAnnotation().target,
            marker: { xPercent: 22, yDocument: 44, isFixed: true },
          },
        }),
      ],
    });

    expect(
      document.querySelectorAll('[data-preview-feedback-layer="scroll"] [data-annotation-marker]'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-preview-feedback-layer="fixed"] [data-annotation-marker]'),
    ).toHaveLength(1);

    const marker = document.querySelector(
      '[data-preview-feedback-layer="scroll"] [data-annotation-marker]',
    );
    await act(async () => {
      marker?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(document.querySelector("[data-preview-feedback-marker-tooltip]")?.textContent).toContain(
      "Make this primary.",
    );
  });
});
