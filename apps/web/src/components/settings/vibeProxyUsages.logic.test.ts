import type {
  VibeProxyQuotaWindow,
  VibeProxyUsageAccount,
  VibeProxyUsageResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeMissingConfiguration,
  formatQuotaPercent,
  formatQuotaReset,
  formatSnapshotAge,
  formatSuccessRate,
  groupVibeProxyAccounts,
  resolveVibeProxyUsageStage,
  vibeProxyAccountName,
  vibeProxyAccountStatus,
  vibeProxyAccountSubtitle,
  vibeProxyProviderKind,
  vibeProxyProviderLabel,
  vibeProxyQuotaSummary,
  vibeProxyQuotaWindowView,
  vibeProxyRecentActivity,
  vibeProxyRequestHealth,
} from "./vibeProxyUsages.logic";

function account(overrides: Partial<VibeProxyUsageAccount> = {}): VibeProxyUsageAccount {
  return {
    id: "acct-1",
    provider: "codex",
    account: null,
    label: null,
    email: null,
    accountType: null,
    planType: null,
    status: "active",
    statusMessage: null,
    disabled: false,
    unavailable: false,
    success: 0,
    failed: 0,
    recentRequests: [],
    quotaCapacity: null,
    ...overrides,
  };
}

function quotaWindow(overrides: Partial<VibeProxyQuotaWindow> = {}): VibeProxyQuotaWindow {
  return {
    id: "5h",
    label: "5 hour",
    usedPercent: 20,
    remainingPercent: 80,
    resetAt: null,
    known: true,
    hardExhausted: false,
    routing: false,
    ...overrides,
  };
}

describe("vibeProxyProviderKind", () => {
  it("maps the provider aliases Vibe-Proxy emits onto known brands", () => {
    expect(vibeProxyProviderKind("codex")).toBe("codex");
    expect(vibeProxyProviderKind("OpenAI")).toBe("codex");
    expect(vibeProxyProviderKind("chatgpt-oauth")).toBe("codex");
    expect(vibeProxyProviderKind("claude")).toBe("claude");
    expect(vibeProxyProviderKind("anthropic-api")).toBe("claude");
    expect(vibeProxyProviderKind("antigravity")).toBe("antigravity");
    expect(vibeProxyProviderKind("gemini-cli")).toBe("gemini");
    expect(vibeProxyProviderKind("google")).toBe("gemini");
    expect(vibeProxyProviderKind("grok")).toBe("grok");
    expect(vibeProxyProviderKind("xai-oauth")).toBe("grok");
  });

  it("prefers Antigravity over Gemini when both would match", () => {
    expect(vibeProxyProviderKind("google-antigravity")).toBe("antigravity");
  });

  it("falls back to unknown for unrecognised and empty providers", () => {
    expect(vibeProxyProviderKind("some-new-vendor")).toBe("unknown");
    expect(vibeProxyProviderKind("  ")).toBe("unknown");
  });
});

describe("vibeProxyProviderLabel", () => {
  it("uses brand names for known providers and title cases the rest", () => {
    expect(vibeProxyProviderLabel("openai")).toBe("Codex");
    expect(vibeProxyProviderLabel("some_new-vendor")).toBe("Some New Vendor");
    expect(vibeProxyProviderLabel("   ")).toBe("Unknown provider");
  });
});

