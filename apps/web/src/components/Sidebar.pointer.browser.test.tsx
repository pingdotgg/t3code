import type { SensorProps } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vite-plus/test";
import { StrictMode } from "react";
import { fakeTimers, render } from "../../test/render";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";

const sensors: SidebarPointerSensor[] = [];
let hidden = false;

function pointer(type: string, values: PointerEventInit = {}) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    buttons: 1,
    ...values,
  });
}

function gesture(
  extraOptions: Partial<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]> = {},
) {
  const callbacks = {
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
    onPending: vi.fn(),
  };
  const onFinish = vi.fn();
  const props = {
    active: "thread",
    event: pointer("pointerdown"),
    options: { distance: 6, onAttach: vi.fn(), onFinish, ...extraOptions },
    ...callbacks,
  } as unknown as SensorProps<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]>;
  const sensor = new SidebarPointerSensor(props);
  sensors.push(sensor);
  return { sensor, onFinish, ...callbacks };
}

function setup() {
  const stack = new DisposableStack();
  stack.use(fakeTimers());
  hidden = false;
  stack.use(vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden));
  stack.defer(() => {
    for (const sensor of sensors.splice(0)) sensor.cancel();
    // Cancelled sensors keep suppressing clicks on the shared document until the next press.
    document.dispatchEvent(pointer("pointerdown"));
    vi.runAllTimers();
  });
  return stack;
}

