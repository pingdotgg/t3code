/**
 * The Device network a client shows, merged from every connected host. There is one network: a
 * machine any host lists as a live member is a member, and every other Ada machine a host found
 * on the tailnet is offered once, to allow. Writes go through one chosen authority.
 */
import type {
  EnvironmentId,
  NetworkApp,
  NetworkAppAccess,
  NetworkMember,
  TailnetDevice,
  TailnetDeviceAccess,
  TailnetDeviceStatus,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import { compareNetworkApps, compareNetworkMembers } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  type NetworkMemberRecord,
  type NetworkMemberStatus,
  openingHosts,
} from "./connection/networkMembers.ts";

/** A connected environment that offers the network, as this client sees it. */
export interface DeviceNetworkHost {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Its Device network switch. */
  readonly enabled: boolean;
  /** Null while loading, or when the host cannot list devices. */
  readonly snapshot: TailnetDevicesSnapshot | null;
  /** This client's session there may change access (`access:write`). */
  readonly mayWrite: boolean;
}

/** `networkMembers.statusAtom`: what this app holds of each member the network listed to it. */
export type DeviceNetworkMemberStatuses = ReadonlyMap<
  EnvironmentId,
  {
    readonly record: Pick<NetworkMemberRecord, "sessionExpiresAt" | "left">;
    readonly status: NetworkMemberStatus;
  }
>;

/**
 * How this app holds a machine: open; its session refused, with a connected host that can open
 * it again, none while agent links are paused, or none; or left the network by its own act, kept
 * until its session ends.
 */
export type InApp =
  | { readonly kind: "open" }
  | { readonly kind: "reopen" }
  | { readonly kind: "paused" }
  | { readonly kind: "refused"; readonly left: boolean }
  | { readonly kind: "left"; readonly until: DateTime.Utc | null };

/** One environment, merged from what every connected host says about it. */
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
  /** This client is connected to it. */
  readonly isHost: boolean;
  /** How each host sees it. */
  readonly views: ReadonlyArray<{ readonly host: EnvironmentId; readonly device: TailnetDevice }>;
  /** Null while this app does not hold it. */
  readonly inApp: InApp | null;
}

/** In the network, or an Ada machine found on the tailnet that nobody has allowed yet. */
export type MachineKind = "member" | "found";

export interface DeviceNetworkMachine {
  /** Its environment id. */
  readonly key: string;
  readonly kind: MachineKind;
  readonly entry: MachineEntry;
}

export interface DeviceNetwork {
  /** Some connected host is a member; otherwise allowing a machine starts the network. */
  readonly inNetwork: boolean;
  readonly hosts: ReadonlyArray<DeviceNetworkHost>;
  /** The host every network write goes through, or null when none here may write. */
  readonly authority: EnvironmentId | null;
  /** Members first, then machines found and not yet allowed. */
  readonly machines: ReadonlyArray<DeviceNetworkMachine>;
  readonly apps: ReadonlyArray<NetworkApp>;
}

const isLiveMember = (member: NetworkMember | null | undefined): member is NetworkMember =>
  member != null && member.access !== "revoked";

/** The hosts `networkMembers.open` asks, by the roster's one rule (`openingHosts`). */
const openers = (hosts: ReadonlyArray<DeviceNetworkHost>) => {
  const ids = new Set(
    openingHosts(
      hosts.flatMap((host) =>
        host.snapshot === null ? [] : [{ host: host.environmentId, roster: host.snapshot }],
      ),
      (id) => hosts.some((host) => host.environmentId === id && host.mayWrite),
    ).map((opener) => opener.host),
  );
  return hosts.filter((host) => ids.has(host.environmentId));
};

const inAppOf = (
  environmentId: EnvironmentId,
  saved: ReadonlySet<EnvironmentId>,
  statuses: DeviceNetworkMemberStatuses,
): InApp | null => {
  const held = statuses.get(environmentId);
  if (held?.status === "left") {
    const until = held.record.sessionExpiresAt;
    return { kind: "left", until: until === undefined ? null : DateTime.makeUnsafe(until) };
  }
  if (!saved.has(environmentId)) return null;
  switch (held?.status) {
    case "connecting":
    case "retrying":
    case "reopen":
      return { kind: "reopen" };
    case "paused":
      return { kind: "paused" };
    case "refused":
      return { kind: "refused", left: held.record.left === true };
    default:
      return { kind: "open" };
  }
};

const inNetwork = (host: DeviceNetworkHost) => isLiveMember(host.snapshot?.selfMember);

/** The entry that wins under the order the servers merge by. */
const winner = <T>(a: T | null, b: T, compare: (a: T, b: T) => number) =>
  a === null || compare(b, a) > 0 ? b : a;

/**
 * Whether a host may allow, narrow or remove machines: it is a full-access member, or it is in no
 * network yet, so allowing a machine starts or joins one.
 */
export function canManageNetwork(
  snapshot: Pick<TailnetDevicesSnapshot, "selfMember" | "devices">,
): boolean {
  if (snapshot.selfMember !== null) return snapshot.selfMember.access === "full-access";
  // Tombstones alone are no network.
  return !snapshot.devices.some((device) => isLiveMember(device.member));
}

