import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type AccountSwitchCandidate,
  exhaustedUsageWindow,
  isProviderOutOfUsage,
  selectAccountSwitchTarget,
} from "./providerAccountSwitching.ts";

const NOW = Date.parse("2026-09-02T10:00:00.000Z");

function candidate(
  instanceId: string,
  overrides: Partial<AccountSwitchCandidate> = {},
): AccountSwitchCandidate {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: "claude:session-transcript" },
    enabled: true,
    installed: true,
    status: "ready",
    ...overrides,
  };
}

function limits(
  windows: ReadonlyArray<{ id: string; usedPercent: number; resetsAt?: string }>,
): AccountSwitchCandidate["usageLimits"] {
  return {
    checkedAt: "2026-09-02T09:55:00.000Z",
    windows: windows.map((entry) => ({
      id: entry.id,
      kind: "session" as const,
      label: entry.id,
      usedPercent: entry.usedPercent,
      ...(entry.resetsAt !== undefined ? { resetsAt: entry.resetsAt } : {}),
    })),
  };
}

describe("exhaustedUsageWindow", () => {
  it("returns the spent window that reopens soonest", () => {
    const spent = exhaustedUsageWindow(
      {
        usageLimits: limits([
          { id: "seven_day", usedPercent: 100, resetsAt: "2026-09-05T10:00:00.000Z" },
          { id: "five_hour", usedPercent: 100, resetsAt: "2026-09-02T12:00:00.000Z" },
          { id: "opus", usedPercent: 40, resetsAt: "2026-09-02T11:00:00.000Z" },
        ]),
      },
      NOW,
    );
    expect(spent?.id).toBe("five_hour");
  });

  it("ignores windows with quota left or a reset already passed", () => {
    expect(
      exhaustedUsageWindow({ usageLimits: limits([{ id: "five_hour", usedPercent: 99 }]) }, NOW),
    ).toBeNull();
    expect(
      exhaustedUsageWindow(
        {
          usageLimits: limits([
            { id: "five_hour", usedPercent: 100, resetsAt: "2026-09-02T09:59:00.000Z" },
          ]),
        },
        NOW,
      ),
    ).toBeNull();
    expect(exhaustedUsageWindow({ usageLimits: undefined }, NOW)).toBeNull();
  });

  it("treats a spent window with no reset as still blocking", () => {
    expect(
      isProviderOutOfUsage({ usageLimits: limits([{ id: "five_hour", usedPercent: 100 }]) }, NOW),
    ).toBe(true);
  });
});

describe("selectAccountSwitchTarget", () => {
  const spentWork = candidate("claude_work", {
    usageLimits: limits([
      { id: "five_hour", usedPercent: 100, resetsAt: "2026-09-02T12:00:00.000Z" },
    ]),
  });

  it("prefers the sibling with the most headroom", () => {
    expect(
      selectAccountSwitchTarget({
        providers: [
          spentWork,
          candidate("claude_personal", {
            usageLimits: limits([{ id: "five_hour", usedPercent: 60 }]),
          }),
          candidate("claude_spare", {
            usageLimits: limits([{ id: "five_hour", usedPercent: 10 }]),
          }),
        ],
        instanceId: ProviderInstanceId.make("claude_work"),
        nowMs: NOW,
      })?.instanceId,
    ).toBe("claude_spare");
  });

  it("skips siblings that are spent, disabled, uninstalled, unavailable, broken, or from another group", () => {
    expect(
      selectAccountSwitchTarget({
        providers: [
          spentWork,
          candidate("claude_spent", {
            usageLimits: limits([
              { id: "five_hour", usedPercent: 100, resetsAt: "2026-09-02T13:00:00.000Z" },
            ]),
          }),
          candidate("claude_off", { enabled: false }),
          candidate("claude_no_cli", { installed: false }),
          candidate("claude_missing", { availability: "unavailable" }),
          candidate("claude_broken", { status: "error" }),
          candidate("codex_personal", { driver: ProviderDriverKind.make("codex") }),
          candidate("claude_other_home", { continuation: { groupKey: "claude:home:/other" } }),
        ],
        instanceId: ProviderInstanceId.make("claude_work"),
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("returns null without a continuation group or for an unknown instance", () => {
    expect(
      selectAccountSwitchTarget({
        providers: [
          candidate("claude_work", { continuation: undefined }),
          candidate("claude_personal", { continuation: undefined }),
        ],
        instanceId: ProviderInstanceId.make("claude_work"),
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      selectAccountSwitchTarget({
        providers: [spentWork],
        instanceId: ProviderInstanceId.make("nope"),
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});
