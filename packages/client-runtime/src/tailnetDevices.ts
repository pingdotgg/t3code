/**
 * The one Device network view a client shows, merged from every connected host: hosts that list
 * each other as members are one network, machines are grouped by their Tailscale node, and writes
 * go through one chosen authority.
 */
import type {
  EnvironmentId,
  NetworkApp,
  NetworkAppAccess,
  NetworkMember,
  PeerLinkSummary,
  TailnetDevice,
  TailnetDeviceAccess,
  TailnetDeviceStatus,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** A connected environment that offers the network, as this client sees it. */
export interface DeviceNetworkHost {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Its Device network switch. */
  readonly enabled: boolean;
  /** Null while loading, or when the host cannot list devices. */
  readonly snapshot: TailnetDevicesSnapshot | null;
  readonly links: ReadonlyArray<PeerLinkSummary>;
  /** This client's session there may change access (`access:write`). */
  readonly mayWrite: boolean;
  /** This client's session there holds `orchestration:read`, enough to open as an app. */
  readonly mayOpen: boolean;
}

/** One environment of a machine, merged from what every host in the group says about it. */
export interface MachineEntry {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly nodeId: string | null;
  /** The newest roster entry any host holds. */
  readonly member: NetworkMember | null;
  readonly status: TailnetDeviceStatus;
  readonly urls: ReadonlyArray<string>;
  readonly tailnetName: string | null;
  readonly lastSeenAt: DateTime.Utc | null;
  /** This client is connected to it: it is one of the group's hosts. */
  readonly isHost: boolean;
  /** How each host in the group sees it. */
  readonly views: ReadonlyArray<{ readonly host: EnvironmentId; readonly device: TailnetDevice }>;
  /** Links hosts in the group hold to it. */
  readonly links: ReadonlyArray<{ readonly host: EnvironmentId; readonly link: PeerLinkSummary }>;
  readonly savedInApp: boolean;
}

/** In the roster; linked to one host only (a pairing code or a local add); or only found. */
export type MachineKind = "member" | "linked" | "found";

export interface DeviceNetworkMachine {
  /** Its Tailscale node id, or its environment id while that is unknown. */
  readonly key: string;
  readonly kind: MachineKind;
  readonly entry: MachineEntry;
  /** Other environments on the same node, such as the one a reinstall left behind. */
  readonly others: ReadonlyArray<MachineEntry>;
}

export interface DeviceNetworkGroup {
  readonly key: string;
  /** Its hosts are in a network; otherwise it is one host in none. */
  readonly inNetwork: boolean;
  readonly hosts: ReadonlyArray<DeviceNetworkHost>;
  /** The host every network write goes through, or null when none here may write. */
  readonly authority: EnvironmentId | null;
  /** Members first, then machines linked to one host, then machines only found. */
  readonly machines: ReadonlyArray<DeviceNetworkMachine>;
  readonly apps: ReadonlyArray<NetworkApp>;
}

const isLiveMember = (member: NetworkMember | null | undefined): member is NetworkMember =>
  member != null && member.access !== "revoked";

/** A member that revoked itself: it left, and comes back only by being added again. */
const hasLeft = (member: NetworkMember | null): boolean =>
  member !== null && member.access === "revoked" && member.updatedAt.node === member.environmentId;

/**
 * The server opens members for an app of the network on `orchestration:read`, and for any other
 * session only with `access:write`.
 */
const opensThrough = (host: DeviceNetworkHost) =>
  host.enabled &&
  inNetwork(host) &&
  (host.snapshot?.callerAppId == null ? host.mayWrite : host.mayOpen);

/** A member from before the update that this host has not bound to a Tailscale node. */
// The roster entry decides: the scan fills `device.nodeId` even while the server still refuses it.
const isUnbound = (device: TailnetDevice) =>
  isLiveMember(device.member) && device.member.nodeId === null;

const inNetwork = (host: DeviceNetworkHost) => isLiveMember(host.snapshot?.selfMember);

const listsAsMember = (host: DeviceNetworkHost, environmentId: EnvironmentId) =>
  host.snapshot?.devices.some(
    (device) => device.environmentId === environmentId && isLiveMember(device.member),
  ) === true;

/**
 * Two hosts are one network when each lists the other as a member that is not revoked, or when
 * this client is the same app of the network on both.
 */
function sameNetwork(a: DeviceNetworkHost, b: DeviceNetworkHost): boolean {
  if (!inNetwork(a) || !inNetwork(b)) return false;
  if (listsAsMember(a, b.environmentId) && listsAsMember(b, a.environmentId)) return true;
  const appId = a.snapshot?.callerAppId ?? null;
  return appId !== null && appId === (b.snapshot?.callerAppId ?? null);
}

const compareHlc = (a: NetworkMember["updatedAt"], b: NetworkMember["updatedAt"]) =>
  a.wallMs - b.wallMs || a.counter - b.counter || a.node.localeCompare(b.node);

const newer = <T extends { readonly updatedAt: NetworkMember["updatedAt"] }>(a: T | null, b: T) =>
  a === null || compareHlc(b.updatedAt, a.updatedAt) > 0 ? b : a;

/** Hosts split into networks; a host with no snapshot joins a network that lists it. */
function groupHosts(hosts: ReadonlyArray<DeviceNetworkHost>) {
  const parent = new Map(hosts.map((host) => [host.environmentId, host.environmentId] as const));
  const find = (id: EnvironmentId): EnvironmentId => {
    const up = parent.get(id) ?? id;
    return up === id ? id : find(up);
  };
  const union = (a: EnvironmentId, b: EnvironmentId) => parent.set(find(a), find(b));
  for (const [index, a] of hosts.entries()) {
    for (const b of hosts.slice(index + 1)) {
      if (sameNetwork(a, b)) union(a.environmentId, b.environmentId);
    }
  }
  for (const host of hosts) {
    if (host.snapshot !== null) continue;
    const lister = hosts.find(
      (other) => other !== host && inNetwork(other) && listsAsMember(other, host.environmentId),
    );
    if (lister !== undefined) union(host.environmentId, lister.environmentId);
  }
  const groups = new Map<EnvironmentId, Array<DeviceNetworkHost>>();
  for (const host of hosts) {
    const root = find(host.environmentId);
    groups.set(root, [...(groups.get(root) ?? []), host]);
  }
  return [...groups.values()];
}

/**
 * Whether a host may add, narrow, revoke or restore: it is a full-access member, or no network
 * exists yet, so adding a machine starts one with this host at full access.
 */
export function canManageNetwork(
  snapshot: Pick<TailnetDevicesSnapshot, "selfMember" | "devices">,
): boolean {
  if (snapshot.selfMember !== null) return snapshot.selfMember.access === "full-access";
  return snapshot.devices.every((device) => device.member === null);
}

/** Any switched-on full-access host this client may write to, the preferred one first. */
function chooseAuthority(
  hosts: ReadonlyArray<DeviceNetworkHost>,
  preferred: EnvironmentId | null,
): EnvironmentId | null {
  const candidates = hosts.filter(
    (host) =>
      host.mayWrite && host.enabled && host.snapshot !== null && canManageNetwork(host.snapshot),
  );
  return (
    candidates.find((host) => host.environmentId === preferred)?.environmentId ??
    candidates[0]?.environmentId ??
    null
  );
}

const STATUS_RANK: Record<TailnetDeviceStatus, number> = { online: 2, offline: 1, revoked: 0 };

/** The environment a machine's row shows: the connected one, then online, then a live member. */
const compareCurrent = (a: MachineEntry, b: MachineEntry) =>
  Number(b.isHost) - Number(a.isHost) ||
  STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
  Number(isLiveMember(b.member)) - Number(isLiveMember(a.member)) ||
  (b.lastSeenAt === null ? 0 : DateTime.toEpochMillis(b.lastSeenAt)) -
    (a.lastSeenAt === null ? 0 : DateTime.toEpochMillis(a.lastSeenAt)) ||
  a.environmentId.localeCompare(b.environmentId);

const kindOf = (entry: MachineEntry): MachineKind | null => {
  if (entry.member !== null) return "member";
  if (entry.links.length > 0 || entry.views.some((view) => view.device.access !== null)) {
    return "linked";
  }
  // Only a machine with an address can be proven and added.
  return entry.urls.length > 0 ? "found" : null;
};

const KIND_ORDER: Record<MachineKind, number> = { member: 0, linked: 1, found: 2 };

function groupMachines(
  hosts: ReadonlyArray<DeviceNetworkHost>,
  savedEnvironmentIds: ReadonlySet<EnvironmentId>,
): Array<DeviceNetworkMachine> {
  type Draft = {
    -readonly [K in keyof MachineEntry]: MachineEntry[K] extends ReadonlyArray<infer T>
      ? Array<T>
      : MachineEntry[K];
  };
  const entries = new Map<EnvironmentId, Draft>();
  const entry = (environmentId: EnvironmentId, label: string): Draft => {
    const existing = entries.get(environmentId);
    if (existing !== undefined) return existing;
    const created: Draft = {
      environmentId,
      label,
      nodeId: null,
      member: null,
      status: "offline",
      urls: [],
      tailnetName: null,
      lastSeenAt: null,
      isHost: false,
      views: [],
      links: [],
      savedInApp: savedEnvironmentIds.has(environmentId),
    };
    entries.set(environmentId, created);
    return created;
  };
  const takeMember = (draft: Draft, member: NetworkMember | null) => {
    if (member === null) return;
    draft.member = newer(draft.member, member);
    draft.label = draft.member.label;
    draft.nodeId ??= member.nodeId;
  };
  for (const host of hosts) {
    const self = host.snapshot?.selfMember ?? null;
    if (self !== null) {
      const draft = entry(host.environmentId, host.label);
      draft.isHost = true;
      draft.status = self.access === "revoked" ? "revoked" : "online";
      draft.urls = draft.urls.length > 0 ? draft.urls : [...(host.snapshot?.self.urls ?? [])];
      takeMember(draft, self);
    }
    for (const device of host.snapshot?.devices ?? []) {
      const draft = entry(device.environmentId, device.label);
      draft.views.push({ host: host.environmentId, device });
      takeMember(draft, device.member);
      draft.nodeId ??= device.nodeId;
      draft.tailnetName ??= device.tailnetName;
      if (draft.urls.length === 0) draft.urls = [...device.urls];
      if (!draft.isHost && STATUS_RANK[device.status] > STATUS_RANK[draft.status]) {
        draft.status = device.status;
      }
      if (
        device.lastSeenAt !== null &&
        (draft.lastSeenAt === null || DateTime.isGreaterThan(device.lastSeenAt, draft.lastSeenAt))
      ) {
        draft.lastSeenAt = device.lastSeenAt;
      }
    }
    for (const link of host.links) {
      const draft = entry(link.environmentId, link.label);
      draft.links.push({ host: host.environmentId, link });
      if (draft.urls.length === 0) draft.urls = [...link.urls];
    }
  }
  for (const draft of entries.values()) {
    // A revoked roster entry wins over a host still seeing it online.
    if (draft.member?.access === "revoked") draft.status = "revoked";
  }
  const byNode = new Map<string, Array<MachineEntry>>();
  for (const draft of entries.values()) {
    const key = draft.nodeId ?? draft.environmentId;
    byNode.set(key, [...(byNode.get(key) ?? []), draft]);
  }
  const machines: Array<DeviceNetworkMachine> = [];
  for (const [key, group] of byNode) {
    const [current, ...others] = [...group].sort(compareCurrent);
    if (current === undefined) continue;
    const kind = kindOf(current);
    if (kind === null) continue;
    machines.push({ key, kind, entry: current, others });
  }
  return machines.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      Number(b.entry.isHost) - Number(a.entry.isHost) ||
      a.entry.label.localeCompare(b.entry.label),
  );
}