/** A switched-on host this client may write to: a full-access member first, the preferred first. */
function chooseAuthority(
  hosts: ReadonlyArray<DeviceNetworkHost>,
  preferred: EnvironmentId | null,
): EnvironmentId | null {
  const writers = hosts.filter(
    (host) =>
      host.mayWrite && host.enabled && host.snapshot !== null && canManageNetwork(host.snapshot),
  );
  const pick = (from: ReadonlyArray<DeviceNetworkHost>) =>
    from.find((host) => host.environmentId === preferred) ?? from[0];
  return (pick(writers.filter(inNetwork)) ?? pick(writers))?.environmentId ?? null;
}

const STATUS_RANK: Record<TailnetDeviceStatus, number> = { online: 2, offline: 1, revoked: 0 };

const KIND_ORDER: Record<MachineKind, number> = { member: 0, found: 1 };

function mergeMachines(
  hosts: ReadonlyArray<DeviceNetworkHost>,
  savedEnvironmentIds: ReadonlySet<EnvironmentId>,
  memberStatuses: DeviceNetworkMemberStatuses,
): Array<DeviceNetworkMachine> {
  type Draft = {
    -readonly [K in keyof MachineEntry]: MachineEntry[K] extends ReadonlyArray<infer T>
      ? Array<T>
      : MachineEntry[K];
  } & { online: boolean };
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
      inApp: inAppOf(environmentId, savedEnvironmentIds, memberStatuses),
      online: false,
    };
    entries.set(environmentId, created);
    return created;
  };
  const takeMember = (draft: Draft, member: NetworkMember | null) => {
    if (member === null) return;
    draft.member = winner(draft.member, member, compareNetworkMembers);
    // A roster entry named before its machine was known carries its bare id.
    if (draft.member.label !== draft.environmentId) draft.label = draft.member.label;
    draft.nodeId ??= member.nodeId;
  };
  for (const host of hosts) {
    if (host.snapshot !== null) {
      const draft = entry(host.environmentId, host.label);
      draft.isHost = true;
      draft.online = true;
      draft.urls = draft.urls.length > 0 ? draft.urls : [...host.snapshot.self.urls];
      takeMember(draft, host.snapshot.selfMember);
    }
    for (const device of host.snapshot?.devices ?? []) {
      const draft = entry(device.environmentId, device.label);
      draft.views.push({ host: host.environmentId, device });
      takeMember(draft, device.member);
      draft.nodeId ??= device.nodeId;
      draft.tailnetName ??= device.tailnetName;
      if (draft.urls.length === 0) draft.urls = [...device.urls];
      if (device.status === "online") draft.online = true;
      if (
        device.lastSeenAt !== null &&
        (draft.lastSeenAt === null || DateTime.isGreaterThan(device.lastSeenAt, draft.lastSeenAt))
      ) {
        draft.lastSeenAt = device.lastSeenAt;
      }
    }
  }
  const all = [...entries.values()].map(({ online, ...draft }) => {
    const status: TailnetDeviceStatus = online
      ? "online"
      : draft.member?.access === "revoked"
        ? "revoked"
        : "offline";
    return { ...draft, status };
  });
  // Environments on one Tailscale node are one machine: an earlier install that no longer
  // answers is not listed beside the one that does.
  const answering = new Set(
    all.flatMap((draft) =>
      draft.nodeId !== null && (draft.isHost || draft.status === "online") ? [draft.nodeId] : [],
    ),
  );
  const machines: Array<DeviceNetworkMachine> = [];
  for (const draft of all) {
    const live = isLiveMember(draft.member);
    const here = draft.isHost || draft.status === "online";
    if (!here && draft.nodeId !== null && answering.has(draft.nodeId)) continue;
    const allowable = here && draft.urls.length > 0 && draft.views.length > 0;
    // A member bound to no node (an update left it so) that this app does not already hold is
    // opened by nothing until allowed again.
    const unbound =
      !draft.isHost && draft.inApp === null && draft.member?.nodeId === null && allowable;
    if (live && !unbound) {
      machines.push({ key: draft.environmentId, kind: "member", entry: draft });
      continue;
    }
    // Found: it answers on the tailnet now and can be proven there. A revoked machine that
    // still answers is offered the same way; one that does not is not listed.
    if (allowable) {
      machines.push({ key: draft.environmentId, kind: "found", entry: draft });
    }
  }
  return machines.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      Number(b.entry.isHost) - Number(a.entry.isHost) ||
      STATUS_RANK[b.entry.status] - STATUS_RANK[a.entry.status] ||
      a.entry.label.localeCompare(b.entry.label) ||
      a.entry.environmentId.localeCompare(b.entry.environmentId),
  );
}

