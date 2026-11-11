import {
  EnvironmentId,
  type NetworkMember,
  type PeerLinkSummary,
  type TailnetDevice,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  appAccessChange,
  canForgetOther,
  canManageNetwork,
  type DeviceNetworkHost,
  deviceNetworkView,
  hostControls,
  isTailnetDevicesForbidden,
  machineControls,
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
  nodeId: null,
  status: "online",
  access: "full-access",
  member: member(environmentId),
  localLimit: null,
  outgoing: "tailnet",
  incoming: true,
  tailnetName: environmentId,
  lastSeenAt: null,
  ...overrides,
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
          apps: [],
          enabled: options.enabled ?? true,
          callerAppId: options.callerAppId ?? null,
          joinOpenUntil: options.joinOpenUntil ?? null,
        },
});
const view = (
  hosts: ReadonlyArray<DeviceNetworkHost>,
  preferredHost: EnvironmentId | null = null,
) => deviceNetworkView({ hosts, savedEnvironmentIds: new Set(), preferredHost });
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
    const boxHost = host(box, { devices: [device(studio), found(laptop)] });
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
      preferredHost: null,
    });
    expect(
      group?.machines.map((machine) => [
        machine.entry.environmentId,
        machine.kind,
        machine.entry.links.length,
        machine.entry.savedInApp,
      ]),
    ).toEqual([
      ["env-here", "member", 0, false],
      [box, "member", 0, false],
      [studio, "member", 1, true],
      [vps, "linked", 1, false],
      [laptop, "found", 0, false],
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
        device(laptop, { member: member(laptop, "revoked") }),
        found(vps),
        device(studioOld, { member: null, access: "auto", outgoing: "paired" }),
      ],
    }),
    host(box, { devices: [device(studio), device(laptop, { member: member(laptop, "revoked") })] }),
  ];
  const controls = (environmentId: EnvironmentId, preferred: EnvironmentId | null = studio) => {
    const [group] = view(hosts, preferred);
    const machine = group?.machines.find((row) => row.entry.environmentId === environmentId);
    if (group === undefined || machine === undefined) throw new Error("missing row");
    return machineControls(machine, group, { canOpen: true });
  };

  it("offers a live member's changes through the authority, and limits on the other hosts", () => {
    expect(controls(box)).toEqual({
      open: false,
      changeAccess: true,
      revoke: true,
      restore: false,
      add: false,
      linkHere: false,
      promote: false,
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
    expect(controls(vps)).toMatchObject({ add: true, linkHere: true, forgetHosts: [studio] });
    expect(controls(studioOld)).toMatchObject({ add: false, promote: true });
  });

  it("offers no network writes without an authority", () => {
    const readOnly = hosts.map((candidate) => ({ ...candidate, mayWrite: false }));
    for (const group of view(readOnly, studio)) {
      for (const machine of group.machines) {
        expect(machineControls(machine, group, { canOpen: true })).toMatchObject({
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
    expect(
      hostControls(host(studio, { devices: [device(box, { member: member(box, "auto") })] }), now),
    ).toEqual({ leave: true, lastFullAccess: true, allowJoin: false, joinOpenUntil: null });
    expect(hostControls(host(studio, { devices: [device(box)] }), now).lastFullAccess).toBe(false);
  });

  it("offers allowing a join to a machine in no network, with the window while it is open", () => {
    const later = DateTime.makeUnsafe(1_600_000);
    expect(hostControls(host(vps, { self: null, joinOpenUntil: later }), now)).toEqual({
      leave: false,
      lastFullAccess: false,
      allowJoin: true,
      joinOpenUntil: later,
    });
    const past = DateTime.makeUnsafe(10);
    expect(
      hostControls(host(vps, { self: member(vps, "revoked"), joinOpenUntil: past }), now),
    ).toMatchObject({ leave: false, allowJoin: true, joinOpenUntil: null });
    expect(hostControls(host(vps, { self: null, mayWrite: false }), now).allowJoin).toBe(false);
  });
});

describe("appAccessChange", () => {
  it("signs an app out for less access, and needs pairing again for more", () => {
    expect(appAccessChange("full-access", "read-only")).toBe("signsOut");
    expect(appAccessChange("read-only", "revoked")).toBe("signsOut");
    expect(appAccessChange("revoked", "read-only")).toBe("pairsAgain");
    expect(appAccessChange("read-only", "full-access")).toBe("pairsAgain");
    // Stored levels below full access are read-only for an app.
    expect(appAccessChange("auto", "read-only")).toBe("none");
    expect(appAccessChange("auto", "full-access")).toBe("pairsAgain");
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
