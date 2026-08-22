import { describe, expect, it } from "vite-plus/test";

import {
  formatAllowanceDuration,
  formatAllowanceUpdatedAt,
  formatAllowanceWindowScope,
  progressWidthForAllowance,
} from "@t3tools/client-runtime/state/subscription-allowance";

describe("usage allowance presentation", () => {
  it("uses the provider scope and duration without deriving missing values", () => {
    expect(formatAllowanceWindowScope("primary")).toBe("Primary limit");
    expect(formatAllowanceWindowScope("secondary")).toBe("Secondary limit");
    expect(formatAllowanceWindowScope("five_hour")).toBe("5-hour limit");
    expect(formatAllowanceWindowScope("seven_day_opus")).toBe("7-day Opus limit");
    expect(formatAllowanceWindowScope("provider_native_window")).toBe("provider_native_window");
    expect(formatAllowanceDuration(300)).toBe("5 hours");
    expect(formatAllowanceDuration(null)).toBeNull();
    expect(formatAllowanceDuration(undefined)).toBeNull();
  });

  it("clamps only the visual progress bar, preserving native percentage text", () => {
    expect(progressWidthForAllowance(-1)).toBe(0);
    expect(progressWidthForAllowance(42)).toBe(42);
    expect(progressWidthForAllowance(101)).toBe(100);
  });

  it("shows relative observation age without exposing a local timestamp", () => {
    const now = Date.parse("2026-08-12T12:00:00.000Z");

    expect(formatAllowanceUpdatedAt("2026-08-12T12:00:00.000Z", now)).toBe("Updated just now");
    expect(formatAllowanceUpdatedAt("2026-08-12T11:57:00.000Z", now)).toBe("Updated 3m ago");
    expect(formatAllowanceUpdatedAt("2026-08-12T10:00:00.000Z", now)).toBe("Updated 2h ago");
    expect(formatAllowanceUpdatedAt("2026-08-10T12:00:00.000Z", now)).toBe("Updated 2d ago");
  });
});
