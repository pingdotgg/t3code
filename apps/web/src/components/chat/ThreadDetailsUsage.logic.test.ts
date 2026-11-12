import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextPoolReset, poolSources, resolveThreadDetailsLimits } from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("claudeAgent");

function limitsAt(usedPercent: number, at = checkedAt): ServerProviderUsageLimits {
  return {
    checkedAt: at,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: "2026-10-30T13:17:00.000Z",
      },
    ],
  };
}

function limitsResettingAt(usedPercent: number, resetsAt: string): ServerProviderUsageLimits {
  const [window] = limitsAt(usedPercent).windows;
  return { checkedAt, windows: [{ ...window!, resetsAt }] };
}

const unsupported: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported" },
};

function claudeInstance(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "customEndpoint",
      label: "Custom API endpoint",
      endpoint: "http://127.0.0.1:8317",
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

function signedIn(id: string, email: string, usageLimits: ServerProviderUsageLimits) {
  const base = claudeInstance(usageLimits);
  return {
    ...base,
    instanceId: ProviderInstanceId.make(id),
    auth: { ...base.auth, email },
  } satisfies ServerProvider;
}

interface HubAccountInput {
  readonly id: string;
  readonly email?: string;
  readonly driver?: ProviderDriverKind;
  readonly models?: readonly string[];
  readonly workspaceId?: string;
  readonly lastServedAt?: string;
  readonly limits: ServerProviderUsageLimits;
}

function hub(
  label: string,
  accounts: readonly HubAccountInput[],
  error?: string,
  origin = "http://127.0.0.1:8317",
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make(label),
    kind: "cliproxy",
    label,
    origin,
    checkedAt,
    accounts: accounts.map((account) => ({
      id: account.id,
      driver: account.driver ?? claude,
      ...(account.email ? { email: account.email } : {}),
      ...(account.models ? { models: account.models } : {}),
      ...(account.workspaceId ? { workspaceId: account.workspaceId } : {}),
      ...(account.lastServedAt ? { lastServedAt: account.lastServedAt } : {}),
      usageLimits: account.limits,
    })),
    ...(error ? { error } : {}),
  };
}

function shown(
  own: ServerProviderUsageLimits,
  sources: readonly UsageLimitSourceSnapshot[],
  natives: readonly ServerProvider[] = [],
  model: string | null = null,
) {
  const resolved = resolveThreadDetailsLimits(
    instanceId,
    model,
    [claudeInstance(own), ...natives],
    sources,
    now,
  );
  if (resolved?.kind !== "pool") return resolved;
  return {
    kind: resolved.kind,
    rows: resolved.windows.map((window) => ({
      label: window.label,
      left: window.remainingPercent,
      accounts: window.members.length,
      from: poolSources(window),
    })),
  };
}

