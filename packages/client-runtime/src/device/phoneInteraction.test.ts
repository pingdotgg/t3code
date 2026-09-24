import { expect, it, vi } from "vite-plus/test";
import { createPhoneInteraction, phoneWheelNavigation } from "./phoneInteraction.ts";

it("keeps a captured screen gesture separate from orbit and ends it once on cancellation", () => {
  const touch = vi.fn();
  const orbit = vi.fn();
  const screenPoint = vi
    .fn()
    .mockReturnValueOnce({ x: 0.2, y: 0.3 })
    .mockReturnValueOnce({ x: 1, y: 0.6 });
  const input = createPhoneInteraction({ screenPoint, touch, orbit, zoomBy: vi.fn() });
  expect(input.begin(1, { x: 0.4, y: 0.3 })).toBe(true);
  expect(input.begin(2, { x: 0.2, y: 0.2 })).toBe(false);
  input.move(2, { x: 0.8, y: 0.8 });
  input.move(1, { x: 1.3, y: 0.6 });
  input.end(2);
  input.end();
  input.end(1);
  expect(touch.mock.calls).toEqual([
    ["begin", { x: 0.2, y: 0.3 }],
    ["move", { x: 1, y: 0.6 }],
    ["end", { x: 1, y: 0.6 }],
  ]);
  expect(orbit).not.toHaveBeenCalled();
  expect(screenPoint.mock.calls[1]?.[1]).toBe(true);
});

it("orbits without sending touches when dragged outside the screen or with the orbit modifier", () => {
  const touch = vi.fn();
  const orbit = vi.fn();
  const input = createPhoneInteraction({ screenPoint: () => null, touch, orbit, zoomBy: vi.fn() });
  input.begin(1, { x: 0.1, y: 0.2 });
  input.move(1, { x: 0.4, y: 0.5 });
  input.end();
  input.begin(2, { x: 0.5, y: 0.5 }, true);
  input.move(2, { x: 0.6, y: 0.5 });
  input.end();
  expect(orbit).toHaveBeenCalledTimes(2);
  expect(orbit.mock.calls[0]?.[0]).toBeCloseTo(0.3);
  expect(touch).not.toHaveBeenCalled();
});

it("blocks navigation during either captured gesture, then resumes without sending device touches", () => {
  const touch = vi.fn();
  const orbit = vi.fn();
  const zoomBy = vi.fn();
  const input = createPhoneInteraction({
    screenPoint: () => ({ x: 0.5, y: 0.5 }),
    touch,
    orbit,
    zoomBy,
  });
  input.begin(1, { x: 0.5, y: 0.5 });
  expect(input.navigate({ type: "zoom", delta: 0.2 })).toBe(false);
  expect(input.navigate({ type: "orbit", x: 0.1, y: 0.2 })).toBe(false);
  input.end();
  input.begin(2, { x: 0.5, y: 0.5 }, true);
  expect(input.navigate({ type: "zoom", delta: 0.2 })).toBe(false);
  input.end();
  expect(input.navigate({ type: "zoom", delta: 0.2 })).toBe(true);
  expect(input.navigate({ type: "orbit", x: 0.1, y: 0.2 })).toBe(true);
  expect(zoomBy.mock.calls).toEqual([[0.2]]);
  expect(orbit.mock.calls).toEqual([[0.1, 0.2]]);
  expect(touch.mock.calls.map(([phase]) => phase)).toEqual(["begin", "end"]);
});

it("ends wheel orbit without ending a captured screen touch", () => {
  const onInteractionActive = vi.fn();
  const input = createPhoneInteraction({
    screenPoint: () => ({ x: 0.5, y: 0.5 }),
    touch: vi.fn(),
    orbit: vi.fn(),
    zoomBy: vi.fn(),
    onInteractionActive,
  });
  input.endWheel();
  expect(onInteractionActive).toHaveBeenCalledWith(false, "orbit");
  input.begin(1, { x: 0.5, y: 0.5 });
  onInteractionActive.mockClear();
  input.endWheel();
  expect(onInteractionActive).not.toHaveBeenCalled();
  input.end(1);
  expect(onInteractionActive).toHaveBeenCalledWith(false, "touch");
});

it("normalizes wheel units, distinguishes pinch, and bounds jumps from coarse scroll wheels", () => {
  const wheel = { width: 400, height: 800, deltaX: 16, deltaY: 32, deltaMode: 0, ctrlKey: false };
  expect(phoneWheelNavigation(wheel)).toEqual({ type: "orbit", x: -0.04, y: -0.04 });
  expect(phoneWheelNavigation({ ...wheel, deltaX: 1, deltaY: 2, deltaMode: 1 })).toEqual(
    phoneWheelNavigation(wheel),
  );
  expect(phoneWheelNavigation({ ...wheel, deltaX: 1, deltaY: 1, deltaMode: 2 })).toEqual({
    type: "orbit",
    x: -0.25,
    y: -0.25,
  });
  expect(phoneWheelNavigation({ ...wheel, ctrlKey: true })).toEqual({ type: "zoom", delta: -0.32 });
  expect(phoneWheelNavigation({ ...wheel, deltaY: -10000, ctrlKey: true })).toEqual({
    type: "zoom",
    delta: 1,
  });
  expect(phoneWheelNavigation({ ...wheel, width: 0 })).toBeNull();
  expect(phoneWheelNavigation({ ...wheel, deltaY: NaN })).toBeNull();
  expect(phoneWheelNavigation({ ...wheel, deltaMode: 9 })).toBeNull();
});
