import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeExhaustedWindow,
  resolveAccountSwitchSuggestion,
} from "./providerAccountSwitchBanner.logic";

const NOW = Date.parse("2026-09-02T10:00:00.000Z");

function usageLimits(usedPercent: number, resetsAt?: string): ServerProvider["usageLimits"] {
  return {
    checkedAt: "2026-09-02T09:55:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour",
        usedPercent,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      },
    ],
  };
}

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

const spentWork = provider("claude_work", {
  usageLimits: usageLimits(100, "2026-09-02T12:00:00.000Z"),
});

describe("resolveAccountSwitchSuggestion", () => {
  it("names the spent window and the account that can take over", () => {
    const suggestion = resolveAccountSwitchSuggestion({
      providers: [spentWork, provider("claude_personal", { usageLimits: usageLimits(10) })],
      instanceId: ProviderInstanceId.make("claude_work"),
      autoSwitchEnabled: false,
      nowMs: NOW,
    });
    expect(suggestion?.limited.instanceId).toBe("claude_work");
    expect(suggestion?.window.id).toBe("five_hour");
    expect(suggestion?.target?.instanceId).toBe("claude_personal");
    expect(suggestion?.key).toBe("claude_work:five_hour:2026-09-02T12:00:00.000Z");
  });

  it("still surfaces the limit when no sibling can take over", () => {
    expect(
      resolveAccountSwitchSuggestion({
        providers: [spentWork],
        instanceId: ProviderInstanceId.make("claude_work"),
        autoSwitchEnabled: false,
        nowMs: NOW,
      })?.target,
    ).toBeNull();
  });

  it("keys an unknown reset stably across snapshots", () => {
    const key = (checkedAt: string) =>
      resolveAccountSwitchSuggestion({
        providers: [
          provider("claude_work", {
            usageLimits: { checkedAt, windows: usageLimits(100)!.windows },
          }),
        ],
        instanceId: ProviderInstanceId.make("claude_work"),
        autoSwitchEnabled: false,
        nowMs: NOW,
      })?.key;
    expect(key("2026-09-02T09:55:00.000Z")).toBe(key("2026-09-02T09:59:00.000Z"));
  });

  it("stays quiet when auto-switch is on, quota remains, or the window reset", () => {
    expect(
      resolveAccountSwitchSuggestion({
        providers: [spentWork],
        instanceId: ProviderInstanceId.make("claude_work"),
        autoSwitchEnabled: true,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      resolveAccountSwitchSuggestion({
        providers: [provider("claude_work", { usageLimits: usageLimits(80) })],
        instanceId: ProviderInstanceId.make("claude_work"),
        autoSwitchEnabled: false,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      resolveAccountSwitchSuggestion({
        providers: [spentWork],
        instanceId: ProviderInstanceId.make("claude_work"),
        autoSwitchEnabled: false,
        nowMs: Date.parse("2026-09-02T12:00:01.000Z"),
      }),
    ).toBeNull();
  });
});

describe("describeExhaustedWindow", () => {
  it("phrases the reset the way the limits view does", () => {
    expect(
      describeExhaustedWindow(usageLimits(100, "2026-09-02T12:13:00.000Z")!.windows[0]!, NOW),
    ).toBe("Its 5-hour limit resets in 2h 13m.");
  });

  it("falls back when the provider named no reset", () => {
    expect(describeExhaustedWindow(usageLimits(100)!.windows[0]!, NOW)).toBe(
      "Its 5-hour limit is used up.",
    );
  });
});
