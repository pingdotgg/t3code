import { expect, it } from "vite-plus/test";

import {
  scheduleTimeZoneChoices,
  scheduleTimeZoneLabel,
  schedulesDifferFromDevice,
} from "./scheduledTaskTimeZone.ts";

it("uses short names instead of full IANA zones", () => {
  expect(scheduleTimeZoneLabel(undefined)).toBeUndefined();
  expect(scheduleTimeZoneLabel("Unsupported/Zone")).toBeUndefined();
  expect(scheduleTimeZoneLabel("Etc/UTC")).toBe("UTC");
  expect(scheduleTimeZoneLabel("America/Los_Angeles")).toMatch(/^(PT|Los Angeles Time)$/);
  expect(scheduleTimeZoneLabel("America/Los_Angeles", "2027-01-15T17:00:00Z")).toBe("PST");
  expect(scheduleTimeZoneLabel("America/Los_Angeles", "2027-07-15T16:00:00Z")).toBe("PDT");
});

it("compares schedule zones with this device's zone by canonical name", () => {
  expect(schedulesDifferFromDevice([], "America/Denver")).toBe(false);
  expect(schedulesDifferFromDevice([undefined], "America/Denver")).toBe(false);
  expect(schedulesDifferFromDevice(["America/Denver"], "America/Denver")).toBe(false);
  expect(schedulesDifferFromDevice(["Asia/Calcutta"], "Asia/Kolkata")).toBe(false);
  expect(schedulesDifferFromDevice(["America/Denver", "Asia/Tokyo"], "America/Denver")).toBe(true);
});

it("offers every runtime zone plus UTC and a saved zone it no longer lists", () => {
  const choices = scheduleTimeZoneChoices("Legacy/Zone");
  expect(choices).toContain("UTC");
  expect(choices).toContain("Asia/Tokyo");
  expect(choices).toContain("Legacy/Zone");
  expect(scheduleTimeZoneChoices("")).not.toContain("");
});
