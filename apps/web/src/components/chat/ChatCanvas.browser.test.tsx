import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ChatCanvas } from "./ChatCanvas";
import { useChatCanvas } from "./ChatCanvasContext";

const resize = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock("../../lib/observeResize", () => ({
  observeResize: (_elements: unknown, callback: () => void) => {
    resize.callbacks.add(callback);
    return () => resize.callbacks.delete(callback);
  },
}));

let fontSize = 16;
let canvas: ReturnType<typeof useChatCanvas>;

function Preview({ x }: { x: number }) {
  const current = useChatCanvas();
  useLayoutEffect(() => {
    canvas = current;
  }, [current]);
  const reportPreview = current?.reportPreview;
  useLayoutEffect(() => {
    reportPreview?.({
      key: "browser:one",
      width: 240,
      source: { width: 240, height: 365 },
      position: { x, y: 12 },
      lastInteraction: "drag",
    });
  }, [reportPreview, x]);
  return null;
}

function mockLayout() {
  const stack = new DisposableStack();
  fontSize = 16;
  stack.use(vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1800));
  stack.use(vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1000));
  stack.use(
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.hasAttribute("data-thread-find-bar")) {
        const gap = 0.75 * fontSize;
        return new DOMRect(
          200 + 1800 - gap - 17.5 * fontSize,
          100 + gap,
          17.5 * fontSize,
          2.25 * fontSize,
        );
      }
      return new DOMRect(200, 100, 1800, 1000);
    }),
  );
  stack.use(
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      paddingLeft: "48px",
      width: "736px",
      minWidth: "640px",
    } as CSSStyleDeclaration),
  );
  stack.defer(() => resize.callbacks.clear());
  return stack;
}

function find(open: boolean, previewX = 1548) {
  return (
    <ChatCanvas composerOverlayElement={null} detailsCardTopInset={open ? 48 : 0}>
      {open ? <div data-thread-find-bar /> : null}
      <Preview x={previewX} />
    </ChatCanvas>
  );
}

it.each([16, 24])(
  "keeps a preview below Find and releases its space on close at a %spx root font",
  async (size) => {
    using _layout = mockLayout();
    fontSize = size;
    await using screen = await render(find(false));
    expect(canvas?.layout.frame?.y).toBe(12);

    await screen.rerender(find(true));
    expect(canvas?.detailsCardTopInset).toBe(3 * size);
    expect(canvas?.layout.frame?.y).toBe(3 * size + 12);

    await screen.rerender(find(false));
    expect(canvas?.detailsCardTopInset).toBe(0);
    expect(canvas?.layout.frame?.y).toBe(12);

    await screen.rerender(find(true));
    expect(canvas?.layout.frame?.y).toBe(3 * size + 12);
  },
);

it("remeasures the open bar when its font size changes without resizing the canvas", async () => {
  using _layout = mockLayout();
  await using _screen = await render(find(true, 1200));
  expect(canvas?.layout.frame?.y).toBe(12);

  fontSize = 24;
  await act(() => {
    for (const callback of resize.callbacks) callback();
  });
  expect(canvas?.detailsCardTopInset).toBe(72);
  expect(canvas?.layout.frame?.y).toBe(84);
});
