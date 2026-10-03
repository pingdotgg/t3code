// @vitest-environment jsdom
import {
  CodeView,
  parseDiffFromFile,
  type PendingCodeViewLayoutReset,
  type VirtualizedFileDiff,
} from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { codeViewTabWidthsCSS } from "./diffRendering";

const renderingManagerUrl = new URL(
  "./managers/UniversalRenderingManager.js",
  import.meta.resolve("@pierre/diffs"),
);
const { clearRenderQueue } = (await import(/* @vite-ignore */ renderingManagerUrl.href)) as {
  clearRenderQueue(): void;
};

// Drive the installed viewer's layout step without native wrapping or a browser render loop.
interface LayoutProbe {
  items: { instance: VirtualizedFileDiff }[];
  pendingLayoutReset: PendingCodeViewLayoutReset | undefined;
  recomputeLayout(index?: number, reset?: PendingCodeViewLayoutReset): void;
}

describe("code-view tab-width layout", () => {
  it("clears offscreen wrapped-row measurements when resolved widths change", () => {
    const css = codeViewTabWidthsCSS(new Map([["file.txt", 4]]));
    const options = { overflow: "wrap", diffStyle: "unified", unsafeCSS: css } as const;
    const viewer = new CodeView(options);
    const layout = viewer as unknown as LayoutProbe;
    try {
      viewer.setItems([
        {
          type: "diff",
          id: "file",
          fileDiff: parseDiffFromFile(
            { name: "file.txt", contents: "" },
            { name: "file.txt", contents: "\tline\n".repeat(100) },
          ),
        },
      ]);
      layout.recomputeLayout();
      const instance = layout.items[0]!.instance;
      const dom = instance as unknown as {
        fileContainer: HTMLElement | undefined;
        codeUnified: HTMLElement | undefined;
      };
      const estimatedHeight = instance.getVirtualizedHeight();
      dom.fileContainer = document.createElement("diffs-container");
      dom.codeUnified = document.createElement("code");
      const content = document.createElement("div");
      const row = document.createElement("div");
      row.dataset.lineIndex = "50,50";
      row.getBoundingClientRect = () => ({ height: 80 }) as DOMRect;
      content.append(row);
      dom.codeUnified.append(document.createElement("div"), content);
      expect(instance.reconcileHeights()).toBe(true);
      expect(instance.getVirtualizedHeight()).toBe(estimatedHeight + 60);
      const measuredPosition = instance.getLinePosition(100)!;
      // That row is now offscreen: only cached geometry remains.
      dom.codeUnified = undefined;
      viewer.setOptions({
        ...options,
        unsafeCSS: codeViewTabWidthsCSS(new Map([["file.txt", 8]])),
      });
      layout.recomputeLayout(0, layout.pendingLayoutReset);
      expect(instance.getVirtualizedHeight()).toBe(estimatedHeight);
      expect(instance.getLinePosition(100)!.top).toBe(measuredPosition.top - 60);
    } finally {
      viewer.cleanUp();
      clearRenderQueue();
    }
  });

  it("invalidates swaps between paths, but keeps CSS stable when only path order changes", () => {
    const before = codeViewTabWidthsCSS(
      new Map([
        ["a.ts", 4],
        ["b.ts", 8],
      ]),
    );
    expect(
      codeViewTabWidthsCSS(
        new Map([
          ["b.ts", 8],
          ["a.ts", 4],
        ]),
      ),
    ).toBe(before);
    expect(
      codeViewTabWidthsCSS(
        new Map([
          ["a.ts", 8],
          ["b.ts", 4],
        ]),
      ),
    ).not.toBe(before);
  });

  it("keeps unusual file names out of CSS syntax", () => {
    const path = 'folder/"quoted]\\file\n.txt';
    const css = codeViewTabWidthsCSS(new Map([[path, 4]]));
    const stylesheet = document.createElement("style");
    stylesheet.textContent = css;
    document.head.append(stylesheet);
    try {
      const rule = stylesheet.sheet!.cssRules[0] as CSSStyleRule;
      expect(rule.style.getPropertyValue("--diffs-tab-size")).toBe("4");
      const container = document.createElement("diffs-container");
      container.setAttribute("data-tab-width-path", encodeURIComponent(path));
      const selector = rule.selectorText.replace(/^:host\((.*)\)$/, "$1");
      expect(container.matches(selector)).toBe(true);
    } finally {
      stylesheet.remove();
    }
  });
});
