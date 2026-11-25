import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { accountInitials, collectUsageRingGroups, MAX_USAGE_RINGS } from "./kaluwaUsageRings";

const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent });

const account = (key: string, windows: ServerProviderUsageWindow[]): LimitAccount => ({
  key,
  driver: "claudeAgent" as LimitAccount["driver"],
  displayName: null,
  email: `${key}@example.com`,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: { checkedAt: "2026-11-25T00:00:00.000Z", windows },
});

describe("collectUsageRingGroups", () => {
  it("gives each account its own group, shortest window outermost", () => {
    const groups = collectUsageRingGroups([
      account("work", [window("weekly-fable", "weekly", 40), window("five-hour", "session", 10)]),
      account("home", [window("weekly", "weekly", 75)]),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["work", "home"]);
    expect(groups[0]!.rings.map((ring) => ring.id)).toEqual(["five-hour", "weekly-fable"]);
  });

  it("keeps the order among windows of one kind", () => {
    const [group] = collectUsageRingGroups([
      account("work", [window("weekly", "weekly", 1), window("weekly-fable", "weekly", 2)]),
    ]);

    expect(group!.rings.map((ring) => ring.id)).toEqual(["weekly", "weekly-fable"]);
  });

  it("caps the rings but lists every limit", () => {
    const windows = ["a", "b", "c", "d"].map((id) => window(id, "other", 5));
    const [group] = collectUsageRingGroups([account("work", windows)]);

    expect(group!.rings).toHaveLength(MAX_USAGE_RINGS);
    expect(group!.windows).toHaveLength(4);
  });

  it("skips accounts with no limits", () => {
    expect(collectUsageRingGroups([account("work", [])])).toEqual([]);
  });
});

describe("accountInitials", () => {
  it("takes the first letters of the name and the domain", () => {
    expect(accountInitials("ada@example.com")).toBe("AE");
  });
});
