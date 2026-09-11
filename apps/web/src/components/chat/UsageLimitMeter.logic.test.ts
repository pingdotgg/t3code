import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatUsageLimitMeterLabel,
  resolveUsageLimitMeter,
  selectHeadlineUsageWindow,
} from "./UsageLimitMeter.logic";

const NOW = Date.parse("2026-03-23T12:00:00.000Z");

const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 42,
  resetsAt: "2026-03-23T14:10:00.000Z",
  windowDurationMins: 300,
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 91,
  resetsAt: "2026-03-26T15:00:00.000Z",
  windowDurationMins: 10_080,
} as const;

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude-agent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", type: "oauth", label: "Claude Max", email: "me@example.com" },
    models: [],
    slashCommands: [],
    usageLimits: { checkedAt: "2026-03-23T11:55:00.000Z", windows: [session, weekly] },
    ...overrides,
  } as ServerProvider;
}

describe("resolveUsageLimitMeter", () => {
  it("follows the selected instance and carries its plan", () => {
    const model = resolveUsageLimitMeter([provider()], ProviderInstanceId.make("claude-agent"));

    expect(model).toMatchObject({
      instanceId: "claude-agent",
      driver: "claudeAgent",
      displayName: "Claude",
      plan: "Claude Max",
    });
    expect(model?.limits.windows).toHaveLength(2);
  });

  it("returns null when the instance is unknown, disabled, or reports nothing to draw", () => {
    const providers = [provider()];
    expect(resolveUsageLimitMeter(providers, null)).toBeNull();
    expect(resolveUsageLimitMeter(providers, ProviderInstanceId.make("codex"))).toBeNull();
    expect(
      resolveUsageLimitMeter(
        [provider({ enabled: false })],
        ProviderInstanceId.make("claude-agent"),
      ),
    ).toBeNull();
    expect(
      resolveUsageLimitMeter(
        [provider({ usageLimits: { checkedAt: "2026-03-23T11:55:00.000Z", windows: [] } })],
        ProviderInstanceId.make("claude-agent"),
      ),
    ).toBeNull();
    expect(
      resolveUsageLimitMeter(
        [
          provider({
            usageLimits: {
              checkedAt: "2026-03-23T11:55:00.000Z",
              windows: [session],
              unavailable: { reason: "unsupported" },
            },
          }),
        ],
        ProviderInstanceId.make("claude-agent"),
      ),
    ).toBeNull();
  });
});

describe("selectHeadlineUsageWindow", () => {
  it("picks the window with the least quota left", () => {
    expect(selectHeadlineUsageWindow([session, weekly], NOW)?.id).toBe("seven_day");
  });

  it("ignores windows whose reset has already passed", () => {
    const stale = { ...weekly, resetsAt: "2026-03-23T11:00:00.000Z" };
    expect(selectHeadlineUsageWindow([session, stale], NOW)?.id).toBe("five_hour");
    expect(selectHeadlineUsageWindow([stale], NOW)).toBeNull();
  });
});

describe("formatUsageLimitMeterLabel", () => {
  it("names the headline window with quota left and the reset countdown", () => {
    const model = resolveUsageLimitMeter([provider()], ProviderInstanceId.make("claude-agent"));
    expect(formatUsageLimitMeterLabel(model!, NOW)).toBe("Weekly: 9% left, resets in 3d 3h");
  });

  it("falls back when every window has reset", () => {
    const model = resolveUsageLimitMeter(
      [
        provider({
          usageLimits: {
            checkedAt: "2026-03-23T11:55:00.000Z",
            windows: [{ ...session, resetsAt: "2026-03-23T11:00:00.000Z" }],
          },
        }),
      ],
      ProviderInstanceId.make("claude-agent"),
    );
    expect(formatUsageLimitMeterLabel(model!, NOW)).toBe("Usage limits");
  });
});
