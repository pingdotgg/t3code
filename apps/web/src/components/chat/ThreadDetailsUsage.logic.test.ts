import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadDetailsLimits } from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const codexId = ProviderInstanceId.make("codex");

const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 19,
  windowDurationMins: 300,
  resetsAt: "2026-10-30T13:17:00.000Z",
} as const;

const unsupported: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported" },
};

const probeFailed: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "probeFailed" },
};

function limitsAt(usedPercent: number): ServerProviderUsageLimits {
  return { checkedAt, windows: [{ ...session, usedPercent }] };
}

function claudeInstance(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", type: "apiKey", label: "Claude API Key" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

function codexInstance(usageLimits: ServerProviderUsageLimits, email?: string): ServerProvider {
  const base = claudeInstance(usageLimits);
  return {
    ...base,
    instanceId: codexId,
    driver: codex,
    auth: email ? { ...base.auth, email } : base.auth,
  };
}

function hub(
  label: string,
  accounts: ReadonlyArray<{
    id: string;
    email?: string;
    workspaceId?: string;
    driver?: ProviderDriverKind;
    limits: ServerProviderUsageLimits;
  }>,
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
      ...(account.workspaceId ? { workspaceId: account.workspaceId } : {}),
      usageLimits: account.limits,
    })),
  };
}

describe("thread details limits", () => {
  it("shows the hub's account for a proxied instance that reads no limits of its own", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [hub("CLIProxy (homebox)", [{ id: "claude-a.json", limits: limitsAt(19) }])],
      now,
    );

    expect(resolved).toEqual({ limits: limitsAt(19), sourceLabel: "CLIProxy (homebox)" });
  });

  it("keeps the instance's own notice when several hub accounts could serve the thread", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("hub", [
          { id: "claude-a.json", limits: limitsAt(19) },
          { id: "claude-b.json", limits: limitsAt(60) },
        ]),
      ],
      now,
    );

    expect(resolved).toEqual({ limits: unsupported, sourceLabel: null });
  });

  it("counts accounts across hubs, so one account on each of two hubs stays ambiguous", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("hub-a", [{ id: "claude-a.json", limits: limitsAt(19) }]),
        hub("hub-b", [{ id: "claude-b.json", limits: limitsAt(60) }]),
      ],
      now,
    );

    expect(resolved?.sourceLabel).toBeNull();
  });

  it("counts one login reported by two hubs once, and shows its freshest snapshot", () => {
    const stale = { ...limitsAt(19), checkedAt: "2026-10-30T11:00:00.000Z" };
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("hub-a", [{ id: "claude-a.json", email: "Me@Example.com", limits: stale }]),
        hub("hub-b", [{ id: "claude-b.json", email: "me@example.com", limits: limitsAt(25) }]),
      ],
      now,
    );

    expect(resolved).toEqual({ limits: limitsAt(25), sourceLabel: "hub-b" });
  });

  it("keeps the instance's notice when one login is reported in two workspaces", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("hub", [
          {
            id: "claude-a.json",
            email: "me@example.com",
            workspaceId: "team-a",
            limits: limitsAt(19),
          },
          {
            id: "claude-b.json",
            email: "me@example.com",
            workspaceId: "team-b",
            limits: limitsAt(25),
          },
        ]),
      ],
      now,
    );

    expect(resolved).toEqual({ limits: unsupported, sourceLabel: null });
  });

  it("counts one login as one account when a hub omits the workspace another reports", () => {
    const fresher = { ...limitsAt(25), checkedAt: "2026-10-30T11:59:30.000Z" };
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("hub-a", [
          {
            id: "claude-a.json",
            email: "me@example.com",
            workspaceId: "team-a",
            limits: limitsAt(19),
          },
        ]),
        hub("hub-b", [{ id: "claude-b.json", email: "me@example.com", limits: fresher }]),
      ],
      now,
    );

    expect(resolved).toEqual({ limits: fresher, sourceLabel: "hub-b" });
  });

  it("falls back to the one hub account when a Codex instance's own probe failed", () => {
    const resolved = resolveThreadDetailsLimits(
      codexId,
      [codexInstance(probeFailed)],
      [hub("hub", [{ id: "codex-a.json", driver: codex, limits: limitsAt(30) }])],
      now,
    );

    expect(resolved).toEqual({ limits: limitsAt(30), sourceLabel: "hub" });
  });

  it("does not borrow a hub account that belongs to a different login", () => {
    const hubFor = (email: string) => [
      hub("hub", [{ id: "codex-a.json", driver: codex, email, limits: limitsAt(30) }]),
    ];

    expect(
      resolveThreadDetailsLimits(
        codexId,
        [codexInstance(probeFailed, "alice@example.com")],
        hubFor("bob@example.com"),
        now,
      ),
    ).toEqual({ limits: probeFailed, sourceLabel: null });
    expect(
      resolveThreadDetailsLimits(
        codexId,
        [codexInstance(probeFailed, " Alice@Example.com ")],
        hubFor("alice@example.com"),
        now,
      ),
    ).toEqual({ limits: limitsAt(30), sourceLabel: "hub" });
  });

  it("prefers the instance's own limits when it can read them", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(limitsAt(40))],
      [hub("hub", [{ id: "claude-a.json", limits: limitsAt(19) }])],
      now,
    );

    expect(resolved).toEqual({ limits: limitsAt(40), sourceLabel: null });
  });

  it("keeps the instance's notice when a second hub account has no usable limits", () => {
    // The hub may route the thread through either account, so the readable one is not enough.
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("hub", [
          { id: "claude-a.json", limits: limitsAt(19) },
          {
            id: "claude-b.json",
            limits: { ...unsupported, unavailable: { reason: "probeFailed" } },
          },
        ]),
      ],
      now,
    );

    expect(resolved).toEqual({ limits: unsupported, sourceLabel: null });
  });

  it("ignores other drivers' hub accounts but not the only account's unusable limits", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("hub", [
          { id: "codex-a.json", driver: ProviderDriverKind.make("codex"), limits: limitsAt(19) },
          { id: "claude-a.json", limits: unsupported },
        ]),
      ],
      now,
    );

    expect(resolved).toEqual({ limits: unsupported, sourceLabel: null });
  });

  it("shows nothing without a selected instance", () => {
    expect(
      resolveThreadDetailsLimits(
        null,
        [claudeInstance(unsupported)],
        [hub("hub", [{ id: "claude-a.json", limits: limitsAt(19) }])],
        now,
      ),
    ).toBeNull();
  });
});
