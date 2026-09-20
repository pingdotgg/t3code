import { expect, it, vi } from "vite-plus/test";
import { bindPhoneTrackpad } from "./phoneTrackpad";

class Canvas extends EventTarget {
  getBoundingClientRect() {
    return { width: 400, height: 800 } as DOMRect;
  }
}
const wheel = (ctrlKey = false) =>
  Object.assign(new Event("wheel", { cancelable: true }), {
    deltaX: 16,
    deltaY: -20,
    deltaMode: 0,
    ctrlKey,
  });
const gesture = (type: string, scale: number) =>
  Object.assign(new Event(type, { cancelable: true }), { scale });

it("consumes scrolling and page zoom only on the bound canvas and releases listeners on detach", () => {
  const canvas = new Canvas();
  const navigate = vi.fn();
  const listeners = vi.spyOn(canvas, "addEventListener");
  const binding = bindPhoneTrackpad(canvas, { navigate });
  const swipe = wheel();
  canvas.dispatchEvent(swipe);
  const pinch = wheel(true);
  canvas.dispatchEvent(pinch);
  expect(swipe.defaultPrevented).toBe(true);
  expect(pinch.defaultPrevented).toBe(true);
  expect(navigate.mock.calls).toEqual([
    [{ type: "orbit", x: -0.04, y: 0.025 }],
    [{ type: "zoom", delta: 0.2 }],
  ]);
  expect(
    listeners.mock.calls.every(
      ([, , options]) => typeof options === "object" && options.passive === false,
    ),
  ).toBe(true);
  binding.dispose();
  const detached = wheel(true);
  canvas.dispatchEvent(detached);
  expect(detached.defaultPrevented).toBe(false);
  expect(navigate).toHaveBeenCalledTimes(2);
});

it("uses incremental Safari scales, suppresses duplicate wheel events, and cancels unfinished gestures", () => {
  const canvas = new Canvas();
  const navigate = vi.fn();
  const binding = bindPhoneTrackpad(canvas, { navigate });
  canvas.dispatchEvent(gesture("gesturestart", 1));
  canvas.dispatchEvent(gesture("gesturechange", 1.2));
  canvas.dispatchEvent(wheel(true));
  canvas.dispatchEvent(gesture("gesturechange", 1.5));
  canvas.dispatchEvent(gesture("gesturechange", 0));
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(navigate.mock.calls[0]?.[0].delta).toBeCloseTo(Math.log(1.2));
  expect(navigate.mock.calls[1]?.[0].delta).toBeCloseTo(Math.log(1.5 / 1.2));
  binding.cancel();
  canvas.dispatchEvent(wheel(true));
  expect(navigate).toHaveBeenCalledTimes(3);
  canvas.dispatchEvent(gesture("gesturechange", 2));
  expect(navigate).toHaveBeenCalledTimes(3);
  canvas.dispatchEvent(gesture("gesturestart", 1));
  canvas.dispatchEvent(gesture("gestureend", 1));
  canvas.dispatchEvent(wheel());
  expect(navigate).toHaveBeenCalledTimes(4);
  binding.dispose();
});
