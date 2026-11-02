import type { PointerEvent as ReactPointerEvent } from "react";
import { expect, it, vi } from "vite-plus/test";

import { beginDockDrag } from "./dockDrag";

function setup() {
  const root = document.createElement("div");
  root.dataset.dockRoot = "";
  const later = document.createElement("button");
  document.body.append(root, later);
  const onDrop = vi.fn();
  const drag = () => {
    const pointer = { pointerId: 1, button: 0, clientX: 10, clientY: 10 };
    beginDockDrag({
      event: { ...pointer, pointerType: "mouse" } as ReactPointerEvent,
      label: "Terminal",
      sourceGroupId: "panel",
      sourceTabCount: 2,
      onDrop,
    });
    window.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX: 60 }));
    window.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 60 }));
  };
  return {
    drag,
    later,
    [Symbol.dispose]: () => {
      root.remove();
      later.remove();
    },
  };
}

it("leaves the next click alone when a drop moved the tab and no click ended the drag", async () => {
  using fixture = setup();
  using removeListener = vi.spyOn(window, "removeEventListener");
  const onClick = vi.fn();
  fixture.later.addEventListener("click", onClick);

  fixture.drag();
  await vi.waitFor(() =>
    expect(removeListener).toHaveBeenCalledWith("click", expect.any(Function), true),
  );
  fixture.later.click();

  expect(onClick).toHaveBeenCalledTimes(1);
});

it("swallows the click that ends a drag, so it does not press what was dragged", () => {
  using fixture = setup();
  const onClick = vi.fn();
  fixture.later.addEventListener("click", onClick);

  fixture.drag();
  fixture.later.click();

  expect(onClick).not.toHaveBeenCalled();
});
