import { afterEach, expect, it, vi } from "vite-plus/test";
import { bindPhoneTrackpad } from "./phoneTrackpad";

afterEach(() => vi.useRealTimers());

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
  expect(navigate.mock.calls).toEqual([[{ type: "orbit", x: -0.04, y: 0.025 }]]);
  expect(
    listeners.mock.calls.every(
      ([, , options]) => typeof options === "object" && options.passive === false,
    ),
  ).toBe(true);
  binding.dispose();
  const detached = wheel(true);
  canvas.dispatchEvent(detached);
  expect(detached.defaultPrevented).toBe(false);
  expect(navigate).toHaveBeenCalledOnce();
});

it("consumes Safari pinch without zooming the model and resumes orbit after cancellation", () => {
  const canvas = new Canvas();
  const navigate = vi.fn();
  const binding = bindPhoneTrackpad(canvas, { navigate });
  canvas.dispatchEvent(gesture("gesturestart", 1));
  canvas.dispatchEvent(gesture("gesturechange", 1.2));
  canvas.dispatchEvent(wheel(true));
  expect(navigate).not.toHaveBeenCalled();
  binding.cancel();
  canvas.dispatchEvent(wheel());
  expect(navigate).toHaveBeenCalledOnce();
  binding.dispose();
});

it("normalizes Chrome and Safari pinch, expires wheel sequences and cancels on detach", () => {
  vi.useFakeTimers();
  const canvas = new Canvas();
  const pinch = { begin: vi.fn(() => true), move: vi.fn(), end: vi.fn() };
  const navigate = vi.fn();
  const binding = bindPhoneTrackpad(canvas, { navigate }, pinch);
  canvas.dispatchEvent(wheel(true));
  canvas.dispatchEvent(wheel(true));
  expect(pinch.begin).toHaveBeenCalledOnce();
  expect(pinch.move.mock.calls).toEqual([[0.2], [0.2]]);
  vi.advanceTimersByTime(180);
  expect(pinch.end).toHaveBeenCalledOnce();
  canvas.dispatchEvent(gesture("gesturestart", 1));
  canvas.dispatchEvent(gesture("gesturechange", 1.2));
  expect(pinch.move).toHaveBeenLastCalledWith(Math.log(1.2));
  canvas.dispatchEvent(wheel(true));
  expect(pinch.move).toHaveBeenCalledTimes(3);
  binding.dispose();
  const count = pinch.move.mock.calls.length;
  vi.advanceTimersByTime(500);
  canvas.dispatchEvent(wheel(true));
  expect(pinch.move).toHaveBeenCalledTimes(count);
  expect(navigate).not.toHaveBeenCalled();
});
