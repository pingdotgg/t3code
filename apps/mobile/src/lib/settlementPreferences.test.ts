import { describe, expect, it } from "vite-plus/test";

import {
  formatChangeRequestSettleIdleMinutes,
  isChangeRequestSettleIdleMinutes,
  resolveChangeRequestSettleIdleMs,
} from "./settlementPreferences";

describe("change-request settlement preferences", () => {
  it("defaults to immediate settlement", () => {
    expect(resolveChangeRequestSettleIdleMs(undefined)).toBe(0);
  });

  it("converts configured minutes to milliseconds", () => {
    expect(resolveChangeRequestSettleIdleMs(0)).toBe(0);
    expect(resolveChangeRequestSettleIdleMs(90)).toBe(90 * 60 * 1_000);
  });

  it.each([0, 15, 60, 1_440])("accepts a supported value: %s", (value) => {
    expect(isChangeRequestSettleIdleMinutes(value)).toBe(true);
  });

  it.each([-15, 10, 1_441, 1.5, "60", null])("rejects an unsupported value: %s", (value) => {
    expect(isChangeRequestSettleIdleMinutes(value)).toBe(false);
  });

  it("formats compact mobile labels", () => {
    expect(formatChangeRequestSettleIdleMinutes(0)).toBe("Now");
    expect(formatChangeRequestSettleIdleMinutes(45)).toBe("45m");
    expect(formatChangeRequestSettleIdleMinutes(60)).toBe("1h");
    expect(formatChangeRequestSettleIdleMinutes(90)).toBe("1h 30m");
  });
});
