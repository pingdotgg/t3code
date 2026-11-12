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
    auth: {
      status: "authenticated",
      type: "customEndpoint",
      label: "Custom API endpoint",
      endpointHost: "hub.example",
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

function signedIn(
  id: string,
  limits: ServerProviderUsageLimits,
  auth: { email?: string; workspaceId?: string },
): ServerProvider {
  const base = claudeInstance(limits);
  return { ...base, instanceId: ProviderInstanceId.make(id), auth: { ...base.auth, ...auth } };
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
    host: "hub.example",
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

describe("resolveThreadDetailsLimits", () => {
  it("shows the only hub account for the driver when the instance reads no limits", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [claudeInstance(unsupported)],
      [
        hub("CLIProxy (homebox)", [
          { id: "codex-a.json", driver: codex, limits: limitsAt(60) },
          { id: "claude-a.json", limits: limitsAt(19) },
        ]),
      ],
      now,
    );

    expect(resolved).toEqual({ limits: limitsAt(19), sourceLabel: "CLIProxy (homebox)" });
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

  it("does not borrow from a hub the instance does not send its requests to", () => {
    const base = claudeInstance(unsupported);
    const resolve = (auth: ServerProvider["auth"]) =>
      resolveThreadDetailsLimits(
        instanceId,
        [{ ...base, auth }],
        [hub("hub", [{ id: "claude-a.json", limits: limitsAt(19) }])],
        now,
      );

    // A direct API key, and a custom endpoint on another host.
    expect(resolve({ status: "authenticated", type: "apiKey" })?.sourceLabel).toBeNull();
    expect(resolve({ ...base.auth, endpointHost: "gateway.example" })?.sourceLabel).toBeNull();
  });

  it("keeps the instance's notice when the account in use is not certain", () => {
    const notice = { limits: unsupported, sourceLabel: null };
    const resolve = (sources: UsageLimitSourceSnapshot[]) =>
      resolveThreadDetailsLimits(instanceId, [claudeInstance(unsupported)], sources, now);

    // Several accounts, on one hub or across hubs.
    expect(
      resolve([
        hub("hub-a", [{ id: "claude-a.json", limits: limitsAt(19) }]),
        hub("hub-b", [{ id: "claude-b.json", limits: limitsAt(60) }]),
      ]),
    ).toEqual(notice);
    // A second account whose limits cannot be read may still be the one routed to.
    expect(
      resolve([
        hub("hub", [
          { id: "claude-a.json", limits: limitsAt(19) },
          { id: "claude-b.json", limits: unsupported },
        ]),
      ]),
    ).toEqual(notice);
    // An unreadable hub may hold the account in use.
    expect(
      resolve([
        { ...hub("hub-a", []), error: "Connection refused." },
        hub("hub-b", [{ id: "claude-b.json", limits: limitsAt(60) }]),
      ]),
    ).toEqual(notice);
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

  it("skips a hub account with a different email or workspace than the instance", () => {
    const instance = signedIn(instanceId, unsupported, {
      email: " Me@Example.com ",
      workspaceId: "team-a",
    });
    const resolve = (account: { email: string; workspaceId: string }) =>
      resolveThreadDetailsLimits(
        instanceId,
        [instance],
        [hub("hub", [{ id: "claude-a.json", ...account, limits: limitsAt(19) }])],
        now,
      );

    expect(resolve({ email: "other@example.com", workspaceId: "team-a" })?.sourceLabel).toBeNull();
    expect(resolve({ email: "me@example.com", workspaceId: "team-b" })?.sourceLabel).toBeNull();
    expect(resolve({ email: "me@example.com", workspaceId: "team-a" })).toEqual({
      limits: limitsAt(19),
      sourceLabel: "hub",
    });
  });

  it("does not borrow a login's hub account when its workspace could be another instance's", () => {
    const resolved = resolveThreadDetailsLimits(
      instanceId,
      [
        signedIn(instanceId, unsupported, { email: "me@example.com", workspaceId: "team-a" }),
        signedIn("claude-b", limitsAt(10), { email: "me@example.com", workspaceId: "team-b" }),
      ],
      [hub("hub", [{ id: "claude-x.json", email: "me@example.com", limits: limitsAt(25) }])],
      now,
    );

    expect(resolved).toEqual({ limits: unsupported, sourceLabel: null });
  });
});
