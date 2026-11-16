import { expect, it } from "vite-plus/test";
import { nextFileZoom, pinchFileZoom } from "./fileZoom";

it.each([
  [1.85, -1, 1.75],
  [1.85, 1, 2],
  [0.97, 1, 1],
  [1.03, -1, 1],
  [1, 1, 1.25],
  [1, -1, 0.75],
] as const)("moves %s in direction %s onto %s", (current, direction, expected) => {
  expect(nextFileZoom(current, direction, 0.25, 5)).toBe(expected);
});

it("keeps custom range boundaries reachable", () => {
  expect(nextFileZoom(0.25, -1, 0.2, 3)).toBe(0.2);
  expect(nextFileZoom(1, -1, 1, 5)).toBe(1);
  expect(nextFileZoom(3, 1, 0.25, 3)).toBe(3);
});

it("lands on 100 percent from either direction before continuing", () => {
  const increasing = pinchFileZoom(0.75, 1.85 / 0.75, 0.25, 5);
  expect(increasing).toBe(1);
  expect(pinchFileZoom(increasing, 1.25, 0.25, 5)).toBe(1.25);
  const decreasing = pinchFileZoom(1.85, 0.4, 0.25, 5);
  expect(decreasing).toBe(1);
  expect(pinchFileZoom(decreasing, 0.75, 0.25, 5)).toBe(0.75);
});

it("preserves smooth pinch movement between boundaries", () => {
  expect(pinchFileZoom(0.5, 1.02, 0.25, 5)).toBe(0.51);
  expect(pinchFileZoom(2, 1.02, 0.25, 5)).toBe(2.04);
  expect(pinchFileZoom(1, 0.1, 1, 5)).toBe(1);
  expect(pinchFileZoom(2, 100, 1, 5)).toBe(5);
});
