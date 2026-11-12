import { expect, it } from "vite-plus/test";

import { scheduleTimeZoneLabel } from "./scheduledTaskTimeZone.ts";

it("uses short names instead of full IANA zones", () => {
  expect(scheduleTimeZoneLabel(undefined)).toBeUndefined();
  expect(scheduleTimeZoneLabel("Unsupported/Zone")).toBeUndefined();
  expect(scheduleTimeZoneLabel("Etc/UTC")).toBe("UTC");
  expect(scheduleTimeZoneLabel("America/Los_Angeles")).toMatch(/^(PT|Los Angeles Time)$/);
  expect(scheduleTimeZoneLabel("America/Los_Angeles", "2027-01-15T17:00:00Z")).toBe("PST");
  expect(scheduleTimeZoneLabel("America/Los_Angeles", "2027-07-15T16:00:00Z")).toBe("PDT");
});