function mergeApps(hosts: ReadonlyArray<DeviceNetworkHost>): Array<NetworkApp> {
  const apps = new Map<string, NetworkApp>();
  for (const host of hosts) {
    for (const app of host.snapshot?.apps ?? []) {
      apps.set(app.appId, winner(apps.get(app.appId) ?? null, app, compareNetworkApps));
    }
  }
  return [...apps.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The Device network as one view, whatever each connected host's roster holds so far. */
export function deviceNetworkView(input: {
  readonly hosts: ReadonlyArray<DeviceNetworkHost>;
  readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly memberStatuses: DeviceNetworkMemberStatuses;
  /** The host this client already works through, preferred as the authority. */
  readonly preferredHost: EnvironmentId | null;
}): DeviceNetwork {
  const hosts = [...input.hosts].sort(
    (a, b) =>
      Number(b.environmentId === input.preferredHost) -
        Number(a.environmentId === input.preferredHost) || a.label.localeCompare(b.label),
  );
  return {
    inNetwork: hosts.some(inNetwork),
    hosts,
    authority: chooseAuthority(hosts, input.preferredHost),
    machines: mergeMachines(hosts, input.savedEnvironmentIds, input.memberStatuses),
    apps: mergeApps(hosts),
  };
}

export interface MachineControls {
  readonly open: boolean;
  /** Found: allow it into the network, through `via`. */
  readonly allow: boolean;
  /** Narrow or widen a member on every machine. */
  readonly changeAccess: boolean;
  /** Take a member out of the network everywhere. */
  readonly remove: boolean;
  /** The host the write goes through: the authority, or another writer when it is the target. */
  readonly via: EnvironmentId | null;
  /** Hosts that may keep a limit of their own for it. */
  readonly limitHosts: ReadonlyArray<EnvironmentId>;
}

/** Which controls a machine's row offers. */
export function machineControls(
  machine: DeviceNetworkMachine,
  network: DeviceNetwork,
): MachineControls {
  const { entry } = machine;
  const member = machine.kind === "member";
  // A machine never changes its own entry, so its row goes through another writer.
  const via =
    network.authority !== entry.environmentId
      ? network.authority
      : (network.hosts.find(
          (host) =>
            host.environmentId !== entry.environmentId &&
            host.mayWrite &&
            host.enabled &&
            host.snapshot !== null &&
            canManageNetwork(host.snapshot),
        )?.environmentId ?? null);
  const opensHere =
    entry.inApp === null ? openers(network.hosts).length > 0 : entry.inApp.kind === "reopen";
  return {
    open: member && !entry.isHost && opensHere,
    allow: !member && via !== null,
    changeAccess: member && via !== null,
    remove: member && via !== null,
    via,
    limitHosts: member
      ? network.hosts
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
  network: DeviceNetwork,
): "full" | "read-only" | "unknown" | null {
  const relays = openers(network.hosts);
  if (relays.length === 0) return null;
  const hints = relays.map((relay) => {
    const appId = relay.snapshot?.callerAppId ?? null;
    const appAccess =
      appId === null ? null : network.apps.find((candidate) => candidate.appId === appId)?.access;
    const limit = machine.entry.isHost
      ? undefined
      : network.hosts
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

export interface HostControls {
  readonly leave: boolean;
  /** The server refuses: it is the last full-access machine and other members remain. */
  readonly leaveBlocked: boolean;
  /** It is the network's only full-access machine: leaving leaves nobody to change the network. */
  readonly lastFullAccess: boolean;
}

/** What a connected host's own row offers. */
export function hostControls(host: DeviceNetworkHost): HostControls {
  const self = host.snapshot?.selfMember ?? null;
  const live = isLiveMember(self);
  const others = (host.snapshot?.devices ?? []).filter((device) => isLiveMember(device.member));
  const lastFullAccess =
    live &&
    self.access === "full-access" &&
    !others.some((device) => device.member?.access === "full-access");
  const leaveBlocked = lastFullAccess && others.length > 0;
  return {
    leave: host.mayWrite && live && !leaveBlocked,
    leaveBlocked: host.mayWrite && leaveBlocked,
    lastFullAccess,
  };
}

export interface AppControls {
  /** Levels below its own: each signs it out everywhere. */
  readonly narrowTo: ReadonlyArray<NetworkAppAccess>;
  /** More access only comes from pairing again, which replaces this app everywhere. */
  readonly pairAgain: boolean;
  /** The authority no longer lists it, so a new pairing link adds it as a new app. */
  readonly pairAsNew: boolean;
  readonly forget: boolean;
}

const NARROWER: Record<NetworkAppAccess, ReadonlyArray<NetworkAppAccess>> = {
  "full-access": ["read-only", "revoked"],
  "read-only": ["revoked"],
  revoked: [],
};

/** The server refuses widening an app in place, so only narrowing is a level change. */
export function appControls(app: NetworkApp, network: DeviceNetwork): AppControls {
  const { authority } = network;
  const level = appAccessLevel(app.access);
  // The server replaces only an app it still lists; a replaced or forgotten one pairs as new.
  const listed =
    network.hosts
      .find((host) => host.environmentId === authority)
      ?.snapshot?.apps.some((candidate) => candidate.appId === app.appId) === true;
  const widens = authority !== null && level !== "full-access";
  return {
    narrowTo: authority === null ? [] : NARROWER[level],
    pairAgain: widens && listed,
    pairAsNew: widens && !listed,
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
