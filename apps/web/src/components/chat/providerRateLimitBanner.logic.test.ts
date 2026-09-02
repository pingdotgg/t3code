import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderRateLimitReset,
  resolveProviderRateLimitSuggestion,
} from "./providerRateLimitBanner.logic";

const NOW = Date.parse("2026-09-02T10:00:00.000Z");

function provider(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: instanceId,
    continuation: { groupKey: "claude:session-transcript" },
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-02T09:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const limitedWork = provider("claude_work", {
  rateLimit: {
    status: "rejected",
    resetsAt: "2026-09-02T12:00:00.000Z",
    observedAt: "2026-09-02T09:55:00.000Z",
  },
});

describe("resolveProviderRateLimitSuggestion", () => {
  it("suggests the sibling account when the thread's account is limited", () => {
    const suggestion = resolveProviderRateLimitSuggestion({
      providers: [limitedWork, provider("claude_personal")],
      instanceId: ProviderInstanceId.make("claude_work"),
      autoSwitchEnabled: false,
      nowMs: NOW,
    });
    expect(suggestion?.limited.instanceId).toBe("claude_work");
    expect(suggestion?.fallback?.instanceId).toBe("claude_personal");
    expect(suggestion?.key).toBe("claude_work:2026-09-02T12:00:00.000Z");
  });

  it("still surfaces the limit when no sibling can take over", () => {
    const suggestion = resolveProviderRateLimitSuggestion({
      providers: [limitedWork],
      instanceId: ProviderInstanceId.make("claude_work"),
      autoSwitchEnabled: false,
      nowMs: NOW,
    });
    expect(suggestion?.fallback).toBeNull();
  });

  it("stays quiet when auto-switch is on, nothing is limited, or the limit expired", () => {
    expect(
      resolveProviderRateLimitSuggestion({
        providers: [limitedWork, provider("claude_personal")],
        instanceId: ProviderInstanceId.make("claude_work"),
        autoSwitchEnabled: true,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      resolveProviderRateLimitSuggestion({
        providers: [provider("claude_work"), provider("claude_personal")],
        instanceId: ProviderInstanceId.make("claude_work"),
        autoSwitchEnabled: false,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      resolveProviderRateLimitSuggestion({
        providers: [limitedWork, provider("claude_personal")],
        instanceId: ProviderInstanceId.make("claude_work"),
        autoSwitchEnabled: false,
        nowMs: Date.parse("2026-09-02T12:00:01.000Z"),
      }),
    ).toBeNull();
  });
});

describe("formatProviderRateLimitReset", () => {
  it("formats same-day, next-day, and later resets", () => {
    const now = new Date(2026, 8, 2, 10, 0).getTime();
    const later = (hours: number) => new Date(now + hours * 60 * 60 * 1000).toISOString();
    expect(formatProviderRateLimitReset(later(2), now, "en-US")).toBe("resets at 12:00 PM");
    expect(formatProviderRateLimitReset(later(20), now, "en-US")).toMatch(
      /^resets tomorrow at 6:00 AM$/,
    );
    expect(formatProviderRateLimitReset(later(72), now, "en-US")).toMatch(
      /^resets .* at 10:00 AM$/,
    );
  });

  it("returns null without a usable reset time", () => {
    expect(formatProviderRateLimitReset(undefined, NOW)).toBeNull();
    expect(formatProviderRateLimitReset("not a date", NOW)).toBeNull();
  });
});
