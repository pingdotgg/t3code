import {
  EnvironmentId,
  type NetworkApp,
  type NetworkMember,
  type TailnetDevice,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { NetworkMemberStatus } from "./connection/networkMembers.ts";

import {
  appControls,
  canManageNetwork,
  type DeviceNetworkHost,
  type DeviceNetworkMemberStatuses,
  deviceNetworkView,
  hostControls,
  isTailnetDevicesForbidden,
  machineControls,
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
const host = (
  environmentId: EnvironmentId,
  options: {
    readonly self?: NetworkMember | null;
    readonly devices?: ReadonlyArray<TailnetDevice>;
    readonly callerAppId?: string | null;
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
        .filter(([, { status }]) => status !== "idle")
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
const rows = (
  hosts: ReadonlyArray<DeviceNetworkHost>,
  preferredHost: EnvironmentId | null = null,
) =>
  view(hosts, preferredHost).machines.map((machine) => [machine.entry.environmentId, machine.kind]);

describe("deviceNetworkView", () => {
  it("is one network whatever each host's roster holds so far", () => {
    // The shape that showed two networks: the new machine lists only the one that added it, and
    // the others have not heard of it yet.
    const hosts = [
      host(studio, { devices: [device(box)] }),
      host(box, { devices: [device(studio), device(laptop)] }),
      host(laptop, { devices: [device(box)] }),
    ];
    const network = view(hosts, studio);
    expect(network.inNetwork).toBe(true);
    expect(network.hosts.map((candidate) => candidate.environmentId)).toEqual([
      studio,
      box,
      laptop,
    ]);
    // Each machine once, a member as soon as any host lists it live.
    expect(rows(hosts)).toEqual([
      [box, "member"],
      [laptop, "member"],
      [studio, "member"],
    ]);
  });

  it("stays one network when the members still hold a machine as removed", () => {
    // What split the list in two: the laptop was removed, then brought a member in from its
    // own side, so it lists the box while every member still holds its tombstone.
    const removed = device(laptop, { status: "revoked", member: revokedBy(laptop, studio) });
    const hosts = [
      host(studio, { devices: [device(box), removed] }),
      host(box, { devices: [device(studio), removed] }),
      host(laptop, { devices: [device(box)] }),
    ];
    // One list, with the machine offered again from a member.
    expect(rows(hosts)).toEqual([
      [box, "member"],
      [studio, "member"],
      [laptop, "found"],
    ]);
  });

  it("offers a machine found on the tailnet once, whichever hosts found it", () => {
    const hosts = [
      host(studio, { devices: [device(box), found(vps)] }),
      host(box, { devices: [device(studio), found(vps)] }),
    ];
    expect(rows(hosts)).toEqual([
      [box, "member"],
      [studio, "member"],
      [vps, "found"],
    ]);
    // A connected machine in no network that a member found is offered the same way.
    const lone = host(vps, { self: null, devices: [found(studio), found(box)] });
    expect(rows([...hosts, lone])).toEqual([
      [box, "member"],
      [studio, "member"],
      [vps, "found"],
    ]);
    // Before any network exists, the machines this one found are what it may allow.
    expect(rows([lone])).toEqual([
      [box, "found"],
      [studio, "found"],
    ]);
    expect(view([lone]).inNetwork).toBe(false);
  });

  it("lists no revoked machine, earlier install or machine that stopped answering", () => {
    const named = (id: EnvironmentId, overrides: Partial<TailnetDevice> = {}) =>
      device(id, { label: "Studio-01", ...overrides });
    const hosts = [
      host(box, {
        devices: [
          named(studio),
          // Revoked installs of the same machine: never bound, and bound to its node.
          named(studioOld, {
            nodeId: null,
            status: "revoked",
            member: revokedBy(studioOld, box),
          }),
          named(laptop, {
            nodeId: `n-${studio}`,
            status: "revoked",
            member: { ...revokedBy(laptop, box), nodeId: `n-${studio}` },
          }),
          // An earlier install still in the roster whose node now answers as another one.
          named(vps, {
            nodeId: `n-${studio}`,
            status: "offline",
            member: member(vps, "full-access", `n-${studio}`),
          }),
        ],
      }),
    ];
    expect(rows(hosts)).toEqual([
      [box, "member"],
      [studio, "member"],
    ]);
    // A found machine that no longer answers is not offered.
    expect(rows([host(box, { devices: [found(vps, { status: "offline" })] })])).toEqual([
      [box, "member"],
    ]);
    // A member an update left bound to no node is offered again, since nothing can open it.
    expect(
      rows([host(box, { devices: [device(vps, { member: member(vps, "full-access", null) })] })]),
    ).toEqual([
      [box, "member"],
      [vps, "found"],
    ]);
    // A revoked machine still answering on the tailnet is offered like any other found one.
    expect(rows([host(box, { devices: [device(vps, { member: revokedBy(vps, box) })] })])).toEqual([
      [box, "member"],
      [vps, "found"],
    ]);
  });

  it("names a member by its machine, never its bare environment id", () => {
    const unnamed = { ...member(box), label: box };
    const network = view([
      host(studio, { devices: [device(box, { label: "Box", member: unnamed })] }),
    ]);
    expect(network.machines.map((machine) => machine.entry.label)).toEqual([studio, "Box"]);
  });

  it("takes the newest roster entry when hosts disagree", () => {
    const hosts = [
      host(studio, { devices: [device(box, { member: member(box, "full-access", "n-env-box") })] }),
      host(laptop, {
        devices: [device(box, { status: "offline", member: revokedBy(box, laptop) })],
      }),
    ];
    // The revocation is newer, and the machine still answers: it is offered, not a member.
    expect(rows(hosts).find(([id]) => id === box)).toEqual([box, "found"]);
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
    view(hosts, preferred).authority;

  it("prefers the host this client works through, then any full-access host it may write to", () => {
    expect(authority(network({}), box)).toBe(box);
    expect(authority(network({}), studio)).toBe(studio);
    expect(authority(network({ box: { mayWrite: false } }), box)).toBe(studio);
    expect(authority(network({ box: { self: member(box, "read-only") } }), box)).toBe(studio);
    expect(authority(network({ box: { enabled: false } }), box)).toBe(studio);
  });

  it("writes through a member before a machine in no network, and has none without a writer", () => {
    expect(
      authority(network({ studio: { mayWrite: false }, box: { mayWrite: false } }), null),
    ).toBeNull();
    const lone = host(vps, { self: null, devices: [found(laptop)] });
    expect(authority([lone], null)).toBe(vps);
    expect(authority([lone, ...network({})], vps)).toBe(box);
  });
});

describe("machineControls", () => {
  const hosts = [
    host(studio, { devices: [device(box), found(vps)] }),
    host(box, { devices: [device(studio)] }),
  ];
  const controls = (
    environmentId: EnvironmentId,
    from: ReadonlyArray<DeviceNetworkHost> = hosts,
    statuses: DeviceNetworkMemberStatuses = new Map(),
  ) => {
    const network = view(from, studio, statuses);
    const machine = network.machines.find((row) => row.entry.environmentId === environmentId);
    if (machine === undefined) throw new Error("missing row");
    return machineControls(machine, network);
  };

  it("allows a found machine in one step, through a member this client may write to", () => {
    expect(controls(vps)).toEqual({
      open: false,
      allow: true,
      changeAccess: false,
      remove: false,
      via: studio,
      limitHosts: [],
    });
  });

  it("changes or removes a member through another machine, never through itself", () => {
    expect(controls(box)).toMatchObject({
      allow: false,
      changeAccess: true,
      remove: true,
      via: studio,
      limitHosts: [studio],
    });
    expect(controls(studio)).toMatchObject({ changeAccess: true, remove: true, via: box });
    // With no other writer, a machine's own row offers no change.
    expect(controls(studio, [host(studio, { devices: [device(box)] })])).toMatchObject({
      changeAccess: false,
      remove: false,
      via: null,
    });
  });

  it("offers no network writes without a writer", () => {
    const readOnly = hosts.map((candidate) => ({ ...candidate, mayWrite: false }));
    expect(controls(vps, readOnly)).toMatchObject({ allow: false, via: null });
    expect(controls(box, readOnly)).toMatchObject({ changeAccess: false, remove: false });
  });

  it("opens a member only when a connected host can, or its session was refused", () => {
    const laptopHost = [host(studio, { devices: [device(laptop)] })];
    expect(controls(laptop, laptopHost).open).toBe(true);
    expect(controls(laptop, laptopHost, new Map([memberStatus(laptop, "open")])).open).toBe(false);
    expect(controls(laptop, laptopHost, new Map([memberStatus(laptop, "reopen")])).open).toBe(true);
    expect(
      controls(laptop, [host(studio, { devices: [device(laptop)], mayWrite: false })]).open,
    ).toBe(false);
  });

  it("says when a member would open read-only, by the app's level or the relay's", () => {
    const hint = (options: Parameters<typeof host>[1]) => {
      const network = view([host(studio, { devices: [device(laptop)], ...options })], studio);
      const machine = network.machines.find((row) => row.entry.environmentId === laptop);
      if (machine === undefined) throw new Error("missing row");
      return [machineControls(machine, network).open, openAccessHint(machine, network)] as const;
    };
    // Not an app of the network: the server asks for access:write.
    expect(hint({ mayWrite: false })).toEqual([false, null]);
    // An app of the network needs only orchestration:read, and is capped by its own level.
    expect(hint({ mayWrite: false, callerAppId: "app-phone", apps: [app("read-only")] })).toEqual([
      true,
      "read-only",
    ]);
    // Full everywhere this client can see, but the target's own limit is unknown.
    expect(hint({ mayWrite: false, callerAppId: "app-phone", apps: [app("full-access")] })).toEqual(
      [true, "unknown"],
    );
    // The relaying machine's roster level caps it too.
    expect(hint({ self: member(studio, "read-only") })).toEqual([true, "read-only"]);
  });
});

describe("hostControls", () => {
  it("offers leaving to a member, warning when it is the last full-access one", () => {
    // The server refuses the last full-access machine while other members remain.
    expect(
      hostControls(
        host(studio, { devices: [device(box, { member: member(box, "auto", "n-env-box") })] }),
      ),
    ).toEqual({ leave: false, leaveBlocked: true, lastFullAccess: true });
    expect(
      hostControls(host(studio, { devices: [device(box, { member: member(box, "revoked") })] })),
    ).toEqual({ leave: true, leaveBlocked: false, lastFullAccess: true });
    expect(hostControls(host(studio, { devices: [device(box)] })).lastFullAccess).toBe(false);
    expect(hostControls(host(vps, { self: null })).leave).toBe(false);
  });
});

describe("appControls", () => {
  const groupWith = (apps: ReadonlyArray<NetworkApp>, mayWrite = true) =>
    view([host(studio, { apps, mayWrite })], studio);
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
        message: "Box did not join: That machine removed this one from the network.",
      }),
    ).toBe("Box did not join: That machine removed this one from the network.");
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
};

const decodeWireSnapshot = Schema.decodeSync(Schema.toCodecJson(TailnetDevicesSnapshot));

describe("deviceNetworkView over the wire", () => {
  it("reads the server's snapshot: members, one found machine, and no revoked or unanswering one", () => {
    const snapshot = decodeWireSnapshot(WIRE_SNAPSHOT);
    const network = deviceNetworkView({
      hosts: [
        {
          environmentId: snapshot.self.environmentId,
          label: snapshot.self.label,
          enabled: true,
          mayWrite: true,
          snapshot,
        },
      ],
      savedEnvironmentIds: new Set([studio]),
      memberStatuses: new Map(),
      preferredHost: null,
    });
    expect(
      network.machines.map((machine) => [
        machine.entry.environmentId,
        machine.kind,
        machine.entry.inApp?.kind ?? null,
      ]),
    ).toEqual([
      ["env-here", "member", null],
      [studio, "member", "open"],
      [laptop, "found", null],
    ]);
    expect(network.apps.map((listed) => listed.appId)).toEqual(["app-phone"]);
  });
});

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