describe("resolveThreadDetailsLimits", () => {
  it("keeps an instance's failed reading instead of a hub it is not sent to", () => {
    const failed: ServerProviderUsageLimits = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const direct = { ...claudeInstance(failed), auth: { status: "authenticated" as const } };
    const elsewhere = claudeInstance(unsupported);
    const readableHub = hub("Hub", [{ id: "a.json", limits: limitsAt(20) }]);
    const otherHub = hub(
      "Other",
      [{ id: "a.json", limits: limitsAt(20) }],
      undefined,
      "http://hub",
    );
    expect(resolveThreadDetailsLimits(instanceId, null, [direct], [readableHub], now)).toEqual({
      kind: "instance",
      limits: failed,
    });
    expect(resolveThreadDetailsLimits(instanceId, null, [elsewhere], [otherHub], now)).toEqual({
      kind: "instance",
      limits: unsupported,
    });
  });

  it("keeps an instance's own readable limits over any hub", () => {
    const own = limitsAt(40);
    expect(shown(own, [hub("Hub", [{ id: "a.json", limits: limitsAt(90) }])])).toEqual({
      kind: "instance",
      limits: own,
    });
  });

  it.each([
    {
      name: "accounts across hubs, skipping a hub that failed to read",
      sources: [
        hub("Home", [{ id: "a.json", email: "a@example.com", limits: limitsAt(20) }]),
        hub("Work", [{ id: "b.json", email: "b@example.com", limits: limitsAt(40) }]),
        hub("Down", [], "The hub answered with HTTP 404."),
      ],
      rows: [{ label: "Session", left: 70, accounts: 2, from: ["Home", "Work"] }],
    },
    {
      name: "only this driver's readable accounts",
      sources: [
        hub("Hub", [
          { id: "a.json", email: "a@example.com", limits: limitsAt(50) },
          { id: "c.json", email: "c@example.com", driver: codex, limits: limitsAt(0) },
          { id: "d.json", email: "d@example.com", limits: unsupported },
        ]),
      ],
      rows: [{ label: "Session", left: 50, accounts: 1, from: ["Hub"] }],
    },
    {
      name: "a login signed in natively and on a hub, counted once at its freshest reading",
      sources: [hub("Hub", [{ id: "a.json", email: "a@example.com", limits: limitsAt(90) }])],
      natives: [signedIn("claude-a", "a@example.com", limitsAt(30, "2026-10-30T11:59:30.000Z"))],
      rows: [{ label: "Session", left: 70, accounts: 1, from: ["Signed-in accounts"] }],
    },
    {
      name: "only the accounts the hub routes the model to, even of another driver",
      sources: [
        hub("Hub", [
          { id: "a.json", models: ["claude-opus-5-5"], limits: limitsAt(10) },
          { id: "c.json", driver: codex, models: ["gpt-5.6-sol"], limits: limitsAt(30) },
        ]),
      ],
      model: "gpt-5.6-sol[1m]",
      rows: [{ label: "Session", left: 70, accounts: 1, from: ["Hub"] }],
    },
    {
      name: "only the account the hub served last",
      sources: [
        hub("Hub", [
          { id: "a.json", lastServedAt: "2026-10-30T11:50:00.000Z", limits: limitsAt(20) },
          { id: "b.json", lastServedAt: "2026-10-30T10:00:00.000Z", limits: limitsAt(60) },
          { id: "c.json", limits: limitsAt(0) },
        ]),
      ],
      rows: [{ label: "Session", left: 80, accounts: 1, from: ["Hub"] }],
    },
    {
      name: "every account the hub served in the same latest window",
      sources: [
        hub("Hub", [
          { id: "a.json", lastServedAt: "2026-10-30T11:50:00.000Z", limits: limitsAt(20) },
          { id: "b.json", lastServedAt: "2026-10-30T11:50:00.000Z", limits: limitsAt(60) },
        ]),
      ],
      rows: [{ label: "Session", left: 60, accounts: 2, from: ["Hub"] }],
    },
    {
      name: "a hub workspace without the same login's other workspace",
      sources: [
        hub("Hub", [
          { id: "c.json", email: "c@example.com", workspaceId: "w1", limits: limitsAt(100) },
        ]),
      ],
      natives: [
        {
          ...signedIn("claude-c", "c@example.com", limitsAt(0)),
          auth: { status: "authenticated", email: "c@example.com", workspaceId: "w2" },
        } satisfies ServerProvider,
      ],
      rows: [{ label: "Session", left: 0, accounts: 1, from: ["Hub"] }],
    },
  ])("pools $name when the instance reads no limits", ({ sources, natives, model, rows }) => {
    expect(shown(unsupported, sources, natives, model)).toEqual({ kind: "pool", rows });
  });

  it("names the next reset that refills quota, skipping an unused account's 0% reset", () => {
    const soon = "2026-10-30T12:10:00.000Z";
    const later = "2026-10-30T14:00:00.000Z";
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      null,
      [claudeInstance(unsupported)],
      [
        hub("Hub", [
          { id: "a.json", email: "a@example.com", limits: limitsResettingAt(0, soon) },
          { id: "b.json", email: "b@example.com", limits: limitsResettingAt(80, later) },
        ]),
      ],
      now,
    );
    if (resolved?.kind !== "pool") throw new Error("expected a pool");
    const [window] = resolved.windows;
    expect(window!.resets.map((reset) => reset.restoresPercent)).toEqual([0, 40]);
    expect(nextPoolReset(window!, now)).toMatchObject({
      at: Date.parse(later),
      restoresPercent: 40,
    });
  });

  it("keeps the instance's notice when no hub has a readable account for its driver", () => {
    const sources = [
      hub("Hub", [
        { id: "c.json", driver: codex, limits: limitsAt(10) },
        { id: "d.json", limits: unsupported },
      ]),
    ];
    const natives = [signedIn("claude-b", "b@example.com", limitsAt(60))];
    expect(shown(unsupported, sources, natives)).toEqual({
      kind: "instance",
      limits: unsupported,
    });
  });
});
