import { expect, it } from "vite-plus/test";
import { createPhonePose } from "./phonePose.ts";

it("combines incremental pinches reversibly and clamps the camera scale", () => {
  const pose = createPhonePose();
  pose.zoomBy(Math.log(1.2));
  pose.zoomBy(Math.log(1.5 / 1.2));
  expect(pose.zoom).toBeCloseTo(1.5);
  pose.zoomBy(Math.log(1 / 1.5));
  expect(pose.zoom).toBeCloseTo(1);
  pose.zoomBy(1000);
  expect(pose.zoom).toBeCloseTo(2.2);
  pose.zoomBy(-1000);
  expect(pose.zoom).toBeCloseTo(0.6);
  pose.zoomBy(Infinity);
  pose.zoomBy(NaN);
  expect(pose.zoom).toBeCloseTo(0.6);
});

it("reset restores a fitted front view after navigation and invalid deltas cannot corrupt the pose", () => {
  const pose = createPhonePose();
  pose.orbit(0.5, 100);
  expect(pose.pitch).toBe(0.7);
  expect(pose.yaw).toBeCloseTo(1.88);
  pose.orbit(NaN, 0.1);
  expect(pose.pitch).toBe(0.7);
  pose.zoomBy(0.5);
  pose.reset();
  expect({ pitch: pose.pitch, yaw: pose.yaw, zoom: pose.zoom }).toEqual({
    pitch: 0,
    yaw: 0,
    zoom: 1,
  });
});
