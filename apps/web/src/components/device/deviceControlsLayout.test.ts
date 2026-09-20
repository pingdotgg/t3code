import { expect, it } from "vite-plus/test";
import { deviceControlsLayout } from "./deviceControlsLayout";

const portrait = { height: 748, aspect: 9 / 19.5, android: false };

it("floats beside a height-fitted device in both presentations", () => {
  for (const phone of [false, true]) {
    expect(deviceControlsLayout({ ...portrait, width: 600, phone })).toBe("rail");
  }
});

it("uses the header before controls would overlap the flat screen", () => {
  expect(deviceControlsLayout({ ...portrait, width: 433, phone: false })).toBe("rail");
  expect(deviceControlsLayout({ ...portrait, width: 390, phone: false })).toBe("header");
  expect(deviceControlsLayout({ ...portrait, width: 433, phone: true })).toBe("rail");
  expect(deviceControlsLayout({ ...portrait, width: 300, phone: true })).toBe("header");
});

it("uses the combined spare width rather than requiring equal gutters", () => {
  expect(deviceControlsLayout({ ...portrait, width: 308, height: 515, phone: false })).toBe("rail");
  expect(deviceControlsLayout({ ...portrait, width: 290, height: 515, phone: false })).toBe(
    "header",
  );
});

it("reconsiders placement when the device rotates or the panel is too short", () => {
  expect(deviceControlsLayout({ ...portrait, width: 600, aspect: 19.5 / 9, phone: false })).toBe(
    "header",
  );
  expect(deviceControlsLayout({ ...portrait, width: 600, height: 350, phone: true })).toBe(
    "header",
  );
  expect(
    deviceControlsLayout({ ...portrait, width: 600, height: 430, phone: true, android: true }),
  ).toBe("header");
});
