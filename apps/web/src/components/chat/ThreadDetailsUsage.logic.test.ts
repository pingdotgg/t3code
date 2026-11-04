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
    auth: { status: "authenticated", type: "customEndpoint", label: "Custom API endpoint" },
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
  readonly limits: ServerProviderUsageLimits;
}

function hub(
  label: string,
  accounts: readonly HubAccountInput[],
  error?: string,
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make(label),
    kind: "cliproxy",
    label,
    checkedAt,
    accounts: accounts.map((account) => ({
      id: account.id,
      driver: account.driver ?? claude,
      ...(account.email ? { email: account.email } : {}),
      usageLimits: account.limits,
    })),
    ...(error ? { error } : {}),
  };
}

/** What the card shows, reduced to the rows a user reads. */
function shown(
  own: ServerProviderUsageLimits,
  sources: readonly UsageLimitSourceSnapshot[],
  natives: readonly ServerProvider[] = [],
) {
  const resolved = resolveThreadDetailsLimits(
    instanceId,
    [claudeInstance(own), ...natives],
    sources,
    now,
  );
  if (resolved?.kind !== "hub") return resolved;
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
  it("shows nothing without a selected, known instance, or before its first reading", () => {
    expect(resolveThreadDetailsLimits(null, [claudeInstance(unsupported)], [], now)).toBeNull();
    expect(
      resolveThreadDetailsLimits(ProviderInstanceId.make("gone"), [], [hub("Hub", [])], now),
    ).toBeNull();
    const { usageLimits: _unread, ...unread } = claudeInstance(unsupported);
    const readableHub = hub("Hub", [{ id: "a.json", limits: limitsAt(20) }]);
    expect(resolveThreadDetailsLimits(instanceId, [unread], [readableHub], now)).toBeNull();
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
      name: "one hub account",
      sources: [hub("Hub", [{ id: "a.json", email: "a@example.com", limits: limitsAt(19) }])],
      rows: [{ label: "Session", left: 81, accounts: 1, from: ["Hub"] }],
    },
    {
      name: "several accounts, pooled like Usage → Limits",
      sources: [
        hub("Hub", [
          { id: "a.json", email: "a@example.com", limits: limitsAt(20) },
          { id: "b.json", email: "b@example.com", limits: limitsAt(60) },
        ]),
      ],
      rows: [{ label: "Session", left: 60, accounts: 2, from: ["Hub"] }],
    },
    {
      name: "one login reported by two hubs, counted once at its freshest reading",
      sources: [
        hub("Old", [{ id: "a.json", email: "a@example.com", limits: limitsAt(90) }]),
        hub("New", [
          {
            id: "a.json",
            email: "a@example.com",
            limits: limitsAt(30, "2026-10-30T11:59:30.000Z"),
          },
        ]),
      ],
      rows: [{ label: "Session", left: 70, accounts: 1, from: ["Old"] }],
    },
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
      name: "a signed-in account no hub holds, alongside the hub's",
      sources: [hub("Hub", [{ id: "a.json", email: "a@example.com", limits: limitsAt(20) }])],
      natives: [signedIn("claude-b", "b@example.com", limitsAt(60))],
      rows: [{ label: "Session", left: 60, accounts: 2, from: ["Hub", "Signed-in accounts"] }],
    },
  ])("pools $name when the instance reads no limits", ({ sources, natives, rows }) => {
    expect(shown(unsupported, sources, natives)).toEqual({ kind: "hub", rows });
  });

  it("names the next reset that refills quota, skipping an unused account's 0% reset", () => {
    const soon = "2026-10-30T12:10:00.000Z";
    const later = "2026-10-30T14:00:00.000Z";
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("Hub", [
          { id: "a.json", email: "a@example.com", limits: limitsResettingAt(0, soon) },
          { id: "b.json", email: "b@example.com", limits: limitsResettingAt(80, later) },
        ]),
      ],
      now,
    );
    if (resolved?.kind !== "hub") throw new Error("expected a hub pool");
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