describe("sidebar pointer lifecycle", () => {
  it("keeps a click idle and starts only after the drag threshold", () => {
    using _environment = setup();
    const click = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 16 }));
    expect(click.onStart).not.toHaveBeenCalled();
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(click.onAbort).toHaveBeenCalledOnce();
    expect(click.onFinish).toHaveBeenCalledOnce();

    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 17 }));
    expect(drag.onStart).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 10 });
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(drag.onEnd).toHaveBeenCalledOnce();
    expect(drag.onAbort).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledOnce();
  });

  it("moves to the pointer on the move that starts the drag", () => {
    using _environment = setup();
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 90 }));
    expect(drag.onStart).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 10 });
    expect(drag.onMove).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 90 });
  });

  const interruptions = {
    blur: () => window.dispatchEvent(new Event("blur")),
    hidden: () => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    pagehide: () => window.dispatchEvent(new Event("pagehide")),
    resize: () => window.dispatchEvent(new Event("resize")),
    escape: () => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" })),
    pointercancel: () => document.dispatchEvent(pointer("pointercancel")),
    "missed release": () =>
      document.dispatchEvent(pointer("pointermove", { buttons: 0, clientY: 100 })),
  };
  for (const [name, interrupt] of Object.entries(interruptions)) {
    it.each([false, true])(`cancels on ${name}, started=%s, and ignores late events`, (started) => {
      using _environment = setup();
      const drag = gesture();
      if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
      interrupt();
      document.dispatchEvent(pointer("pointermove", { clientY: 100 }));
      document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
      drag.sensor.cancel();
      expect(drag.onCancel).toHaveBeenCalledOnce();
      expect(drag.onEnd).not.toHaveBeenCalled();
      expect(drag.onFinish).toHaveBeenCalledOnce();
      expect(drag.onStart).toHaveBeenCalledTimes(started ? 1 : 0);
      expect(drag.onAbort).toHaveBeenCalledTimes(started ? 0 : 1);

      hidden = false;
      const next = gesture();
      document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
      document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
      expect(next.onStart).toHaveBeenCalledOnce();
      expect(next.onEnd).toHaveBeenCalledOnce();
    });
  }

  it("hands claimed moves and drops to the context handlers and cancels the sort", () => {
    using _environment = setup();
    const onMove = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 30 }));
    expect(drag.onMove).toHaveBeenNthCalledWith(1, { x: 10, y: 20 });
    expect(drag.onMove).toHaveBeenNthCalledWith(2, { x: 30, y: 30 });
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));
    expect(drag.onMove).toHaveBeenCalledTimes(2);
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 90, clientY: 30 }));
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 90, y: 30 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);

    const inside = gesture({ onMove, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 10, clientY: 20 }));
    expect(inside.onEnd).toHaveBeenCalledOnce();
    expect(inside.onCancel).not.toHaveBeenCalled();
  });

  it("drops context when a zero-button move precedes pointerup", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));

    // Native desktop releases can report the released button on the final move.
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 100, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 94, y: 32 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("cancels a missed sidebar release without committing a reorder", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 30, clientY: 40 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 30, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 40 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not drop context when the button is released before activation", () => {
    using _environment = setup();
    const onDrop = vi.fn(() => true);
    const drag = gesture({ onDrop });
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 90, clientY: 30 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 90, clientY: 30 }));

    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.onStart).not.toHaveBeenCalled();
    expect(drag.onAbort).toHaveBeenCalledOnce();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("resumes reordering when a context drag returns to the sidebar", () => {
    using _environment = setup();
    const drag = gesture({
      onMove: (point) => point.x > 50,
      onDrop: (point) => point.x > 50,
    });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 30 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 100 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 200 }));
    expect(drag.onMove).toHaveBeenCalledTimes(2);
    expect(drag.onMove).toHaveBeenLastCalledWith({ x: 30, y: 30 });

    document.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 60 }));
    expect(drag.onMove).toHaveBeenLastCalledWith({ x: 30, y: 60 });
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 30, clientY: 60 }));
    expect(drag.onEnd).toHaveBeenCalledOnce();
    expect(drag.onCancel).not.toHaveBeenCalled();
  });

  it.each([false, true])("suppresses a cancelled release click, started=%s", (started) => {
    using _environment = setup();
    const drag = gesture();
    if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    drag.sensor.cancel();
    vi.advanceTimersByTime(1000);
    const releaseClick = new Event("click");
    const releasePropagation = vi.spyOn(releaseClick, "stopPropagation");
    document.dispatchEvent(releaseClick);
    expect(releasePropagation).toHaveBeenCalledOnce();
    document.dispatchEvent(pointer("pointerdown"));
    const nextClick = new Event("click");
    const nextPropagation = vi.spyOn(nextClick, "stopPropagation");
    document.dispatchEvent(nextClick);
    expect(nextPropagation).not.toHaveBeenCalled();
  });

  it.each([false, true])("allows a fresh click after an outside release, started=%s", (started) => {
    using _environment = setup();
    const drag = gesture();
    if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    drag.sensor.cancel();
    document.dispatchEvent(pointer("pointerdown"));
    const click = new Event("click");
    const propagation = vi.spyOn(click, "stopPropagation");
    document.dispatchEvent(click);
    expect(propagation).not.toHaveBeenCalled();
  });

  it("does not move after cancellation during activation", () => {
    using _environment = setup();
    const drag = gesture();
    drag.onStart.mockImplementation(() => drag.sensor.cancel());
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onMove).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledOnce();
  });

  it("ignores events from other pointers", () => {
    using _environment = setup();
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { pointerId: 2, buttons: 0, clientY: 100 }));
    document.dispatchEvent(pointer("pointercancel", { pointerId: 2 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 2 }));
    expect(drag.onStart).not.toHaveBeenCalled();
    expect(drag.onFinish).not.toHaveBeenCalled();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    expect(drag.onStart).toHaveBeenCalledOnce();
  });

  it.each([false, true])("cancels when search unmounts the list, started=%s", async (started) => {
    using _environment = setup();
    let drag: ReturnType<typeof gesture> | undefined;
    await using screen = await render(
      <StrictMode>
        <SidebarDragLifecycle onUnmount={() => drag?.sensor.cancel()} />
      </StrictMode>,
    );
    drag = gesture();
    if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    await screen.unmount();
    document.dispatchEvent(pointer("pointermove", { clientY: 100 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(drag.onStart).toHaveBeenCalledTimes(started ? 1 : 0);
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledOnce();
  });

  it("detaches a cancelled sensor before a replacement gesture starts", () => {
    using _environment = setup();
    const previous = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    previous.sensor.cancel();
    const next = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(previous.onCancel).toHaveBeenCalledOnce();
    expect(previous.onEnd).not.toHaveBeenCalled();
    expect(next.onEnd).toHaveBeenCalledOnce();
  });
});
