import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { headlineUsageUsedPercent, resolveComposerUsageMeter } from "./ComposerUsageMeter.logic";

function usageLimits(windows: ServerProviderUsageLimits["windows"]): ServerProviderUsageLimits {
  return {
    checkedAt: "2026-08-16T00:00:00.000Z",
    windows,
  };
}

function provider(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "driver">,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    enabled: true,
    installed: true,
    availability: "available",
    auth: { status: "authenticated" },
    models: [],
    ...overrides,
  } as ServerProvider;
}

describe("headlineUsageUsedPercent", () => {
  it("uses the most constrained window so the ring tracks the tighter limit", () => {
    expect(
      headlineUsageUsedPercent([
        { id: "primary", kind: "session", label: "Session", usedPercent: 35 },
        { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 82 },
      ]),
    ).toBe(82);
  });
});

describe("resolveComposerUsageMeter", () => {
  const codex = provider({
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    usageLimits: usageLimits([
      { id: "primary", kind: "session", label: "Session", usedPercent: 20 },
      { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 55 },
    ]),
  });
  const claude = provider({
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    displayName: "Claude Code",
    usageLimits: usageLimits([
      { id: "primary", kind: "session", label: "Session", usedPercent: 90 },
    ]),
  });

  it("stays hidden until the setting is on", () => {
    expect(
      resolveComposerUsageMeter({ enabled: false, hasStartedTurn: true, provider: codex }),
    ).toBeNull();
  });

  it("stays hidden until the thread has started a turn", () => {
    expect(
      resolveComposerUsageMeter({ enabled: true, hasStartedTurn: false, provider: codex }),
    ).toBeNull();
  });

  it("shows only the current provider's windows", () => {
    expect(
      resolveComposerUsageMeter({ enabled: true, hasStartedTurn: true, provider: codex }),
    ).toEqual({
      providerLabel: "Codex",
      usageLimits: codex.usageLimits,
      usedPercent: 55,
    });
    expect(
      resolveComposerUsageMeter({ enabled: true, hasStartedTurn: true, provider: claude })
        ?.providerLabel,
    ).toBe("Claude Code");
    expect(
      resolveComposerUsageMeter({ enabled: true, hasStartedTurn: true, provider: claude })
        ?.usedPercent,
    ).toBe(90);
  });

  it("hides when the current provider has no usable quota snapshot", () => {
    expect(
      resolveComposerUsageMeter({ enabled: true, hasStartedTurn: true, provider: undefined }),
    ).toBeNull();
    expect(
      resolveComposerUsageMeter({
        enabled: true,
        hasStartedTurn: true,
        provider: provider({ driver: ProviderDriverKind.make("codex"), usageLimits: undefined }),
      }),
    ).toBeNull();
    expect(
      resolveComposerUsageMeter({
        enabled: true,
        hasStartedTurn: true,
        provider: provider({
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          usageLimits: usageLimits([
            { id: "primary", kind: "session", label: "Session", usedPercent: 10 },
          ]),
        }),
      }),
    ).toBeNull();
    expect(
      resolveComposerUsageMeter({
        enabled: true,
        hasStartedTurn: true,
        provider: provider({
          driver: ProviderDriverKind.make("grok"),
          auth: { status: "authenticated", label: "Free", type: "Free" },
          usageLimits: {
            checkedAt: "2026-08-16T00:00:00.000Z",
            windows: [],
            unavailable: {
              reason: "unsupported",
              message: "Usage is only shown for paid tiers",
            },
          },
        }),
      }),
    ).toBeNull();
  });
});
