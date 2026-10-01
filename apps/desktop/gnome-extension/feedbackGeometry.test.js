import { expect, it } from "vite-plus/test";
import { captureDestinationFrame, findCaptureDestination } from "./feedbackGeometry.js";

const window = (pid, title) => ({ get_pid: () => pid, get_title: () => title });

it("activates only a window of the process authenticated by D-Bus", () => {
  const target = window(42, "T3 Code");
  expect(findCaptureDestination([window(99, "T3 Code"), target], 42, "T3 Code")).toBe(target);
  expect(findCaptureDestination([window(99, "T3 Code")], 42, "T3 Code")).toBeUndefined();
  expect(findCaptureDestination([target], 42, "Title before navigation")).toBe(target);
});

it("does not guess between ambiguous windows from the same process", () => {
  expect(findCaptureDestination([window(42, "T3"), window(42, "T3")], 42, "T3")).toBeUndefined();
  expect(findCaptureDestination([window(42, "A"), window(42, "B")], 42, "C")).toBeUndefined();
});

it("maps the composer onto GNOME's current window position and logical scale", () => {
  expect(
    captureDestinationFrame(
      { x: 0.1, y: 0.8, width: 0.2, height: 0.1 },
      { x: -1920, y: 30, width: 1200, height: 900 },
    ),
  ).toEqual({ x: -1800, y: 750, width: 240, height: 90 });
});

it.each([NaN, Infinity, -1, 2])("rejects invalid/off-window animation geometry %s", (x) => {
  expect(() =>
    captureDestinationFrame(
      { x, y: 0, width: 0.2, height: 0.1 },
      { x: 0, y: 0, width: 1200, height: 900 },
    ),
  ).toThrow("Invalid");
});
