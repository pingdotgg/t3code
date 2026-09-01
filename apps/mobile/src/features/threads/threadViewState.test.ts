import { describe, expect, it } from "vite-plus/test";

import { shouldAcknowledgeThreadView } from "./threadViewState";

const base = {
  appState: "active" as const,
  connectionState: "connected" as const,
  supported: true,
  completedAt: "2026-01-01T00:01:00.000Z",
  viewedAt: "2026-01-01T00:00:30.000Z",
};

describe("shouldAcknowledgeThreadView", () => {
  it("acknowledges an unseen completion while active and connected", () => {
    expect(shouldAcknowledgeThreadView(base)).toBe(true);
    expect(shouldAcknowledgeThreadView({ ...base, viewedAt: undefined })).toBe(true);
  });

  it("skips when the server already covers the completion", () => {
    expect(shouldAcknowledgeThreadView({ ...base, viewedAt: base.completedAt })).toBe(false);
  });

  it("skips when backgrounded, disconnected, unsupported, or without a completion", () => {
    expect(shouldAcknowledgeThreadView({ ...base, appState: "background" })).toBe(false);
    expect(shouldAcknowledgeThreadView({ ...base, connectionState: "reconnecting" })).toBe(false);
    expect(shouldAcknowledgeThreadView({ ...base, supported: false })).toBe(false);
    expect(shouldAcknowledgeThreadView({ ...base, completedAt: null })).toBe(false);
  });

  it("never acknowledges a malformed completion", () => {
    expect(shouldAcknowledgeThreadView({ ...base, completedAt: "not-a-date" })).toBe(false);
  });
});
