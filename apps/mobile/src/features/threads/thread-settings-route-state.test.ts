import { describe, expect, it } from "vite-plus/test";

import {
  forkThreadIdForSelection,
  refreshThreadSettingsRouteSession,
} from "./thread-settings-route-state";

describe("refreshThreadSettingsRouteSession", () => {
  it("does not replace an active fork picker with reactive source-thread settings", () => {
    const fork = { ownerId: "environment:source", purpose: "fork" as const, revision: 1 };
    const settings = { ownerId: "environment:source", purpose: "settings" as const, revision: 2 };

    expect(refreshThreadSettingsRouteSession(fork, settings)).toBe(fork);
  });

  it("refreshes ordinary settings and sessions owned by another thread", () => {
    const settings = { ownerId: "environment:source", purpose: "settings" as const, revision: 1 };
    const refreshed = { ...settings, revision: 2 };
    const other = { ownerId: "environment:other", purpose: "settings" as const, revision: 3 };

    expect(refreshThreadSettingsRouteSession(settings, refreshed)).toBe(refreshed);
    expect(refreshThreadSettingsRouteSession(settings, other)).toBe(other);
  });
});

describe("forkThreadIdForSelection", () => {
  it("keeps the target id for retries and replaces it after any selection change", () => {
    const createThreadId = () => "replacement";
    const medium = JSON.stringify({
      instanceId: "codex",
      model: "gpt",
      options: [{ id: "effort", value: "medium" }],
    });
    const high = JSON.stringify({
      instanceId: "codex",
      model: "gpt",
      options: [{ id: "effort", value: "high" }],
    });

    expect(
      forkThreadIdForSelection({
        threadId: "original",
        attemptedSelectionKey: null,
        nextSelectionKey: medium,
        createThreadId,
      }),
    ).toBe("original");
    expect(
      forkThreadIdForSelection({
        threadId: "original",
        attemptedSelectionKey: medium,
        nextSelectionKey: medium,
        createThreadId,
      }),
    ).toBe("original");
    expect(
      forkThreadIdForSelection({
        threadId: "original",
        attemptedSelectionKey: medium,
        nextSelectionKey: high,
        createThreadId,
      }),
    ).toBe("replacement");
  });
});
