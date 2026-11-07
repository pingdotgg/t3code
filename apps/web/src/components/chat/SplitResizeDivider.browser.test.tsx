import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { SplitResizeDivider } from "./SplitResizeDivider";

function Fixture({
  orientation,
  onResize,
}: {
  orientation: "vertical" | "horizontal";
  onResize: (ratio: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} style={{ position: "relative", width: 1000, height: 600 }}>
      <SplitResizeDivider
        containerRef={containerRef}
        property="--test-split"
        orientation={orientation}
        ratio={0.5}
        onResize={onResize}
        style={{ left: 500, top: 300 }}
      />
    </div>
  );
}

it.each(["vertical", "horizontal"] as const)(
  "commits a %s drag only on release and cleans up on window blur",
  async (orientation) => {
    const onResize = vi.fn();
    await using screen = await render(<Fixture orientation={orientation} onResize={onResize} />);
    const handle = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const host = handle.parentElement!;
    // Synthetic events do not own a native pointer capture.
    using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
    const pointer = { bubbles: true, pointerId: 1, button: 0 };
    await act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { ...pointer, clientX: 500, clientY: 300 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointermove", { ...pointer, clientX: 600, clientY: 360 }),
      );
    });
    expect(onResize).not.toHaveBeenCalled();
    expect(host.hasAttribute("data-split-resizing")).toBe(true);
    await act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerup", { ...pointer, clientX: 600, clientY: 360 }),
      );
    });
    expect(onResize).toHaveBeenCalledExactlyOnceWith(0.6);
    expect(host.style.getPropertyValue("--test-split")).toBe("60%");
    expect(host.hasAttribute("data-split-resizing")).toBe(false);

    onResize.mockClear();
    await act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { ...pointer, clientX: 500, clientY: 300 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointermove", { ...pointer, clientX: 550, clientY: 330 }),
      );
      window.dispatchEvent(new Event("blur"));
    });
    expect(onResize).toHaveBeenCalledExactlyOnceWith(0.55);
    expect(document.body.style.cursor).toBe("");
  },
);

it("supports keyboard resizing and resets only its own separator", async () => {
  const onResize = vi.fn();
  await using screen = await render(<Fixture orientation="horizontal" onResize={onResize} />);
  const handle = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
  await act(() =>
    handle.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })),
  );
  expect(onResize).toHaveBeenLastCalledWith(0.52);
  await act(() => handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onResize).toHaveBeenLastCalledWith(0.5);
});
