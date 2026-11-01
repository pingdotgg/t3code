import {
  type CollisionDetection,
  DndContext,
  PointerSensor,
  rectIntersection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  type SortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { sidebarMarkerId } from "../Sidebar.logic";
import { SidebarSectionPlaceholder } from "./SidebarListMarkers";

const ROW_IDS = Array.from({ length: 40 }, (_, index) => `thread-${index}`);

function Row(props: { id: string }) {
  const { setNodeRef, listeners } = useSortable({ id: props.id });
  return (
    <li ref={setNodeRef} data-testid={props.id} className="h-9 list-none" {...listeners}>
      {props.id}
    </li>
  );
}

function SortableList(props: {
  strategy?: SortingStrategy;
  collisionDetection?: CollisionDetection;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }));
  return (
    <div data-testid="scroller" style={{ height: 300, overflowY: "auto" }}>
      <DndContext
        sensors={sensors}
        autoScroll={false}
        collisionDetection={props.collisionDetection ?? rectIntersection}
      >
        <SortableContext
          items={[...ROW_IDS, sidebarMarkerId("settled-placeholder")]}
          strategy={props.strategy ?? verticalListSortingStrategy}
        >
          <ul>
            {ROW_IDS.map((id) => (
              <Row key={id} id={id} />
            ))}
            <SidebarSectionPlaceholder
              marker="settled-placeholder"
              label="Drop to settle"
              showHint
              isDropTarget={false}
            />
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function pointer(type: string, target: Element, deltaY: number) {
  const rect = target.getBoundingClientRect();
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: 1,
    clientX: rect.left + 10,
    clientY: rect.top + rect.height / 2 + deltaY,
  });
}

describe("SidebarSectionPlaceholder", () => {
  it("does not scroll the list to an off-screen settled drop hint when a drag starts", async () => {
    await using screen = await render(<SortableList />);
    const scroller = screen.getByTestId("scroller").element();
    const row = screen.getByTestId("thread-1").element();

    row.dispatchEvent(pointer("pointerdown", row, 0));
    document.dispatchEvent(pointer("pointermove", row, -6));
    const hint = screen.getByTestId("sidebar-settled-placeholder").element();
    await vi.waitFor(() => expect(hint.getAttribute("style")).toContain("translate"));

    expect(scroller.scrollTop, "drag start scrolled the list to the settled drop hint").toBe(0);
    document.dispatchEvent(pointer("pointerup", row, -6));
  });

  it("reveals a settled drop hint the viewport clips at its bottom edge", async () => {
    await using screen = await render(<SortableList />);
    const scroller = screen.getByTestId("scroller").element();
    const placeholder = screen.getByTestId("sidebar-settled-placeholder").element();
    const box = placeholder.firstElementChild!;
    const clipped = box.getBoundingClientRect();
    scroller.scrollTop +=
      clipped.top + clipped.height / 2 - scroller.getBoundingClientRect().bottom;
    const row = screen.getByTestId("thread-38").element();

    row.dispatchEvent(pointer("pointerdown", row, 0));
    document.dispatchEvent(pointer("pointermove", row, -6));
    await vi.waitFor(() => expect(placeholder.getAttribute("style")).toContain("translate"));

    expect(box.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().bottom,
    );
    document.dispatchEvent(pointer("pointerup", row, -6));
  });

  // Lifting a row into a taller section moves the hint a card's height down in one step; into a
  // shorter one, up.
  it.each([
    {
      motion: "pushes a visible hint below",
      shift: 80,
      restingTop: (height: number) => -height - 4,
    },
    { motion: "lifts a hint resting below into", shift: -46, restingTop: () => 35 },
  ])("reveals the settled drop hint when the drag $motion the viewport", async (fixture) => {
    const shiftHint: SortingStrategy = (args) =>
      args.index === ROW_IDS.length
        ? { x: 0, y: fixture.shift, scaleX: 1, scaleY: 1 }
        : verticalListSortingStrategy(args);
    await using screen = await render(
      <SortableList strategy={shiftHint} collisionDetection={() => [{ id: "thread-0" }]} />,
    );
    const scroller = screen.getByTestId("scroller").element();
    const placeholder = screen.getByTestId("sidebar-settled-placeholder").element();
    const box = placeholder.firstElementChild!;
    const resting = box.getBoundingClientRect();
    scroller.scrollTop +=
      resting.top - scroller.getBoundingClientRect().bottom - fixture.restingTop(resting.height);
    const row = screen.getByTestId("thread-38").element();

    row.dispatchEvent(pointer("pointerdown", row, 0));
    document.dispatchEvent(pointer("pointermove", row, -6));
    await vi.waitFor(() => expect(placeholder.getAttribute("style")).toContain("translate"));

    expect(box.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().bottom,
    );
    document.dispatchEvent(pointer("pointerup", row, -6));
  });
});
