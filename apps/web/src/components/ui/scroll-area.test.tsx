import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { act, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { installReactTestDom } from "~/test/reactTestDom";

vi.mock("@base-ui/react/scroll-area", () => ({
  ScrollArea: {
    Root: forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>((props, ref) => (
      <div ref={ref} data-primitive="root" {...props} />
    )),
    Viewport: forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>((props, ref) => (
      <div ref={ref} data-primitive="viewport" {...props} />
    )),
    Scrollbar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Thumb: () => <div />,
    Corner: () => <div />,
  },
}));

import { ScrollArea } from "./scroll-area";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ScrollArea refs", () => {
  it("keeps the root ref on the root and sends viewportRef to the scrolling viewport", async () => {
    const document = installReactTestDom();
    const container = document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const rootRef = createRef<HTMLDivElement>();
    const viewportRef = createRef<HTMLDivElement>();

    try {
      await act(() =>
        root.render(
          <ScrollArea ref={rootRef} viewportRef={viewportRef} hideScrollbars>
            Content
          </ScrollArea>,
        ),
      );

      expect(rootRef.current?.getAttribute("data-primitive")).toBe("root");
      expect(viewportRef.current?.getAttribute("data-primitive")).toBe("viewport");
      expect(viewportRef.current).not.toBe(rootRef.current);
    } finally {
      await act(() => root.unmount());
    }
  });
});
