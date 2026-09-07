import type { SensorProps } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, createElement, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";

class TestDocument extends EventTarget {
  hidden = false;
  getSelection = () => ({ removeAllRanges() {} });
}

let document: TestDocument;
let window: EventTarget;
const sensors: SidebarPointerSensor[] = [];

function pointer(type: string, values: Partial<PointerEvent> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    buttons: 1,
    ...values,
  });
}

function gesture() {
  const callbacks = {
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
    onPending: vi.fn(),
  };
  const onFinish = vi.fn();
  // The sensor never reads dnd-kit's layout context or active node.
  const props = {
    active: "thread",
    event: pointer("pointerdown"),
    options: { distance: 6, onAttach: vi.fn(), onFinish },
    ...callbacks,
  } as unknown as SensorProps<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]>;
  const sensor = new SidebarPointerSensor(props);
  sensors.push(sensor);
  return { sensor, onFinish, ...callbacks };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document = new TestDocument();
  window = Object.assign(new EventTarget(), { setTimeout });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
});
afterEach(() => {
  for (const sensor of sensors.splice(0)) sensor.cancel();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sidebar pointer lifecycle", () => {
  it("keeps a click idle and starts only after the drag threshold", () => {
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

  const interruptions = {
    blur: () => window.dispatchEvent(new Event("blur")),
    hidden: () => {
      document.hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    pagehide: () => window.dispatchEvent(new Event("pagehide")),
    resize: () => window.dispatchEvent(new Event("resize")),
    escape: () => document.dispatchEvent(Object.assign(new Event("keydown"), { code: "Escape" })),
    pointercancel: () => document.dispatchEvent(pointer("pointercancel")),
    "missed release": () =>
      document.dispatchEvent(pointer("pointermove", { buttons: 0, clientY: 100 })),
  };
  for (const [name, interrupt] of Object.entries(interruptions)) {
    it.each([false, true])(`cancels on ${name}, started=%s, and ignores late events`, (started) => {
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

      document.hidden = false;
      const next = gesture();
      document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
      document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
      expect(next.onStart).toHaveBeenCalledOnce();
      expect(next.onEnd).toHaveBeenCalledOnce();
    });
  }

  it("suppresses a delayed release click after cancellation, then accepts the next click", () => {
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
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

  it("allows the next click when the cancelled release happened outside the document", () => {
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    drag.sensor.cancel();
    document.dispatchEvent(pointer("pointerdown"));
    const click = new Event("click");
    const propagation = vi.spyOn(click, "stopPropagation");
    document.dispatchEvent(click);
    expect(propagation).not.toHaveBeenCalled();
  });

  it("does not move after cancellation during activation", () => {
    const drag = gesture();
    drag.onStart.mockImplementation(() => drag.sensor.cancel());
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onMove).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledOnce();
  });

  it("ignores events from other pointers", () => {
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { pointerId: 2, buttons: 0, clientY: 100 }));
    document.dispatchEvent(pointer("pointercancel", { pointerId: 2 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 2 }));
    expect(drag.onStart).not.toHaveBeenCalled();
    expect(drag.onFinish).not.toHaveBeenCalled();
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    expect(drag.onStart).toHaveBeenCalledOnce();
  });

  it.each([false, true])("cancels when search unmounts the list, started=%s", (started) => {
    let renderer: ReactTestRenderer;
    let drag: ReturnType<typeof gesture> | undefined;
    act(() => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(SidebarDragLifecycle, {
            onUnmount: () => drag?.sensor.cancel(),
          }),
        ),
      );
    });
    drag = gesture();
    if (started) document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    act(() => renderer.unmount());
    document.dispatchEvent(pointer("pointermove", { clientY: 100 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0 }));
    expect(drag.onStart).toHaveBeenCalledTimes(started ? 1 : 0);
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledOnce();
  });

  it("detaches a cancelled sensor before a replacement gesture starts", () => {
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
