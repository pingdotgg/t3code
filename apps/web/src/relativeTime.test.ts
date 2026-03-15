import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relativeTime";

describe("formatRelativeTime", () => {
  const nowMs = Date.parse("2026-03-15T12:00:00.000Z");

  it("returns just now for times under a minute old", () => {
    expect(formatRelativeTime("2026-03-15T11:59:45.000Z", nowMs)).toBe("just now");
  });

  it("formats minutes, hours, and days ago", () => {
    expect(formatRelativeTime("2026-03-15T11:55:00.000Z", nowMs)).toBe("5 minutes ago");
    expect(formatRelativeTime("2026-03-15T09:00:00.000Z", nowMs)).toBe("3 hours ago");
    expect(formatRelativeTime("2026-03-12T12:00:00.000Z", nowMs)).toBe("3 days ago");
  });

  it("supports compact m/h/d formatting", () => {
    expect(formatRelativeTime("2026-03-15T11:55:00.000Z", nowMs, "short")).toBe("5m ago");
    expect(formatRelativeTime("2026-03-15T09:00:00.000Z", nowMs, "short")).toBe("3h ago");
    expect(formatRelativeTime("2026-03-12T12:00:00.000Z", nowMs, "short")).toBe("3d ago");
  });
});
