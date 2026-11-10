import { describe, expect, it } from "vite-plus/test";

import { minuteTickToEpochMs } from "./clock";

describe("minuteTickToEpochMs", () => {
  it("reads the minute tick as UTC regardless of the device timezone", () => {
    expect(minuteTickToEpochMs("2026-10-26T02:14")).toBe(Date.UTC(2026, 9, 26, 2, 14));
  });
});
