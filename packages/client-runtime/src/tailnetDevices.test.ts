import {
  EnvironmentId,
  type NetworkApp,
  type NetworkMember,
  type PeerLinkSummary,
  type TailnetDevice,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { NetworkMemberStatus } from "./connection/networkMembers.ts";

import {
  appControls,
  canForgetOther,
  canManageNetwork,
  type DeviceNetworkHost,
  type DeviceNetworkMemberStatuses,
  deviceNetworkView,
  hostControls,
  isTailnetDevicesForbidden,
  machineControls,
  machinesToReadd,
  networkFailureMessage,
  openAccessHint,
} from "./tailnetDevices.ts";

const studio = EnvironmentId.make("env-studio");
const studioOld = EnvironmentId.make("env-studio-old");
const box = EnvironmentId.make("env-box");
const vps = EnvironmentId.make("env-vps");
const laptop = EnvironmentId.make("env-laptop");

const member = (
  environmentId: EnvironmentId,
  access: NetworkMember["access"] = "full-access",
  nodeId: string | null = null,
): NetworkMember => ({
  environmentId,
  label: environmentId,
  nodeId,
  access,
  updatedAt: { wallMs: 1, counter: 0, node: environmentId },
});
const device = (
  environmentId: EnvironmentId,
  overrides: Partial<TailnetDevice> = {},
): TailnetDevice => ({
  environmentId,
  label: environmentId,
  urls: [`https://${environmentId}.ts.net`],
  nodeId: `n-${environmentId}`,
  status: "online",
  access: "full-access",
  member: member(environmentId, "full-access", `n-${environmentId}`),
  localLimit: null,
  outgoing: "tailnet",
  incoming: true,
  tailnetName: environmentId,
  lastSeenAt: null,
  ...overrides,
});
/** Revoked by `by`; a member that revoked itself has left. */
const revokedBy = (environmentId: EnvironmentId, by: EnvironmentId): NetworkMember => ({
  ...member(environmentId, "revoked"),
  updatedAt: { wallMs: 2, counter: 0, node: by },
});
const app = (access: NetworkApp["access"]): NetworkApp => ({
  appId: "app-phone",
  label: "Phone",
  access,
  updatedAt: { wallMs: 1, counter: 0, node: studio },
});
const found = (environmentId: EnvironmentId, overrides: Partial<TailnetDevice> = {}) =>
  device(environmentId, { access: null, member: null, outgoing: null, ...overrides });
const link = (environmentId: EnvironmentId): PeerLinkSummary => ({
  environmentId,
  label: environmentId,
  urls: [],
  access: "approval-required",
  origin: "paired",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(0),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});
const host = (
  environmentId: EnvironmentId,
  options: {
    readonly self?: NetworkMember | null;
    readonly devices?: ReadonlyArray<TailnetDevice>;
    readonly links?: ReadonlyArray<PeerLinkSummary>;
    readonly callerAppId?: string | null;
    readonly joinOpenUntil?: DateTime.Utc | null;
    readonly mayWrite?: boolean;
    readonly apps?: ReadonlyArray<NetworkApp>;
    readonly enabled?: boolean;
    readonly loaded?: boolean;
  } = {},
): DeviceNetworkHost => ({
  environmentId,
  label: environmentId,
  enabled: options.enabled ?? true,
  mayWrite: options.mayWrite ?? true,
  links: options.links ?? [],
  snapshot:
    options.loaded === false
      ? null
      : {
          self: { environmentId, label: environmentId, urls: [] },
          selfMember: options.self === undefined ? member(environmentId) : options.self,
          devices: options.devices ?? [],
          apps: options.apps ?? [],
          enabled: options.enabled ?? true,
          callerAppId: options.callerAppId ?? null,
          joinOpenUntil: options.joinOpenUntil ?? null,
        },
});
const view = (
  hosts: ReadonlyArray<DeviceNetworkHost>,
  preferredHost: EnvironmentId | null = null,
  memberStatuses: DeviceNetworkMemberStatuses = new Map(),
) =>
  deviceNetworkView({
    hosts,
    savedEnvironmentIds: new Set(
      [...memberStatuses]
        .filter(([, { status }]) => status !== "unopened")
        .map(([environmentId]) => environmentId),
    ),
    memberStatuses,
    preferredHost,
  });
const memberStatus = (
  environmentId: EnvironmentId,
  status: NetworkMemberStatus,
  sessionExpiresAt?: number,
  left = false,
) =>
  [
    environmentId,
    {
      record: {
        ...(sessionExpiresAt === undefined ? {} : { sessionExpiresAt }),
        ...(left ? { left: true as const } : {}),
      },
      status,
    },
  ] as const;
const shape = (
  hosts: ReadonlyArray<DeviceNetworkHost>,
  preferredHost: EnvironmentId | null = null,
) =>
  view(hosts, preferredHost).map((group) => ({
    hosts: group.hosts.map((candidate) => candidate.environmentId),
    inNetwork: group.inNetwork,
    machines: group.machines.map((machine) => [machine.entry.environmentId, machine.kind]),
  }));

describe("deviceNetworkView", () => {
  it("merges hosts that list each other into one network, and keeps a lone host apart", () => {
    const studioHost = host(studio, {
      devices: [device(box), found(laptop, { status: "offline" }), found(vps)],
    });
    // Forgotten on the box: still revoked there, but offered again as a machine to add.
    const boxHost = host(box, { devices: [device(studio), found(laptop, { access: "revoked" })] });
    // Not in a network; it finds both members, which it could not add.
    const vpsHost = host(vps, { self: null, devices: [found(studio), found(box), found(laptop)] });
    expect(shape([vpsHost, boxHost, studioHost])).toEqual([
      {
        hosts: [box, studio],
        inNetwork: true,
        machines: [
          [box, "member"],
          [studio, "member"],
          [laptop, "found"],
          [vps, "found"],
        ],
      },
      { hosts: [vps], inNetwork: false, machines: [[laptop, "found"]] },
    ]);
    // Seen online by one host and offline by the other: one row, online.
    const laptopRow = view([studioHost, boxHost])[0]?.machines.find(
      (machine) => machine.entry.environmentId === laptop,
    );
    expect(laptopRow?.entry.status).toBe("online");
    expect(laptopRow?.entry.views.map((seen) => seen.host)).toEqual([box, studio]);
  });

  it("keeps hosts apart when only one lists the other, or one revoked the other", () => {
    const studioHost = host(studio, { devices: [device(box)] });
    const boxHost = host(box, { devices: [] });
    expect(shape([studioHost, boxHost]).map((group) => group.hosts)).toEqual([[studio], [box]]);
    const revoking = host(box, {
      devices: [device(studio, { member: member(studio, "revoked") })],
    });
    expect(shape([studioHost, revoking]).map((group) => group.hosts)).toEqual([[studio], [box]]);
  });

  it("joins hosts where this client is the same app of the network before their rosters sync", () => {
    const studioHost = host(studio, { callerAppId: "app-phone" });
    const boxHost = host(box, { callerAppId: "app-phone" });
    expect(shape([studioHost, boxHost]).map((group) => group.hosts)).toEqual([[box, studio]]);
  });

  it("puts a host still loading with the network that lists it", () => {
    const studioHost = host(studio, { devices: [device(box)] });
    const loading = host(box, { loaded: false });
    expect(shape([studioHost, loading]).map((group) => group.hosts)).toEqual([[box, studio]]);
  });

  it("shows a reinstalled machine once, by its node, with the old environment to forget", () => {
    const studioHost = host(box, {
      devices: [
        device(studioOld, {
          nodeId: "n-studio",
          status: "offline",
          member: member(studioOld, "full-access", "n-studio"),
        }),
        found(studio, { nodeId: "n-studio" }),
      ],
    });
    const [group] = view([studioHost]);
    const machine = group?.machines.find((candidate) => candidate.key === "n-studio");
    expect(group?.machines.map((candidate) => candidate.key)).toEqual([box, "n-studio"]);
    expect(machine?.entry.environmentId).toBe(studio);
    expect(machine?.kind).toBe("found");
    expect(machine?.others.map((other) => other.environmentId)).toEqual([studioOld]);
    expect(group && machine?.others[0] ? canForgetOther(group, machine.others[0]) : null).toBe(
      true,
    );
  });

  it("shows networks the update split as one once their rosters list each other", () => {
    // Before the repair: each lists only its own side, so a machine shows in one group only.
    const split = [
      host(studio, { devices: [device(laptop)] }),
      host(laptop, { devices: [device(studio)] }),
      host(box, { devices: [device(vps)] }),
      host(vps, { devices: [device(box)] }),
    ];
    const before = view(split);
    expect(before.map((group) => group.hosts.map((candidate) => candidate.environmentId))).toEqual([
      [laptop, studio],
      [box, vps],
    ]);
    for (const machine of [studio, laptop, box, vps]) {
      const listing = before.filter((group) =>
        group.machines.some(
          (candidate) => candidate.entry.environmentId === machine && candidate.kind === "member",
        ),
      );
      expect(listing).toHaveLength(1);
    }
    // A host of the other network, found from this one: adding it merges them.
    const finding = view([
      host(studio, { devices: [device(laptop), found(box)] }),
      ...split.slice(1),
    ]);
    const boxRow = finding[0]?.machines.find((candidate) => candidate.entry.environmentId === box);
    expect(boxRow?.inOtherNetwork).toBe(true);
    expect(finding[0]?.machines.find((m) => m.entry.environmentId === laptop)?.inOtherNetwork).toBe(
      false,
    );

    // After the repair every roster lists everyone.
    const everyone = [studio, laptop, box, vps];
    const merged = everyone.map((id) =>
      host(id, { devices: everyone.filter((other) => other !== id).map((other) => device(other)) }),
    );
    expect(view(merged).map((group) => group.hosts.length)).toEqual([4]);
  });

  it("names a member by its machine, never its bare environment id", () => {
    const [group] = view([
      host(studio, {
        devices: [device(laptop, { label: "MacBook Pro", member: member(laptop) })],
      }),
    ]);
    expect(group?.machines.find((m) => m.entry.environmentId === laptop)?.entry.label).toBe(
      "MacBook Pro",
    );
  });

  it("shows old revoked installs under the live machine of their name", () => {
    const named = (id: EnvironmentId, label: string, overrides: Partial<TailnetDevice> = {}) =>
      device(id, { label, nodeId: null, member: { ...member(id), label }, ...overrides });
    const [group] = view([
      host(box, {
        devices: [
          named(studio, "Studio-01", { nodeId: "n-studio" }),
          named(studioOld, "Studio-01", {
            status: "revoked",
            member: { ...revokedBy(studioOld, box), label: "Studio-01" },
          }),
        ],
      }),
    ]);
    const studioRow = group?.machines.find((m) => m.entry.environmentId === studio);
    expect(group?.machines.map((m) => m.entry.environmentId)).toEqual([box, studio]);
    expect(studioRow?.others.map((other) => other.environmentId)).toEqual([studioOld]);
  });

  it("takes the newest roster entry when hosts disagree", () => {
    const fresh = host(laptop, {
      devices: [
        device(box, {
          member: { ...member(box, "revoked"), updatedAt: { wallMs: 9, counter: 0, node: laptop } },
        }),
        device(studio),
      ],
    });
    const staleWithLaptop = host(studio, { devices: [device(box), device(laptop)] });
    const boxRow = view([staleWithLaptop, fresh])[0]?.machines.find(
      (machine) => machine.entry.environmentId === box,
    );
    expect(boxRow?.entry.member?.access).toBe("revoked");
    expect(boxRow?.entry.status).toBe("revoked");
  });

  it("keeps every listed device in its group over the server's snapshot", () => {
    const snapshot = decodeWireSnapshot(WIRE_SNAPSHOT);
    const [group] = deviceNetworkView({
      hosts: [
        {
          environmentId: snapshot.self.environmentId,
          label: snapshot.self.label,
          enabled: true,
          mayWrite: true,
          snapshot,
          links: [link(vps), link(studio)],
        },
      ],
      savedEnvironmentIds: new Set([studio]),
      memberStatuses: new Map(),
      preferredHost: null,
    });
    expect(
      group?.machines.map((machine) => [
        machine.entry.environmentId,
        machine.kind,
        machine.entry.links.length,
        machine.entry.inApp?.kind ?? null,
      ]),
    ).toEqual([
      ["env-here", "member", 0, null],
      [box, "member", 0, null],
      [studio, "member", 1, "open"],
      [vps, "linked", 1, null],
      [laptop, "found", 0, null],
    ]);
    expect(group?.apps.map((app) => app.appId)).toEqual(["app-phone"]);
  });
});

describe("chooseAuthority", () => {
  const network = (options: {
    readonly studio?: Parameters<typeof host>[1];
    readonly box?: Parameters<typeof host>[1];
  }) => [
    host(studio, { devices: [device(box)], ...options.studio }),
    host(box, { devices: [device(studio)], ...options.box }),
  ];
  const authority = (hosts: ReadonlyArray<DeviceNetworkHost>, preferred: EnvironmentId | null) =>
    view(hosts, preferred)[0]?.authority;

  it("prefers the host this client works through, then any full-access host it may write to", () => {
    expect(authority(network({}), box)).toBe(box);
    expect(authority(network({}), studio)).toBe(studio);
    expect(authority(network({ box: { mayWrite: false } }), box)).toBe(studio);
    expect(authority(network({ box: { self: member(box, "read-only") } }), box)).toBe(studio);
    expect(authority(network({ box: { enabled: false } }), box)).toBe(studio);
  });

  it("has none when no host here may write to the network", () => {
    expect(
      authority(network({ studio: { mayWrite: false }, box: { mayWrite: false } }), null),
    ).toBeNull();
    // A host in no network starts one when it adds a machine.
    expect(authority([host(vps, { self: null, devices: [found(laptop)] })], null)).toBe(vps);
  });
});

describe("machineControls", () => {
  const hosts = [
    host(studio, {
      devices: [
        device(box),
        device(laptop, { member: revokedBy(laptop, studio) }),
        found(vps),
        device(studioOld, { member: null, access: "auto", outgoing: "paired" }),
      ],
    }),
    host(box, { devices: [device(studio), device(laptop, { member: revokedBy(laptop, studio) })] }),
  ];
  const controls = (environmentId: EnvironmentId, preferred: EnvironmentId | null = studio) => {
    const [group] = view(hosts, preferred);
    const machine = group?.machines.find((row) => row.entry.environmentId === environmentId);
    if (group === undefined || machine === undefined) throw new Error("missing row");
    return machineControls(machine, group);
  };

  it("offers a live member's changes through the authority, and limits on the other hosts", () => {
    expect(controls(box)).toEqual({
      open: false,
      changeAccess: true,
      revoke: true,
      restore: false,
      add: false,
      forgotten: false,
      linkHere: false,
      promote: false,
      readd: false,
      readdVia: null,
      needsReadd: false,
      reconnecting: false,
      left: false,
      forgetHosts: [studio],
      limitHosts: [studio],
    });
    // The authority does not change or forget itself; another host may.
    expect(controls(studio)).toMatchObject({ changeAccess: false, revoke: false, forgetHosts: [] });
    expect(controls(studio, box)).toMatchObject({
      changeAccess: true,
      forgetHosts: [box],
      limitHosts: [box],
    });
  });

  it("restores a revoked member, adds a found machine and promotes a linked one", () => {
    expect(controls(laptop)).toMatchObject({
      changeAccess: false,
      restore: true,
      limitHosts: [],
      forgetHosts: [studio, box],
    });
    expect(controls(vps)).toMatchObject({
      add: true,
      forgotten: false,
      linkHere: true,
      forgetHosts: [studio],
    });
    expect(controls(studioOld)).toMatchObject({ add: false, promote: true });
    // Forgotten here and found again: adding it is its restore.
    const [group] = view([
      host(studio, { devices: [device(box), found(vps, { access: "revoked" })] }),
    ]);
    const forgotten = group?.machines.find((row) => row.entry.environmentId === vps);
    expect(group && forgotten ? machineControls(forgotten, group) : null).toMatchObject({
      add: true,
      forgotten: true,
    });
  });

  it("offers only re-adding for a member the server left unbound after the update", () => {
    // The scan still knows the node; only the roster entry says it is unbound.
    const unbound = [
      host(studio, { devices: [device(box, { member: member(box), outgoing: null })] }),
      host(laptop, { self: null, devices: [] }),
    ];
    const [group] = view(unbound, studio);
    const machine = group?.machines.find((row) => row.entry.environmentId === box);
    if (group === undefined || machine === undefined) throw new Error("missing row");
    expect(machineControls(machine, group)).toEqual({
      open: false,
      changeAccess: false,
      revoke: false,
      restore: false,
      add: false,
      forgotten: false,
      linkHere: false,
      promote: false,
      readd: true,
      readdVia: studio,
      needsReadd: true,
      reconnecting: false,
      left: false,
      forgetHosts: [studio],
      limitHosts: [],
    });
    // Without a machine to write through, it is still marked, with nothing to press.
    const [readOnlyGroup] = view(
      unbound.map((candidate) => ({ ...candidate, mayWrite: false })),
      studio,
    );
    const readOnly = readOnlyGroup?.machines.find((row) => row.entry.environmentId === box);
    expect(
      readOnly && readOnlyGroup ? machineControls(readOnly, readOnlyGroup) : null,
    ).toMatchObject({ readd: false, readdVia: null, needsReadd: true });
    // Still linked both ways, it binds on its next handshake: nothing to re-add.
    const [linkedGroup] = view(
      [host(studio, { devices: [device(box, { member: member(box) })] }), unbound[1]!],
      studio,
    );
    const linked = linkedGroup?.machines.find((row) => row.entry.environmentId === box);
    expect(linked && linkedGroup ? machineControls(linked, linkedGroup) : null).toMatchObject({
      readd: false,
      needsReadd: false,
      reconnecting: true,
      revoke: true,
    });
  });

  it("re-adds an unbound machine through another one, and avoids it as the authority", () => {
    const bound = (id: EnvironmentId) => member(id, "full-access", `n-${id}`);
    // No link left between them, so neither binds the other on its own.
    const unboundStudio = device(studio, { member: member(studio), outgoing: null });
    // Box's roster has studio unbound; studio's has box bound.
    const hosts = [
      host(studio, { self: bound(studio), devices: [device(box)] }),
      host(box, { self: bound(box), devices: [unboundStudio] }),
    ];
    const [group] = view(hosts, studio);
    const row = group?.machines.find((machine) => machine.entry.environmentId === studio);
    if (group === undefined || row === undefined) throw new Error("missing row");
    expect(group.authority).toBe(box);
    expect(machineControls(row, group)).toMatchObject({ readd: true, readdVia: box });
    expect(machinesToReadd(view(hosts, studio))).toEqual(new Set([studio]));
    // Both unbound in each other's roster: each is re-added through the other.
    const both = [
      host(studio, {
        self: bound(studio),
        devices: [device(box, { member: member(box), outgoing: null })],
      }),
      host(box, { self: bound(box), devices: [unboundStudio] }),
    ];
    const [mutual] = view(both, studio);
    const studioRow = mutual?.machines.find((machine) => machine.entry.environmentId === studio);
    if (mutual === undefined || studioRow === undefined) throw new Error("missing row");
    expect(mutual.authority).toBe(studio);
    expect(machineControls(studioRow, mutual)).toMatchObject({ readd: true, readdVia: box });
  });

  it("does not offer starting a second network beside one already shown", () => {
    const groups = view(
      [
        host(studio, { devices: [device(box), found(laptop)] }),
        host(box, { devices: [device(studio)] }),
        host(vps, { self: null, devices: [found(laptop)] }),
      ],
      studio,
    );
    const lone = groups.find((group) => !group.inNetwork);
    const row = lone?.machines.find((machine) => machine.entry.environmentId === laptop);
    if (lone === undefined || row === undefined) throw new Error("missing row");
    expect(machineControls(row, lone)).toMatchObject({ add: false, linkHere: true });
  });

  it("offers adding a machine that left again, not restoring it", () => {
    const left = [
      host(studio, {
        devices: [device(box), device(laptop, { member: member(laptop, "revoked") })],
      }),
    ];
    const keptUntil = 1_800_000_000_000;
    const [group] = view(left, studio, new Map([memberStatus(laptop, "left", keptUntil)]));
    const machine = group?.machines.find((row) => row.entry.environmentId === laptop);
    if (group === undefined || machine === undefined) throw new Error("missing row");
    expect(machine.entry.inApp).toEqual({
      kind: "left",
      until: DateTime.makeUnsafe(keptUntil),
    });
    expect(machineControls(machine, group)).toMatchObject({
      open: false,
      left: true,
      readd: true,
      restore: false,
      changeAccess: false,
      forgetHosts: [studio],
    });
  });

  it("opens members only through a host the server lets this session open from", () => {
    const target = device(laptop);
    const opened = (
      options: Parameters<typeof host>[1],
      statuses: DeviceNetworkMemberStatuses = new Map(),
    ) => {
      const [group] = view([host(studio, { devices: [target], ...options })], studio, statuses);
      const machine = group?.machines.find((row) => row.entry.environmentId === laptop);
      if (group === undefined || machine === undefined) throw new Error("missing row");
      return [machineControls(machine, group).open, openAccessHint(machine, group)] as const;
    };
    // Not an app of the network: the server asks for access:write.
    expect(opened({ mayWrite: false })).toEqual([false, null]);
    // An app the network revoked opens nothing, whatever its session's scopes.
    expect(opened({ mayWrite: false, callerAppId: "app-phone", apps: [app("revoked")] })).toEqual([
      false,
      null,
    ]);
    // Saved with a session that still works: nothing to open. Expired or cut: open again.
    expect(opened({}, new Map([memberStatus(laptop, "open")]))[0]).toBe(false);
    expect(opened({}, new Map([memberStatus(laptop, "reopen")]))[0]).toBe(true);
    // Refused with nothing here to reopen it, whether or not it left: no Open, pair by code.
    for (const left of [false, true]) {
      const [refused] = view(
        [host(studio, { devices: [target] })],
        studio,
        new Map([memberStatus(laptop, "refused", undefined, left)]),
      );
      const row = refused?.machines.find((candidate) => candidate.entry.environmentId === laptop);
      if (refused === undefined || row === undefined) throw new Error("missing row");
      expect([row.entry.inApp, machineControls(row, refused).open]).toEqual([
        { kind: "refused", left },
        false,
      ]);
    }
    // An app of the network needs only orchestration:read, and is capped by its own level.
    expect(opened({ mayWrite: false, callerAppId: "app-phone", apps: [app("read-only")] })).toEqual(
      [true, "read-only"],
    );
    // Full everywhere this client can see, but the target's own limit is unknown.
    expect(
      opened({ mayWrite: false, callerAppId: "app-phone", apps: [app("full-access")] }),
    ).toEqual([true, "unknown"]);
    // The relaying machine's roster level caps it too.
    expect(opened({ self: member(studio, "auto") })).toEqual([true, "read-only"]);
  });

  it("offers no network writes without an authority", () => {
    const readOnly = hosts.map((candidate) => ({ ...candidate, mayWrite: false }));
    for (const group of view(readOnly, studio)) {
      for (const machine of group.machines) {
        expect(machineControls(machine, group)).toMatchObject({
          changeAccess: false,
          revoke: false,
          restore: false,
          add: false,
          promote: false,
          forgetHosts: [],
          limitHosts: [],
        });
      }
    }
  });
});

describe("hostControls", () => {
  const now = DateTime.makeUnsafe(1_000_000);
  it("offers leaving to a member, warning when it is the last full-access one", () => {
    // The server refuses the last full-access machine while other members remain.
    expect(
      hostControls(
        host(studio, { devices: [device(box, { member: member(box, "auto", "n-env-box") })] }),
        now,
      ),
    ).toEqual({
      leave: false,
      leaveBlocked: true,
      lastFullAccess: true,
      // A local link needs consent here even in a network.
      allowJoin: true,
      joinOpenUntil: null,
    });
    expect(
      hostControls(
        host(studio, { devices: [device(box, { member: member(box, "revoked") })] }),
        now,
      ),
    ).toMatchObject({ leave: true, leaveBlocked: false, lastFullAccess: true });
    expect(hostControls(host(studio, { devices: [device(box)] }), now).lastFullAccess).toBe(false);
  });

  it("offers allowing a join to a machine in no network, with the window while it is open", () => {
    const later = DateTime.makeUnsafe(1_600_000);
    expect(hostControls(host(vps, { self: null, joinOpenUntil: later }), now)).toEqual({
      leave: false,
      leaveBlocked: false,
      lastFullAccess: false,
      allowJoin: true,
      joinOpenUntil: later,
    });
    const past = DateTime.makeUnsafe(10);
    expect(
      hostControls(host(vps, { self: member(vps, "revoked"), joinOpenUntil: past }), now),
    ).toMatchObject({ leave: false, allowJoin: true, joinOpenUntil: null });
    expect(hostControls(host(vps, { self: null, mayWrite: false }), now).allowJoin).toBe(false);
    // A member whose roster still holds unbound members from before the update must consent too.
    expect(
      hostControls(host(studio, { devices: [device(box, { member: member(box) })] }), now),
    ).toMatchObject({ leave: true, allowJoin: true });
  });
});

describe("appControls", () => {
  const groupWith = (apps: ReadonlyArray<NetworkApp>, mayWrite = true) => {
    const [group] = view([host(studio, { apps, mayWrite })], studio);
    if (group === undefined) throw new Error("missing group");
    return group;
  };
  it("offers only narrowing; more access is pairing again under the same app", () => {
    const controls = (access: NetworkApp["access"], mayWrite = true) =>
      appControls(app(access), groupWith([app(access)], mayWrite));
    expect(controls("full-access")).toEqual({
      narrowTo: ["read-only", "revoked"],
      pairAgain: false,
      pairAsNew: false,
      forget: false,
    });
    expect(controls("read-only")).toEqual({
      narrowTo: ["revoked"],
      pairAgain: true,
      pairAsNew: false,
      forget: false,
    });
    // Stored levels below full access are read-only for an app.
    expect(controls("auto")).toMatchObject({ narrowTo: ["revoked"] });
    expect(controls("revoked")).toEqual({
      narrowTo: [],
      pairAgain: true,
      pairAsNew: false,
      forget: true,
    });
    expect(controls("full-access", false)).toEqual({
      narrowTo: [],
      pairAgain: false,
      pairAsNew: false,
      forget: false,
    });
  });

  it("pairs as a new app when the authority no longer lists the old one", () => {
    // Another host still lists it revoked; the authority replaced or forgot it.
    expect(appControls(app("revoked"), groupWith([]))).toMatchObject({
      pairAgain: false,
      pairAsNew: true,
    });
  });
});

describe("networkFailureMessage", () => {
  it("shows the machine's own reason, and a plain one otherwise", () => {
    expect(
      networkFailureMessage({
        _tag: "TailnetDevicesError",
        reason: "forbidden",
        message:
          "That machine is in no network and has not allowed joining. Allow joining on it first.",
      }),
    ).toBe("That machine is in no network and has not allowed joining. Allow joining on it first.");
    expect(networkFailureMessage({ _tag: "EnvironmentAuthorizationError" })).toBe(
      "This app may not make that change on that machine.",
    );
    expect(networkFailureMessage(new Error(""))).toBe(
      "Check that the machines are online, then try again.",
    );
  });
});

// What `TailnetDevices.list` sends: a revoked member, a member it links to, a machine found on
// the tailnet but not added, and a paired link, as JSON on the wire.
const WIRE_SNAPSHOT = {
  self: { environmentId: "env-here", label: "Here", urls: ["https://here.ts.net"] },
  selfMember: {
    environmentId: "env-here",
    label: "Here",
    nodeId: "n-here",
    access: "full-access",
    updatedAt: { wallMs: 1, counter: 0, node: "env-here" },
  },
  devices: [
    {
      environmentId: "env-box",
      label: "Box",
      urls: ["https://box.ts.net"],
      nodeId: "n-box",
      status: "revoked",
      access: "revoked",
      member: {
        environmentId: "env-box",
        label: "Box",
        nodeId: "n-box",
        access: "revoked",
        updatedAt: { wallMs: 2, counter: 0, node: "env-here" },
      },
      localLimit: null,
      outgoing: null,
      incoming: true,
      tailnetName: "box",
      lastSeenAt: null,
    },
    {
      environmentId: "env-studio",
      label: "studio-01",
      urls: ["https://studio-01.ts.net"],
      nodeId: null,
      status: "online",
      access: "approval-required",
      member: {
        environmentId: "env-studio",
        label: "studio-01",
        nodeId: null,
        access: "full-access",
        updatedAt: { wallMs: 1, counter: 0, node: "env-here" },
      },
      localLimit: "approval-required",
      outgoing: "tailnet",
      incoming: true,
      tailnetName: "studio-01",
      lastSeenAt: "2026-10-30T10:00:00.000Z",
    },
    {
      environmentId: "env-laptop",
      label: "Laptop",
      urls: ["https://laptop.ts.net"],
      nodeId: "n-laptop",
      status: "online",
      access: null,
      member: null,
      localLimit: null,
      outgoing: null,
      incoming: false,
      tailnetName: "laptop",
      lastSeenAt: "2026-10-30T10:00:00.000Z",
    },
    {
      environmentId: "env-vps",
      label: "VPS",
      urls: ["https://vps.example.com"],
      nodeId: null,
      status: "offline",
      access: "approval-required",
      member: null,
      localLimit: null,
      outgoing: "paired",
      incoming: false,
      tailnetName: null,
      lastSeenAt: null,
    },
  ],
  apps: [
    {
      appId: "app-phone",
      label: "Phone",
      access: "full-access",
      updatedAt: { wallMs: 1, counter: 0, node: "env-here" },
    },
  ],
  enabled: true,
  callerAppId: null,
  joinOpenUntil: null,
};

const decodeWireSnapshot = Schema.decodeSync(Schema.toCodecJson(TailnetDevicesSnapshot));

describe("canManageNetwork", () => {
  it("lets a full-access member, or a machine starting a network, change it", () => {
    const joined = device(studio);
    expect(canManageNetwork({ selfMember: null, devices: [found(box)] })).toBe(true);
    expect(canManageNetwork({ selfMember: null, devices: [joined] })).toBe(false);
    // Old revoked installs alone are no network.
    const tombstone = device(studioOld, { member: member(studioOld, "revoked") });
    expect(canManageNetwork({ selfMember: null, devices: [tombstone] })).toBe(true);
    expect(canManageNetwork({ selfMember: member(laptop), devices: [joined] })).toBe(true);
    expect(canManageNetwork({ selfMember: member(laptop, "auto"), devices: [joined] })).toBe(false);
    expect(canManageNetwork({ selfMember: member(laptop, "revoked"), devices: [] })).toBe(false);
  });
});

describe("isTailnetDevicesForbidden", () => {
  it("hides rows only when the session may not see them", () => {
    expect(isTailnetDevicesForbidden({ _tag: "EnvironmentAuthorizationError" })).toBe(true);
    expect(isTailnetDevicesForbidden({ _tag: "TailnetDevicesError", reason: "forbidden" })).toBe(
      true,
    );
    expect(isTailnetDevicesForbidden({ _tag: "TailnetDevicesError", reason: "unreachable" })).toBe(
      false,
    );
    expect(isTailnetDevicesForbidden(null)).toBe(false);
  });
});
