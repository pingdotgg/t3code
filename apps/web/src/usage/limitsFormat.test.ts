import { describe, expect, it } from "vite-plus/test";

import { formatSidebarResetAt } from "./limitsFormat";

describe("formatSidebarResetAt", () => {
  const nowMs = Date.parse("2026-08-12T12:00:00.000Z");

  it("labels due and past resets as now", () => {
    expect(formatSidebarResetAt("2026-08-12T12:00:00.000Z", nowMs)).toBe("Resets now");
    expect(formatSidebarResetAt("2026-08-12T11:59:59.000Z", nowMs)).toBe("Resets now");
  });

  it("handles missing and invalid reset times", () => {
    expect(formatSidebarResetAt(null, nowMs)).toBe("Reset time unavailable");
    expect(formatSidebarResetAt("not-a-date", nowMs)).toBe("Reset time unavailable");
  });
});
