import { expect, it } from "vite-plus/test";
import { fitDeviceFrame } from "./deviceFrameLayout";

it("fits a flat device beside the fixed controls rail", () => {
  const frame = fitDeviceFrame(9 / 19.5, 480, 1_000, 56);
  expect(frame.width + 56).toBeLessThanOrEqual(480);
  expect(frame.height).toBeLessThanOrEqual(1_000);
  expect(frame.width / frame.height).toBeCloseTo(9 / 19.5);
});
