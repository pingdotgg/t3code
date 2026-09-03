import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectLimitSources,
  collectLimitsGroups,
  elapsedShare,
  formatResetsIn,
  limitsNotice,
  paceOf,
  providersWithLimits,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("pace", () => {
  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });

  it("has no pace without a reset or a duration", () => {
    expect(paceOf({ ...window, resetsAt: undefined }, now)).toBeNull();
    expect(paceOf({ ...window, windowDurationMins: undefined }, now)).toBeNull();
    expect(formatResetsIn({ ...window, resetsAt: undefined }, now)).toBeNull();
  });

  it("phrases the reset as a countdown", () => {
    expect(formatResetsIn(window, now)).toBe("resets in 2h 0m");
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-06T15:30:00.000Z" }, now)).toBe(
      "resets in 3d 3h",
    );
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-03T11:00:00.000Z" }, now)).toBe(
      "resets now",
    );
  });
});

describe("limitsNotice", () => {
  it("explains empty bars and passes provider messages through", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    expect(limitsNotice({ checkedAt, windows: [window] })).toBeNull();
    expect(limitsNotice({ checkedAt, windows: [] })).toBe("No limits reported.");
    expect(limitsNotice({ checkedAt, windows: [], unavailable: { reason: "unsupported" } })).toBe(
      "This account has no subscription limits.",
    );
    expect(
      limitsNotice({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex timed out." },
      }),
    ).toBe("Codex timed out.");
  });
});

describe("providersWithLimits", () => {
  it("keeps only usable providers whose driver reports limits at all", () => {
    const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
    const codex = provider({ usageLimits: limits });
    expect(
      providersWithLimits([
        codex,
        provider({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
        }),
        provider({
          instanceId: ProviderInstanceId.make("off"),
          enabled: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("gone"),
          installed: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("shadow"),
          availability: "unavailable",
          usageLimits: limits,
        }),
      ]),
    ).toEqual([codex]);
  });
});

describe("collectLimitsGroups", () => {
  it("labels environments only when more than one reports limits", () => {
    const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
    const codex = provider({ usageLimits: limits });
    const one = new Map([
      ["env-a", { entry: { target: { label: "Laptop" } }, serverConfig: { providers: [codex] } }],
      [
        "env-b",
        { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [provider({})] } },
      ],
    ] as const);
    expect(collectLimitsGroups(one as never).map((group) => group.environmentLabel)).toEqual([
      null,
    ]);

    const two = new Map([
      ["env-a", { entry: { target: { label: "Laptop" } }, serverConfig: { providers: [codex] } }],
      ["env-b", { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [codex] } }],
    ] as const);
    expect(collectLimitsGroups(two as never).map((group) => group.environmentLabel)).toEqual([
      "Laptop",
      "Desktop",
    ]);
  });
});

describe("collectLimitSources", () => {
  const source = {
    id: "cliproxy-hub" as never,
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt: "2026-09-03T11:00:00.000Z",
    accounts: [],
  };

  it("keys sources per environment and names the environment only when several have some", () => {
    const one = new Map([
      [
        "env-a",
        { entry: { target: { label: "Laptop" } }, serverConfig: { usageLimitSources: [source] } },
      ],
      [
        "env-b",
        { entry: { target: { label: "Desktop" } }, serverConfig: { usageLimitSources: [] } },
      ],
    ] as const);
    expect(collectLimitSources(one as never).map((entry) => [entry.key, entry.label])).toEqual([
      ["env-a:cliproxy-hub", "hub"],
    ]);

    const two = new Map([
      [
        "env-a",
        { entry: { target: { label: "Laptop" } }, serverConfig: { usageLimitSources: [source] } },
      ],
      [
        "env-b",
        { entry: { target: { label: "Desktop" } }, serverConfig: { usageLimitSources: [source] } },
      ],
    ] as const);
    expect(collectLimitSources(two as never).map((entry) => entry.label)).toEqual([
      "Laptop · hub",
      "Desktop · hub",
    ]);
  });
});
