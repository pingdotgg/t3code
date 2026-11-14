import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { ProjectRail } from "./ProjectRail";

function touch(target: Element, type: string, x: number, y: number): TouchEvent {
  const point = new Touch({ identifier: 1, target, clientX: x, clientY: y });
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" || type === "touchcancel" ? [] : [point],
    changedTouches: [point],
  });
  target.dispatchEvent(event);
  return event;
}

async function lift(target: Element, x: number, y: number) {
  await act(() => {
    touch(target, "touchstart", x, y);
    vi.advanceTimersByTime(400);
  });
}

// The system can take a touch away mid-gesture, and then no touchend follows.
async function cancelTouch(target: Element, x: number, y: number) {
  await act(() => touch(target, "touchcancel", x, y));
}

function renderRail(onTileMenu = vi.fn(), onSelect = vi.fn()) {
  return render(
    <ProjectRail
      tiles={[{ kind: "folder", key: "tag:ops", tag: "ops" }]}
      threads={[]}
      selectedKeys={[]}
      onSelectAll={vi.fn()}
      onSelect={onSelect}
      onMove={vi.fn()}
      folderIcons={{}}
      onTileMenu={onTileMenu}
    />,
  );
}

describe("ProjectRail touch", () => {
  it("lets a tap through after a lifted tile's drag is cancelled", async () => {
    await using screen = await renderRail();
    using _timers = fakeTimers();
    const tile = screen.container.querySelector("button[aria-label=ops]")!;
    const { x, y } = tile.getBoundingClientRect();
    await lift(tile, x + 4, y + 4);
    await cancelTouch(tile, x + 4, y + 4);

    await act(() => touch(tile, "touchstart", x + 4, y + 4));
    // A lifted touch cancels its compat mouse events, which would swallow this tap's click.
    expect(touch(tile, "touchend", x + 4, y + 4).defaultPrevented).toBe(false);
  });

  it("still opens the menu on a long press after a moved drag was cancelled", async () => {
    const onTileMenu = vi.fn();
    await using screen = await renderRail(onTileMenu);
    using _timers = fakeTimers();
    const tile = screen.container.querySelector("button[aria-label=ops]")!;
    const { x, y } = tile.getBoundingClientRect();
    await lift(tile, x + 4, y + 4);
    await act(() => touch(tile, "touchmove", x + 4, y + 30));
    await cancelTouch(tile, x + 4, y + 30);

    await lift(tile, x + 4, y + 4);
    await act(() => touch(tile, "touchend", x + 4, y + 4));
    expect(onTileMenu).toHaveBeenCalledWith(
      expect.objectContaining({ key: "tag:ops" }),
      expect.anything(),
    );
  });
});