describe("groupVibeProxyAccounts", () => {
  it("groups by provider and orders known brands ahead of unknown ones", () => {
    const groups = groupVibeProxyAccounts([
      account({ id: "a", provider: "mystery" }),
      account({ id: "b", provider: "claude" }),
      account({ id: "c", provider: "codex" }),
      account({ id: "d", provider: "Codex" }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["Codex", "Claude", "Mystery"]);
    expect(groups[0]!.accounts.map((entry) => entry.id)).toEqual(["c", "d"]);
  });
});

describe("vibeProxyAccountName", () => {
  it("falls through label, account, email and id", () => {
    expect(vibeProxyAccountName(account({ label: "Work" }))).toBe("Work");
    expect(vibeProxyAccountName(account({ account: "team@acme.dev" }))).toBe("team@acme.dev");
    expect(vibeProxyAccountName(account({ email: "me@acme.dev" }))).toBe("me@acme.dev");
    expect(vibeProxyAccountName(account({ id: "acct-9" }))).toBe("acct-9");
  });

  it("omits a subtitle that would repeat the name", () => {
    expect(vibeProxyAccountSubtitle(account({ label: "me@acme.dev", email: "me@acme.dev" }))).toBe(
      null,
    );
    expect(vibeProxyAccountSubtitle(account({ label: "Work", email: "me@acme.dev" }))).toBe(
      "me@acme.dev",
    );
  });
});

describe("vibeProxyAccountStatus", () => {
  it("prefers the explicit flags over the free-text status", () => {
    expect(vibeProxyAccountStatus(account({ disabled: true, status: "active" }))).toMatchObject({
      label: "Disabled",
      tone: "muted",
    });
    expect(vibeProxyAccountStatus(account({ unavailable: true, status: "active" }))).toMatchObject({
      label: "Unavailable",
      tone: "error",
    });
  });

  it("classifies free-text statuses", () => {
    expect(vibeProxyAccountStatus(account({ status: "healthy" })).tone).toBe("ok");
    expect(vibeProxyAccountStatus(account({ status: "unknown" })).tone).toBe("muted");
    expect(vibeProxyAccountStatus(account({ status: "auth_error" }))).toMatchObject({
      label: "Auth Error",
      tone: "error",
    });
    expect(vibeProxyAccountStatus(account({ status: "cooling down" })).tone).toBe("warning");
  });
});

describe("vibeProxyRequestHealth", () => {
  it("reports no rate when nothing has been sent", () => {
    expect(vibeProxyRequestHealth(account())).toMatchObject({
      total: 0,
      successRate: null,
      tone: "muted",
    });
  });

  it("tones by success rate", () => {
    expect(vibeProxyRequestHealth(account({ success: 99, failed: 1 })).tone).toBe("ok");
    expect(vibeProxyRequestHealth(account({ success: 90, failed: 10 })).tone).toBe("warning");
    expect(vibeProxyRequestHealth(account({ success: 5, failed: 5 })).tone).toBe("error");
  });
});

describe("vibeProxyRecentActivity", () => {
  it("keeps the newest buckets and scales by the busiest one", () => {
    const activity = vibeProxyRecentActivity(
      account({
        recentRequests: [
          { time: "10:00", success: 1, failed: 0 },
          { time: "10:01", success: 4, failed: 1 },
          { time: "10:02", success: 2, failed: 0 },
        ],
      }),
      2,
    );

    expect(activity.buckets.map((bucket) => bucket.time)).toEqual(["10:01", "10:02"]);
    expect(activity).toMatchObject({ success: 6, failed: 1, peak: 5 });
  });

  it("gives repeated bucket times distinct keys", () => {
    const activity = vibeProxyRecentActivity(
      account({
        recentRequests: [
          { time: "10:00", success: 1, failed: 0 },
          { time: "10:00", success: 2, failed: 0 },
        ],
      }),
    );

    expect(activity.buckets.map((bucket) => bucket.key)).toEqual(["10:00", "10:00#1"]);
  });

  it("never scales against a zero peak", () => {
    expect(vibeProxyRecentActivity(account()).peak).toBe(1);
  });
});

describe("vibeProxyQuotaWindowView", () => {
  it("derives the missing half of a partially reported window", () => {
    expect(vibeProxyQuotaWindowView(quotaWindow({ remainingPercent: Number.NaN }))).toMatchObject({
      remainingPercent: 80,
      usedPercent: 20,
    });
  });

  it("collapses an unknown window", () => {
    expect(vibeProxyQuotaWindowView(quotaWindow({ known: false }))).toMatchObject({
      state: "unknown",
      remainingFraction: null,
      remainingPercent: null,
    });
  });

  it("grades remaining capacity and honours the hard-exhausted flag", () => {
    expect(vibeProxyQuotaWindowView(quotaWindow({ remainingPercent: 60 })).state).toBe("ok");
    expect(vibeProxyQuotaWindowView(quotaWindow({ remainingPercent: 20 })).state).toBe("low");
    expect(vibeProxyQuotaWindowView(quotaWindow({ remainingPercent: 5 })).state).toBe("critical");
    expect(vibeProxyQuotaWindowView(quotaWindow({ remainingPercent: 0 })).state).toBe("exhausted");
    expect(
      vibeProxyQuotaWindowView(quotaWindow({ remainingPercent: 80, hardExhausted: true })).state,
    ).toBe("exhausted");
  });
});

describe("vibeProxyQuotaSummary", () => {
  it("separates unsupported providers from missing data", () => {
    expect(vibeProxyQuotaSummary(account()).kind).toBe("unavailable");
    expect(
      vibeProxyQuotaSummary(
        account({
          quotaCapacity: {
            provider: "codex",
            supported: false,
            fetchedAt: null,
            staleAt: null,
            lastAttemptAt: null,
            lastError: null,
            windows: [],
          },
        }),
      ).kind,
    ).toBe("unsupported");
  });

  it("surfaces the upstream error when a supported provider reported no windows", () => {
    expect(
      vibeProxyQuotaSummary(
        account({
          quotaCapacity: {
            provider: "codex",
            supported: true,
            fetchedAt: null,
            staleAt: null,
            lastAttemptAt: null,
            lastError: "Quota endpoint timed out.",
            windows: [],
          },
        }),
      ),
    ).toEqual({ kind: "unavailable", message: "Quota endpoint timed out." });
  });

  it("returns normalized windows when they exist", () => {
    const summary = vibeProxyQuotaSummary(
      account({
        quotaCapacity: {
          provider: "codex",
          supported: true,
          fetchedAt: null,
          staleAt: null,
          lastAttemptAt: null,
          lastError: null,
          windows: [quotaWindow(), quotaWindow({ id: "7d", label: "Weekly", known: false })],
        },
      }),
    );

    expect(summary.kind).toBe("windows");
    if (summary.kind !== "windows") return;
    expect(summary.windows.map((window) => window.state)).toEqual(["ok", "unknown"]);
  });
});

describe("formatting", () => {
  it("rounds quota percentages to whole numbers", () => {
    expect(formatQuotaPercent(82.4)).toBe("82%");
    expect(formatQuotaPercent(120)).toBe("100%");
    expect(formatQuotaPercent(-4)).toBe("0%");
  });

  it("formats success rates with at most one decimal", () => {
    expect(formatSuccessRate(null)).toBe("no requests");
    expect(formatSuccessRate(1)).toBe("100%");
    expect(formatSuccessRate(0.994)).toBe("99.4%");
    expect(formatSuccessRate(0.5)).toBe("50%");
  });

  it("counts down to a quota reset", () => {
    const nowMs = Date.parse("2026-08-19T12:00:00Z");
    expect(formatQuotaReset(null, nowMs)).toBe(null);
    expect(formatQuotaReset("not-a-date", nowMs)).toBe(null);
    expect(formatQuotaReset("2026-08-19T11:00:00Z", nowMs)).toBe("Reset due");
    expect(formatQuotaReset("2026-08-19T12:00:30Z", nowMs)).toBe("Resets in under a minute");
    expect(formatQuotaReset("2026-08-19T12:45:00Z", nowMs)).toBe("Resets in 45m");
    expect(formatQuotaReset("2026-08-19T14:30:00Z", nowMs)).toBe("Resets in 2h 30m");
    expect(formatQuotaReset("2026-08-19T15:00:00Z", nowMs)).toBe("Resets in 3h");
    expect(formatQuotaReset("2026-08-22T18:00:00Z", nowMs)).toBe("Resets in 3d 6h");
  });

  it("ages a snapshot", () => {
    const nowMs = Date.parse("2026-08-19T12:00:00Z");
    expect(formatSnapshotAge("2026-08-19T11:59:30Z", nowMs)).toBe("Updated just now");
    expect(formatSnapshotAge("2026-08-19T11:30:00Z", nowMs)).toBe("Updated 30m ago");
    expect(formatSnapshotAge("2026-08-19T08:00:00Z", nowMs)).toBe("Updated 4h ago");
    expect(formatSnapshotAge("2026-08-17T12:00:00Z", nowMs)).toBe("Updated 2d ago");
    expect(formatSnapshotAge("nonsense", nowMs)).toBe(null);
  });

  it("names the missing configuration fields", () => {
    expect(describeMissingConfiguration(["baseUrl", "apiKey"])).toBe(
      "Add a base URL and an API key to load usage.",
    );
    expect(describeMissingConfiguration(["baseUrl"])).toBe("Add a base URL to load usage.");
    expect(describeMissingConfiguration(["apiKey"])).toBe("Add an API key to load usage.");
  });
});

describe("resolveVibeProxyUsageStage", () => {
  const settings = {
    enabled: true,
    baseUrl: "https://proxy.example.com",
    apiKey: "",
    apiKeyRedacted: true,
  };
  const snapshotResult: VibeProxyUsageResult = {
    status: "ready",
    snapshot: { fetchedAt: "2026-08-19T12:00:00Z", accounts: [account()] },
    refreshed: true,
    refreshProblem: null,
  };

  it("reports disabled before anything else", () => {
    expect(
      resolveVibeProxyUsageStage({
        settings: { ...settings, enabled: false },
        result: snapshotResult,
        isRefreshing: true,
        transportError: "boom",
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("treats a redacted stored key as configured", () => {
    expect(
      resolveVibeProxyUsageStage({
        settings,
        result: null,
        isRefreshing: true,
        transportError: null,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("names each missing field", () => {
    expect(
      resolveVibeProxyUsageStage({
        settings: { enabled: true, baseUrl: "  ", apiKey: "", apiKeyRedacted: false },
        result: null,
        isRefreshing: false,
        transportError: null,
      }),
    ).toEqual({ kind: "unconfigured", missing: ["baseUrl", "apiKey"] });
  });

  it("marks a fresh snapshot as current", () => {
    const stage = resolveVibeProxyUsageStage({
      settings,
      result: snapshotResult,
      isRefreshing: false,
      transportError: null,
    });
    expect(stage).toMatchObject({ kind: "accounts", stale: false, problem: null });
  });

  it("keeps a cached snapshot visible and stale while refreshing", () => {
    const stage = resolveVibeProxyUsageStage({
      settings,
      result: { ...snapshotResult, refreshed: false },
      isRefreshing: true,
      transportError: null,
    });
    expect(stage).toMatchObject({ kind: "accounts", stale: true, problem: null });
  });

  it("keeps stale data visible when the refresh failed upstream", () => {
    const stage = resolveVibeProxyUsageStage({
      settings,
      result: {
        ...snapshotResult,
        refreshed: false,
        refreshProblem: { reason: "unauthorized", message: "Vibe-Proxy rejected the key." },
      },
      isRefreshing: false,
      transportError: null,
    });
    expect(stage).toMatchObject({
      kind: "accounts",
      stale: true,
      problem: "Vibe-Proxy rejected the key.",
    });
  });

  it("prefers a transport failure over an upstream problem", () => {
    const stage = resolveVibeProxyUsageStage({
      settings,
      result: {
        ...snapshotResult,
        refreshProblem: { reason: "unreachable", message: "upstream" },
      },
      isRefreshing: false,
      transportError: "Could not reach this environment.",
    });
    expect(stage).toMatchObject({ problem: "Could not reach this environment." });
  });

  it("falls back to empty once a failed first fetch settles", () => {
    expect(
      resolveVibeProxyUsageStage({
        settings,
        result: {
          status: "ready",
          snapshot: null,
          refreshed: false,
          refreshProblem: { reason: "unreachable", message: "Vibe-Proxy is unreachable." },
        },
        isRefreshing: false,
        transportError: null,
      }),
    ).toEqual({ kind: "empty", problem: "Vibe-Proxy is unreachable." });
  });
});
