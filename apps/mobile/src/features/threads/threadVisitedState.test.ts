import { describe, expect, it } from "vite-plus/test";

import { resolveVisitWatermark, shouldAcknowledgeThreadVisit } from "./threadVisitedState";

const base = {
  appState: "active" as const,
  connectionState: "connected" as const,
  supported: true,
  detailLoaded: true,
  completedAt: "2026-01-01T00:01:00.000Z",
  lastVisitedAt: "2026-01-01T00:00:30.000Z",
};

describe("shouldAcknowledgeThreadVisit", () => {
  it("acknowledges an unseen completion while active and connected", () => {
    expect(shouldAcknowledgeThreadVisit(base)).toBe(true);
    expect(shouldAcknowledgeThreadVisit({ ...base, lastVisitedAt: null })).toBe(true);
  });

  it("skips when the watermark already covers the completion", () => {
    expect(shouldAcknowledgeThreadVisit({ ...base, lastVisitedAt: base.completedAt })).toBe(false);
  });

  it("skips when backgrounded, disconnected, unsupported, unloaded, or without a completion", () => {
    expect(shouldAcknowledgeThreadVisit({ ...base, appState: "background" })).toBe(false);
    expect(shouldAcknowledgeThreadVisit({ ...base, connectionState: "reconnecting" })).toBe(false);
    expect(shouldAcknowledgeThreadVisit({ ...base, supported: false })).toBe(false);
    expect(shouldAcknowledgeThreadVisit({ ...base, detailLoaded: false })).toBe(false);
    expect(shouldAcknowledgeThreadVisit({ ...base, completedAt: null })).toBe(false);
  });

  it("never acknowledges a malformed completion", () => {
    expect(shouldAcknowledgeThreadVisit({ ...base, completedAt: "not-a-date" })).toBe(false);
  });
});

describe("resolveVisitWatermark", () => {
  it("stamps updatedAt when it is later than the completion", () => {
    expect(
      resolveVisitWatermark({
        updatedAt: "2026-01-01T00:02:00.000Z",
        completedAt: base.completedAt,
      }),
    ).toBe("2026-01-01T00:02:00.000Z");
  });

  it("floors at the completion when updatedAt is older, missing, or malformed", () => {
    expect(
      resolveVisitWatermark({
        updatedAt: "2026-01-01T00:00:59.000Z",
        completedAt: base.completedAt,
      }),
    ).toBe(base.completedAt);
    expect(resolveVisitWatermark({ updatedAt: null, completedAt: base.completedAt })).toBe(
      base.completedAt,
    );
    expect(resolveVisitWatermark({ updatedAt: "nope", completedAt: base.completedAt })).toBe(
      base.completedAt,
    );
  });
});
