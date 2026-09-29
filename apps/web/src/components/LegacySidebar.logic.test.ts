import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  legacySidebarThreadMatchesFilters,
  type LegacySidebarFilterableThread,
} from "./LegacySidebar.logic";

const NOW = "2026-09-24T12:00:00.000Z";

function thread(
  overrides: Partial<LegacySidebarFilterableThread> = {},
): LegacySidebarFilterableThread {
  return {
    archivedAt: null,
    environmentId: EnvironmentId.make("environment-a"),
    settledOverride: null,
    snoozedAt: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    ...overrides,
  };
}

describe("legacySidebarThreadMatchesFilters", () => {
  it("includes threads from any selected environment", () => {
    expect(
      legacySidebarThreadMatchesFilters(thread(), {
        environmentIds: ["environment-a", "environment-b"],
        status: "all",
        now: NOW,
      }),
    ).toBe(true);
  });
  it("filters archived threads and threads from other environments", () => {
    expect(
      legacySidebarThreadMatchesFilters(thread({ archivedAt: NOW }), {
        environmentIds: [],
        status: "all",
        now: NOW,
      }),
    ).toBe(false);
    expect(
      legacySidebarThreadMatchesFilters(thread(), {
        environmentIds: ["environment-b"],
        status: "all",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("classifies snooze ahead of settlement and otherwise exposes active threads", () => {
    const snoozed = thread({
      settledOverride: "settled",
      snoozedUntil: "2026-09-24T13:00:00.000Z",
    });
    expect(
      legacySidebarThreadMatchesFilters(snoozed, {
        environmentIds: [],
        status: "snoozed",
        now: NOW,
      }),
    ).toBe(true);
    expect(
      legacySidebarThreadMatchesFilters(snoozed, {
        environmentIds: [],
        status: "settled",
        now: NOW,
      }),
    ).toBe(false);
    expect(
      legacySidebarThreadMatchesFilters(thread(), {
        environmentIds: [],
        status: "active",
        now: NOW,
      }),
    ).toBe(true);
  });
});
