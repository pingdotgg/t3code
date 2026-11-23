import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyAntigravityWindowVendors,
  classifyModelVendor,
  collectVendorQuotas,
} from "./modelVendorQuota.ts";

function makeProvider(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "driver" | "instanceId">,
): ServerProvider {
  return {
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-23T02:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function makeWindow(
  overrides: Partial<ServerProviderUsageWindow> & Pick<ServerProviderUsageWindow, "id" | "label">,
): ServerProviderUsageWindow {
  return {
    kind: "other",
    usedPercent: 25,
    ...overrides,
  };
}

describe("classifyModelVendor", () => {
  it("classifies Claude, GPT, and Gemini models across native and Antigravity slugs", () => {
    expect(
      classifyModelVendor({
        slug: "claude-opus-4-6",
        driverKind: ProviderDriverKind.make("antigravity"),
      }),
    ).toBe("claude");
    expect(
      classifyModelVendor({
        slug: "ag/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        driverKind: ProviderDriverKind.make("antigravity"),
      }),
    ).toBe("claude");
    expect(
      classifyModelVendor({ slug: "opus", driverKind: ProviderDriverKind.make("claudeAgent") }),
    ).toBe("claude");
    expect(
      classifyModelVendor({ slug: "gpt-5.4", driverKind: ProviderDriverKind.make("codex") }),
    ).toBe("gpt");
    expect(
      classifyModelVendor({
        slug: "gpt-oss-120b",
        driverKind: ProviderDriverKind.make("antigravity"),
      }),
    ).toBe("gpt");
    expect(
      classifyModelVendor({ slug: "o3-mini", driverKind: ProviderDriverKind.make("codex") }),
    ).toBe("gpt");
    expect(
      classifyModelVendor({
        slug: "gemini-3.1-pro",
        driverKind: ProviderDriverKind.make("antigravity"),
      }),
    ).toBe("gemini");
    expect(
      classifyModelVendor({
        slug: "gemini-argon-pro",
        driverKind: ProviderDriverKind.make("antigravity"),
      }),
    ).toBe("gemini");
  });
});

describe("classifyAntigravityWindowVendors", () => {
  it("maps 3p shared windows to both claude and gpt, and gemini windows to gemini", () => {
    expect(
      classifyAntigravityWindowVendors(
        makeWindow({ id: "3p-5h", label: "Claude & GPT (shared) · 5-hour" }),
      ),
    ).toEqual(["claude", "gpt"]);
    expect(
      classifyAntigravityWindowVendors(
        makeWindow({ id: "gemini-weekly", label: "Gemini · Weekly" }),
      ),
    ).toEqual(["gemini"]);
    expect(
      classifyAntigravityWindowVendors(
        makeWindow({ id: "claude-quota", label: "Claude · Reported quota" }),
      ),
    ).toEqual(["claude"]);
  });
});

describe("collectVendorQuotas", () => {
  it("maps Antigravity 3p/Opus quota under Claude when native Claude is absent", () => {
    const now = Date.parse("2026-11-23T02:00:00.000Z");
    const codex = makeProvider({
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
      displayName: "Codex",
      usageLimits: {
        checkedAt: "2026-11-23T01:59:00.000Z",
        windows: [
          makeWindow({
            id: "primary",
            label: "5-hour",
            kind: "session",
            usedPercent: 30,
            windowDurationMins: 300,
            resetsAt: "2026-11-23T05:00:00.000Z",
          }),
        ],
      },
    });
    const antigravity = makeProvider({
      driver: ProviderDriverKind.make("antigravity"),
      instanceId: ProviderInstanceId.make("antigravity"),
      displayName: "Antigravity",
      usageLimits: {
        checkedAt: "2026-11-23T01:59:30.000Z",
        windows: [
          makeWindow({
            id: "gemini-5h",
            label: "Gemini · 5-hour",
            kind: "session",
            usedPercent: 15,
            windowDurationMins: 300,
            resetsAt: "2026-11-23T06:00:00.000Z",
          }),
          makeWindow({
            id: "3p-5h",
            label: "Claude & GPT (shared) · 5-hour",
            kind: "session",
            usedPercent: 56,
            windowDurationMins: 300,
            resetsAt: "2026-11-23T04:30:00.000Z",
          }),
          makeWindow({
            id: "3p-weekly",
            label: "Claude & GPT (shared) · Weekly",
            kind: "weekly",
            usedPercent: 20,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: "2026-11-28T00:00:00.000Z",
          }),
        ],
      },
    });

    const quotas = collectVendorQuotas({ providers: [codex, antigravity], now });

    expect(quotas.claude.viaAntigravityOnly).toBe(true);
    expect(quotas.claude.windows.map((item) => item.window.id)).toEqual(["3p-5h", "3p-weekly"]);
    expect(quotas.claude.windows[0]?.usedPercent).toBe(56);
    expect(quotas.claude.windows[0]?.remainingPercent).toBe(44);
    expect(quotas.claude.windows[0]?.sharedPool).toBe(true);
    expect(quotas.claude.minRemainingPercent).toBe(44);

    expect(quotas.gpt.viaAntigravityOnly).toBe(false);
    // Native Codex window sorts ahead of Antigravity shared 3p windows.
    expect(quotas.gpt.windows[0]?.sourceDriver).toBe("codex");
    expect(quotas.gpt.windows[0]?.remainingPercent).toBe(70);

    expect(quotas.gemini.windows.map((item) => item.window.id)).toEqual(["gemini-5h"]);
    expect(quotas.gemini.windows[0]?.remainingPercent).toBe(85);
  });
});
