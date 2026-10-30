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

function hub(
  label: string,
  accounts: ReadonlyArray<{
    id: string;
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

  it("prefers the instance's own limits when it can read them", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(limitsAt(40))],
      [hub("hub", [{ id: "claude-a.json", limits: limitsAt(19) }])],
      now,
    );

    expect(resolved).toEqual({ limits: limitsAt(40), sourceLabel: null });
  });

  it("ignores hub accounts for other drivers and hub accounts without usable limits", () => {
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