function mergeApps(hosts: ReadonlyArray<DeviceNetworkHost>): Array<NetworkApp> {
  const apps = new Map<string, NetworkApp>();
  for (const host of hosts) {
    for (const app of host.snapshot?.apps ?? []) {
      apps.set(app.appId, newer(apps.get(app.appId) ?? null, app));
    }
  }
  return [...apps.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The Device network as one view: a group per network the connected hosts are in, then one per
 * host in no network. A machine already in a shown network is not offered to a lone host, which
 * could not add it anyway.
 */
export function deviceNetworkView(input: {
  readonly hosts: ReadonlyArray<DeviceNetworkHost>;
  readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
  /** The host this client already works through, preferred as the authority. */
  readonly preferredHost: EnvironmentId | null;
}): ReadonlyArray<DeviceNetworkGroup> {
  const groups = groupHosts(input.hosts).map((hosts): DeviceNetworkGroup => {
    const ordered = [...hosts].sort(
      (a, b) =>
        Number(b.environmentId === input.preferredHost) -
          Number(a.environmentId === input.preferredHost) || a.label.localeCompare(b.label),
    );
    return {
      key: ordered
        .map((host) => host.environmentId)
        .sort()
        .join(","),
      inNetwork: ordered.some(inNetwork),
      hosts: ordered,
      authority: chooseAuthority(ordered, input.preferredHost),
      machines: groupMachines(ordered, input.savedEnvironmentIds),
      apps: mergeApps(ordered),
    };
  });
  const claimed = new Set(
    groups.flatMap((group) =>
      group.inNetwork
        ? group.machines.flatMap((machine) =>
            machine.kind === "member" && isLiveMember(machine.entry.member)
              ? [machine.key, machine.entry.environmentId]
              : [],
          )
        : [],
    ),
  );
  return groups
    .map((group) =>
      group.inNetwork
        ? group
        : {
            ...group,
            machines: group.machines.filter(
              (machine) =>
                machine.kind !== "found" ||
                !(claimed.has(machine.key) || claimed.has(machine.entry.environmentId)),
            ),
          },
    )
    .sort(
      (a, b) =>
        Number(b.inNetwork) - Number(a.inNetwork) ||
        Number(b.hosts.some((host) => host.environmentId === input.preferredHost)) -
          Number(a.hosts.some((host) => host.environmentId === input.preferredHost)),
    );
}

export interface MachineControls {
  readonly open: boolean;
  /** Narrow or widen it on every machine, through the authority. */
  readonly changeAccess: boolean;
  readonly revoke: boolean;
  readonly restore: boolean;
  /** Found: add it to the network, or link it to the authority only. */
  readonly add: boolean;
  readonly linkHere: boolean;
  /** Linked to one host only: add it to the network. */
  readonly promote: boolean;
  /** A member from before the update that a host has not bound to a Tailscale node yet. */
  readonly needsReadd: boolean;
  /** It left the network itself. */
  readonly left: boolean;
  /** Unbound or left: add it again through the authority, once it allows joining. */
  readonly readd: boolean;
  /** Hosts that forget it, the authority first. A member is revoked everywhere first. */
  readonly forgetHosts: ReadonlyArray<EnvironmentId>;
  /** Hosts that may keep a limit of their own for it. */
  readonly limitHosts: ReadonlyArray<EnvironmentId>;
}

/** Hosts in the group this client may write to that list `entry`, `first` leading. */
export function hostsListing(
  group: DeviceNetworkGroup,
  entry: MachineEntry,
  first: EnvironmentId | null,
): ReadonlyArray<EnvironmentId> {
  const listing = new Set([
    ...entry.views.map((view) => view.host),
    ...entry.links.map((link) => link.host),
  ]);
  const writable = group.hosts
    .filter((host) => host.mayWrite && listing.has(host.environmentId))
    .map((host) => host.environmentId);
  return first !== null && writable.includes(first)
    ? [first, ...writable.filter((id) => id !== first)]
    : writable;
}

/** Which controls a machine's row offers, given the group's authority. */
export function machineControls(
  machine: DeviceNetworkMachine,
  group: DeviceNetworkGroup,
): MachineControls {
  const { entry } = machine;
  const { authority } = group;
  const member = machine.kind === "member";
  // The server refuses a member it holds no node for until it is added again.
  const needsReadd =
    member && isLiveMember(entry.member) && entry.views.some((view) => isUnbound(view.device));
  const left = member && hasLeft(entry.member);
  const live = member && isLiveMember(entry.member) && !needsReadd;
  const manages = authority !== null && authority !== entry.environmentId;
  const forgetHosts = member
    ? manages
      ? [authority, ...hostsListing(group, entry, null).filter((id) => id !== authority)]
      : []
    : hostsListing(group, entry, authority);
  return {
    open: live && !entry.isHost && !entry.savedInApp && group.hosts.some(opensThrough),
    changeAccess: live && manages,
    revoke: live && manages,
    restore: member && !live && !needsReadd && !left && manages,
    add: machine.kind === "found" && authority !== null,
    linkHere: machine.kind === "found" && authority !== null,
    promote: machine.kind === "linked" && authority !== null,
    needsReadd,
    left,
    readd: (needsReadd || left) && manages,
    forgetHosts,
    limitHosts: live
      ? group.hosts
          .filter(
            (host) =>
              host.mayWrite && inNetwork(host) && host.environmentId !== entry.environmentId,
          )
          .map((host) => host.environmentId)
      : [],
  };
}

const narrowsToReadOnly = (access: TailnetDeviceAccess | null | undefined) =>
  access != null && access !== "full-access";

/**
 * What opening a member gives this app: the narrowest of the app's level, the relaying machine's
 * roster level, and the target's own limit for that machine, which is known only while this app
 * is connected to the target. Unknown never reads as full.
 */
export function openAccessHint(
  machine: DeviceNetworkMachine,
  group: DeviceNetworkGroup,
): "full" | "read-only" | "unknown" | null {
  const relays = group.hosts.filter(opensThrough);
  if (relays.length === 0) return null;
  const hints = relays.map((relay) => {
    const appId = relay.snapshot?.callerAppId ?? null;
    const appAccess =
      appId === null ? null : group.apps.find((candidate) => candidate.appId === appId)?.access;
    const limit = machine.entry.isHost
      ? undefined
      : group.hosts
          .find((host) => host.environmentId === machine.entry.environmentId)
          ?.snapshot?.devices.find((device) => device.environmentId === relay.environmentId)
          ?.localLimit;
    if (
      narrowsToReadOnly(appAccess) ||
      narrowsToReadOnly(relay.snapshot?.selfMember?.access) ||
      narrowsToReadOnly(limit)
    ) {
      return "read-only" as const;
    }
    return limit === undefined ? ("unknown" as const) : ("full" as const);
  });
  return hints.every((hint) => hint === hints[0]) ? (hints[0] ?? null) : "unknown";
}

/** Another environment on the same node can be forgotten unless it is a connected host. */
export const canForgetOther = (group: DeviceNetworkGroup, other: MachineEntry) =>
  !other.isHost &&
  (other.member === null
    ? hostsListing(group, other, group.authority).length > 0
    : group.authority !== null);

export interface HostControls {
  readonly leave: boolean;
  /** The server refuses: it is the last full-access machine and other members remain. */
  readonly leaveBlocked: boolean;
  /** It is the network's only full-access machine: leaving leaves nobody to change the network. */
  readonly lastFullAccess: boolean;
  readonly allowJoin: boolean;
  /** While in the future, a member of a network may add it. */
  readonly joinOpenUntil: DateTime.Utc | null;
}

/** What a host's line in "Taking part" offers. */
export function hostControls(host: DeviceNetworkHost, now: DateTime.Utc): HostControls {
  const self = host.snapshot?.selfMember ?? null;
  const live = isLiveMember(self);
  const others = (host.snapshot?.devices ?? []).filter((device) => isLiveMember(device.member));
  const lastFullAccess =
    live &&
    self.access === "full-access" &&
    !others.some((device) => device.member?.access === "full-access");
  const leaveBlocked = lastFullAccess && others.length > 0;
  const openUntil = host.snapshot?.joinOpenUntil ?? null;
  return {
    leave: host.mayWrite && live && !leaveBlocked,
    leaveBlocked: host.mayWrite && leaveBlocked,
    lastFullAccess,
    // Re-adding a member left unbound by the update needs consent on this side too.
    allowJoin: host.mayWrite && host.snapshot !== null && (!live || others.some(isUnbound)),
    joinOpenUntil: openUntil !== null && DateTime.isGreaterThan(openUntil, now) ? openUntil : null,
  };
}

export interface AppControls {
  /** Levels below its own: each signs it out everywhere. */
  readonly narrowTo: ReadonlyArray<NetworkAppAccess>;
  /** More access only comes from pairing again, which replaces this app everywhere. */
  readonly pairAgain: boolean;
  readonly forget: boolean;
}

const NARROWER: Record<NetworkAppAccess, ReadonlyArray<NetworkAppAccess>> = {
  "full-access": ["read-only", "revoked"],
  "read-only": ["revoked"],
  revoked: [],
};

/** The server refuses widening an app in place, so only narrowing is a level change. */
export function appControls(app: NetworkApp, authority: EnvironmentId | null): AppControls {
  const level = appAccessLevel(app.access);
  return {
    narrowTo: authority === null ? [] : NARROWER[level],
    pairAgain: authority !== null && level !== "full-access",
    forget: authority !== null && level === "revoked",
  };
}

/** The machine's own reason for refusing a Device network change, which says what to do. */
export function networkFailureMessage(failure: unknown): string {
  if (typeof failure === "object" && failure !== null && "_tag" in failure) {
    if (
      failure._tag === "TailnetDevicesError" &&
      "message" in failure &&
      typeof failure.message === "string" &&
      failure.message.trim() !== ""
    ) {
      return failure.message;
    }
    if (failure._tag === "EnvironmentAuthorizationError") {
      return "This app may not make that change on that machine.";
    }
  }
  return "Check that the machines are online, then try again.";
}

/** Apps are full access or read-only: below full access, an app's sessions are read-only. */
export const appAccessLevel = (access: TailnetDeviceAccess): NetworkAppAccess =>
  access === "revoked" || access === "full-access" ? access : "read-only";

/**
 * Whether listing failed because this session may not see devices, which hides
 * the rows, rather than because the server cannot list them yet (older or not
 * yet updated servers), which the UI reports as unavailable.
 */
export function isTailnetDevicesForbidden(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) return false;
  return (
    failure._tag === "EnvironmentAuthorizationError" ||
    (failure._tag === "TailnetDevicesError" &&
      "reason" in failure &&
      failure.reason === "forbidden")
  );
}
