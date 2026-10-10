import { expect, it } from "vite-plus/test";
import { resolveDeviceShape } from "./shapeProfile.ts";

it("chooses tablet and phone families without mistaking display rotation for device shape", () => {
  expect(
    resolveDeviceShape({ platform: "ios", name: "iPad Pro 11-inch (M5)", portraitAspect: 0.75 }).id,
  ).toBe("ios-tablet");
  expect(
    resolveDeviceShape({ platform: "ios", name: "iPhone 18 Pro", portraitAspect: 0.46 }).id,
  ).toBe("ios-phone");
  expect(
    resolveDeviceShape({ platform: "android", name: "Pixel 9", portraitAspect: 0.45 }).id,
  ).toBe("android-phone");
  expect(
    resolveDeviceShape({ platform: "android", name: "Pixel Tablet", portraitAspect: 0.625 }).id,
  ).toBe("android-tablet");
});

it("uses the screen shape for renamed devices and a phone fallback before metadata arrives", () => {
  expect(resolveDeviceShape({ platform: "ios", name: "Julius", portraitAspect: 0.75 }).id).toBe(
    "ios-tablet",
  );
  expect(resolveDeviceShape({ platform: "android", portraitAspect: 0.45 }).id).toBe(
    "android-phone",
  );
  expect(resolveDeviceShape({ platform: "ios", portraitAspect: Number.NaN }).id).toBe("ios-phone");
});
