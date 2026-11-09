import { DndContext, useDndContext, useDraggable } from "@dnd-kit/core";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { sidebarMarkerId } from "../Sidebar.logic";
import { SidebarSectionHeader } from "./SidebarListMarkers";

vi.mock("./SidebarThreadRow", () => ({
  SIDEBAR_SORTABLE_DRAG_DISABLED: { draggable: true },
}));

function Shelf({ count }: { count: number }) {
  const { active } = useDndContext();
  const { setNodeRef, attributes, listeners } = useDraggable({ id: "thread" });
  return (
    <>
      <button ref={setNodeRef} {...attributes} {...listeners}>
        Thread
      </button>
      <ul>
        <SidebarSectionHeader
          marker="settled-header"
          label="Settled"
          count={count}
          dragging={active !== null}
          toggle={{ expanded: false, onToggle: () => {} }}
        />
      </ul>
    </>
  );
}

function Harness() {
  const [count, setCount] = useState(0);
  return (
    <div className="w-64">
      <DndContext
        onDragEnd={({ over }) => {
          if (over?.id === sidebarMarkerId("settled-header")) setCount(1);
        }}
      >
        <Shelf count={count} />
      </DndContext>
      <button onClick={() => setCount(0)}>Unsettle</button>
    </div>
  );
}

it("reveals an empty Settled drop target only for a drag and keeps it after a drop", async () => {
  await using screen = await render(<Harness />, {
    router: false /* shelf drag/drop does not navigate */,
  });
  const settled = screen.getByRole("button", { name: /^Settled\s*0$/ });
  await expect.element(settled).not.toBeInTheDocument();

  const startDrag = async () => {
    const thread = screen.getByRole("button", { name: "Thread" }).element();
    const { x, y, width, height } = thread.getBoundingClientRect();
    await act(() => {
      thread.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          button: 0,
          buttons: 1,
          clientX: x + width / 2,
          clientY: y + height / 2,
        }),
      );
    });
    await expect.element(settled).toBeVisible();
  };

  await startDrag();
  await act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    ),
  );
  await expect.element(settled).not.toBeInTheDocument();

  await startDrag();
  const target = settled.element().getBoundingClientRect();
  await act(() => {
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        buttons: 1,
        clientX: target.x + target.width / 2,
        clientY: target.y + target.height / 2,
      }),
    );
  });
  await act(() => document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 })));
  await expect.element(screen.getByRole("button", { name: /^Settled\s*1$/ })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Unsettle" }));
  await expect.element(settled).not.toBeInTheDocument();
});
