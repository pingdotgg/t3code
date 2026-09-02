import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isProviderRateLimitActive,
  selectRateLimitFallbackProvider,
  type RateLimitFallbackCandidate,
} from "./providerRateLimits.ts";

const NOW = Date.parse("2026-09-02T10:00:00.000Z");

function candidate(
  instanceId: string,
  overrides: Partial<RateLimitFallbackCandidate> = {},
): RateLimitFallbackCandidate {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: "claude:session-transcript" },
    enabled: true,
    status: "ready",
    ...overrides,
  };
}

describe("isProviderRateLimitActive", () => {
  it("is active while rejected and the reset is ahead", () => {
    expect(
      isProviderRateLimitActive(
        { status: "rejected", resetsAt: "2026-09-02T11:00:00.000Z", observedAt: "x" },
        NOW,
      ),
    ).toBe(true);
  });

  it("expires once the reset time passes", () => {
    expect(
      isProviderRateLimitActive(
        { status: "rejected", resetsAt: "2026-09-02T09:59:00.000Z", observedAt: "x" },
        NOW,
      ),
    ).toBe(false);
  });

  it("treats a rejection without a reset time as active", () => {
    expect(isProviderRateLimitActive({ status: "rejected", observedAt: "x" }, NOW)).toBe(true);
  });

  it("ignores warnings and missing state", () => {
    expect(isProviderRateLimitActive({ status: "warning", observedAt: "x" }, NOW)).toBe(false);
    expect(isProviderRateLimitActive(undefined, NOW)).toBe(false);
  });
});

describe("selectRateLimitFallbackProvider", () => {
  it("prefers the sibling with the most headroom", () => {
    const providers = [
      candidate("claude_work", {
        rateLimit: { status: "rejected", resetsAt: "2026-09-02T11:00:00.000Z", observedAt: "x" },
      }),
      candidate("claude_personal", {
        rateLimit: { status: "allowed", utilization: 60, observedAt: "x" },
      }),
      candidate("claude_spare", {
        rateLimit: { status: "allowed", utilization: 10, observedAt: "x" },
      }),
    ];
    expect(
      selectRateLimitFallbackProvider({
        providers,
        instanceId: ProviderInstanceId.make("claude_work"),
        nowMs: NOW,
      })?.instanceId,
    ).toBe("claude_spare");
  });

  it("skips siblings that are limited, disabled, unavailable, or from another group", () => {
    const providers = [
      candidate("claude_work"),
      candidate("claude_limited", {
        rateLimit: { status: "rejected", resetsAt: "2026-09-02T11:00:00.000Z", observedAt: "x" },
      }),
      candidate("claude_off", { enabled: false }),
      candidate("claude_missing", { availability: "unavailable" }),
      candidate("claude_broken", { status: "error" }),
      candidate("codex_personal", { driver: ProviderDriverKind.make("codex") }),
      candidate("claude_other_home", { continuation: { groupKey: "claude:home:/other" } }),
    ];
    expect(
      selectRateLimitFallbackProvider({
        providers,
        instanceId: ProviderInstanceId.make("claude_work"),
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("returns null for an unknown instance", () => {
    expect(
      selectRateLimitFallbackProvider({
        providers: [candidate("claude_work")],
        instanceId: ProviderInstanceId.make("nope"),
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});
