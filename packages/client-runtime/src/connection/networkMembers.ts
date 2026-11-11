import {
  EnvironmentId,
  type NetworkApp,
  type NetworkMember,
  type TailnetDeviceClientCredential,
  type TailnetDevicesSnapshot,
  compareNetworkApps,
  compareNetworkMembers,
  hasLeftNetwork,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

/**
 * A machine of the user's network that this client keeps because a member it is connected to
 * listed it, not because the user saved it. It is opened (minted a credential and saved) only on
 * demand, and it goes away when the network revokes it or no member lists it any more.
 */
export const NetworkMemberRecord = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** A member that lists it, and the first one asked to open it. */
  via: EnvironmentId,
  /** This client's app id in the network that listed it. Absent on records saved before it. */
  appId: Schema.optionalKey(Schema.String),
  /** The app id its saved credential was minted under; absent when opened without one. */
  openedAs: Schema.optionalKey(Schema.String),
  /** When the session it was opened with ends (epoch ms). Nothing extends a session. */
  sessionExpiresAt: Schema.optionalKey(Schema.Number),
  /**
   * It left the network by its own act. Its kept session lasts until `sessionExpiresAt`; it is
   * never renewed or forgotten, and is managed again once a followed network lists it live.
   */
  left: Schema.optionalKey(Schema.Literal(true)),
});
export type NetworkMemberRecord = typeof NetworkMemberRecord.Type;

/** What one member reports about the network. */
export type NetworkRoster = Pick<
  TailnetDevicesSnapshot,
  "selfMember" | "devices" | "apps" | "enabled" | "callerAppId"
>;

/** What one connected member said about the network. */
export interface NetworkRosterReport {
  readonly host: EnvironmentId;
  readonly roster: NetworkRoster;
}

const isLive = (member: NetworkMember | null): member is NetworkMember =>
  member !== null && member.access !== "revoked";

/** Each app id's winning entry across hosts that take part, in the servers' merge order. */
function newestApps(reports: ReadonlyArray<NetworkRosterReport>): ReadonlyMap<string, NetworkApp> {
  const apps = new Map<string, NetworkApp>();
  for (const { roster } of reports) {
    if (!roster.enabled) continue;
    for (const app of roster.apps) {
      const current = apps.get(app.appId);
      if (current === undefined || compareNetworkApps(app, current) > 0) apps.set(app.appId, app);
    }
  }
  return apps;
}

/** This client's app id on `roster`'s host, when the host is in a network that still takes it. */
function callerAppIdOf(
  roster: NetworkRoster,
  apps: ReadonlyMap<string, NetworkApp>,
): string | null {
  const appId = roster.callerAppId;
  if (!roster.enabled || appId === null || !isLive(roster.selfMember)) return null;
  const app = apps.get(appId);
  return app !== undefined && app.access !== "revoked" ? appId : null;
}

/** One network this client follows: the app id its hosts take it by, and their reports. */
export interface FollowedNetwork {
  readonly appId: string;
  readonly reports: ReadonlyArray<NetworkRosterReport>;
}

/**
 * Every network that still takes this client, by app id, smallest first: an app paired through
 * two invitations follows both. A host reporting no app id, or one revoked in its network,
 * contributes nothing, and each network's records follow only its own hosts.
 */
export function followedNetworks(
  reports: ReadonlyArray<NetworkRosterReport>,
): ReadonlyArray<FollowedNetwork> {
  const apps = newestApps(reports);
  const networks = new Map<string, Array<NetworkRosterReport>>();
  for (const report of reports) {
    const appId = callerAppIdOf(report.roster, apps);
    if (appId === null) continue;
    const hosts = networks.get(appId);
    if (hosts === undefined) networks.set(appId, [report]);
    else hosts.push(report);
  }
  return [...networks]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([appId, hostReports]) => ({ appId, reports: hostReports }));
}

/**
 * The hosts asked to open a member: those of the followed networks, then any other connected
 * host in a network whose session carries no app id (the desktop app, a code-paired browser) and
 * may write there, which is what the server requires of such a session.
 */
export function openingHosts(
  reports: ReadonlyArray<NetworkRosterReport>,
  mayWrite: (host: EnvironmentId) => boolean,
): ReadonlyArray<OpeningHost> {
  const followed = followedNetworks(reports).flatMap((network) =>
    network.reports.map((report) => ({ host: report.host, appId: network.appId })),
  );
  const writers = reports.flatMap(({ host, roster }) =>
    roster.enabled && roster.callerAppId === null && isLive(roster.selfMember) && mayWrite(host)
      ? [{ host, appId: null }]
      : [],
  );
  return [...followed, ...writers].filter(
    (candidate, index, all) => all.findIndex((other) => other.host === candidate.host) === index,
  );
}

/** A connected host that may open members, and this client's app id there (null for none). */
export interface OpeningHost {
  readonly host: EnvironmentId;
  readonly appId: string | null;
}

/** Live members no machine can open yet: from before the update and not bound to a node. */
export function unboundMembers(
  reports: ReadonlyArray<NetworkRosterReport>,
): ReadonlySet<EnvironmentId> {
  const unbound = new Set<EnvironmentId>();
  for (const network of followedNetworks(reports)) {
    for (const [environmentId, entry] of networkView(network.reports).newest) {
      if (isLive(entry) && entry.nodeId === null) unbound.add(environmentId);
    }
  }
  return unbound;
}

interface NetworkView {
  readonly hosts: ReadonlySet<EnvironmentId>;
  /** Each member's winning entry across the hosts, as the servers merge them. */
  readonly newest: ReadonlyMap<EnvironmentId, NetworkMember>;
  readonly listed: ReadonlyMap<EnvironmentId, { label: string; hosts: Array<EnvironmentId> }>;
}

function networkView(reports: ReadonlyArray<NetworkRosterReport>): NetworkView {
  const newest = new Map<EnvironmentId, NetworkMember>();
  const offer = (entry: NetworkMember) => {
    const current = newest.get(entry.environmentId);
    if (current === undefined || compareNetworkMembers(entry, current) > 0) {
      newest.set(entry.environmentId, entry);
    }
  };
  const listed = new Map<EnvironmentId, { label: string; hosts: Array<EnvironmentId> }>();
  for (const { host, roster } of reports) {
    if (roster.selfMember !== null) offer(roster.selfMember);
    for (const device of roster.devices) {
      if (device.member === null || device.environmentId === host) continue;
      offer(device.member);
      if (device.member.access === "revoked") continue;
      const entry = listed.get(device.environmentId);
      if (entry === undefined) {
        listed.set(device.environmentId, { label: device.label, hosts: [host] });
      } else {
        entry.hosts.push(host);
      }
    }
  }
  return { hosts: new Set(reports.map((report) => report.host)), newest, listed };
}

/**
 * Records whose app id no followed network takes move to a followed network listing their machine
 * live (tombstones are not membership). The rest go only on a positive signal for their own id: it
 * is revoked, or a host still calling this client by it lists it no more. Silence changes nothing.
 */
function rebindNetwork(
  records: ReadonlyArray<NetworkMemberRecord>,
  reports: ReadonlyArray<NetworkRosterReport>,
  networks: ReadonlyArray<FollowedNetwork>,
): ReadonlyArray<NetworkMemberRecord> {
  const followed = new Set(networks.map((network) => network.appId));
  const stale = new Set(
    records.flatMap((record) =>
      record.appId !== undefined && !followed.has(record.appId) ? [record.appId] : [],
    ),
  );
  if (stale.size === 0) return records;
  const apps = newestApps(reports);
  const live = networks.map((network) => ({
    appId: network.appId,
    members: new Set(
      network.reports.flatMap(({ host, roster }) => [
        ...(isLive(roster.selfMember) ? [host] : []),
        ...roster.devices.flatMap((device) =>
          isLive(device.member) ? [device.environmentId] : [],
        ),
      ]),
    ),
  }));
  const successorOf = (environmentId: EnvironmentId) =>
    live.find((network) => network.members.has(environmentId))?.appId;
  const disowned = new Map<string, ReadonlySet<EnvironmentId>>();
  for (const appId of stale) {
    const entry = apps.get(appId);
    if (entry !== undefined && entry.access !== "revoked") continue;
    const speaking = new Set(
      reports.flatMap((report) =>
        report.roster.enabled && report.roster.callerAppId === appId ? [report.host] : [],
      ),
    );
    if (entry !== undefined || speaking.size > 0) disowned.set(appId, speaking);
  }
  let changed = false;
  const next = records.flatMap((record) => {
    if (record.appId === undefined) {
      const dropped = [...disowned.values()].some((speaking) => speaking.has(record.via));
      changed ||= dropped;
      return dropped ? [] : [record];
    }
    if (!stale.has(record.appId)) return [record];
    const entry = apps.get(record.appId);
    if (entry !== undefined && entry.access !== "revoked") return [record];
    const successor = successorOf(record.environmentId);
    if (successor !== undefined) {
      changed = true;
      return [{ ...record, appId: successor, openedAs: record.openedAs ?? record.appId }];
    }
    if (disowned.has(record.appId)) {
      changed = true;
      return [];
    }
    return [record];
  });
  return changed ? next : records;
}

/**
 * Each followed network decides its own records by the newest entry across its hosts. A record
 * goes on a newest revocation, or when none of its hosts lists it (self counts) and its `via` host
 * omits it. `userSaved` and unbound members never become records. Unchanged returns `records`.
 */
function followRoster(
  records: ReadonlyArray<NetworkMemberRecord>,
  input: {
    readonly networks: ReadonlyArray<FollowedNetwork>;
    readonly saved: ReadonlySet<EnvironmentId>;
    readonly userSaved: ReadonlySet<EnvironmentId>;
  },
): ReadonlyArray<NetworkMemberRecord> {
  const views = input.networks.map((network) => ({
    appId: network.appId,
    view: networkView(network.reports),
  }));
  const revoked = (view: NetworkView, environmentId: EnvironmentId) =>
    view.newest.get(environmentId)?.access === "revoked";
  // Records from before app ids join the network that lists them or holds their host.
  const networkOf = (record: NetworkMemberRecord) =>
    record.appId !== undefined
      ? views.find((candidate) => candidate.appId === record.appId)
      : views.find(
          ({ view }) => view.listed.has(record.environmentId) || view.hosts.has(record.via),
        );
  let changed = false;
  const next: Array<NetworkMemberRecord> = [];
  for (const record of records) {
    const network = networkOf(record);
    if (network === undefined) {
      next.push(record);
      continue;
    }
    const { appId, view } = network;
    const entry = view.listed.get(record.environmentId);
    const newest = view.newest.get(record.environmentId);
    // A member that left keeps the session the server kept for the app that asked it to leave.
    if (newest !== undefined && hasLeftNetwork(newest) && input.saved.has(record.environmentId)) {
      changed ||= record.left !== true;
      next.push(record.left === true ? record : { ...record, left: true });
      continue;
    }
    if (
      revoked(view, record.environmentId) ||
      (entry === undefined &&
        record.left !== true &&
        !view.hosts.has(record.environmentId) &&
        view.hosts.has(record.via))
    ) {
      changed = true;
      continue;
    }
    // Listed live again after leaving: it rejoined, so the network manages it once more.
    const { left: _left, ...rest } = record;
    const updated: NetworkMemberRecord =
      entry === undefined
        ? { ...record, appId }
        : {
            ...rest,
            label: entry.label,
            via: entry.hosts.includes(record.via) ? record.via : entry.hosts[0]!,
            appId,
          };
    if (
      updated.left !== record.left ||
      updated.label !== record.label ||
      updated.via !== record.via ||
      updated.appId !== record.appId
    ) {
      changed = true;
      next.push(updated);
    } else {
      next.push(record);
    }
  }
  const taken = new Set(records.map((record) => record.environmentId));
  for (const { appId, view } of views) {
    for (const [environmentId, entry] of view.listed) {
      if (
        taken.has(environmentId) ||
        revoked(view, environmentId) ||
        view.newest.get(environmentId)?.nodeId === null ||
        view.hosts.has(environmentId) ||
        input.userSaved.has(environmentId)
      ) {
        continue;
      }
      taken.add(environmentId);
      changed = true;
      next.push({ environmentId, label: entry.label, via: entry.hosts[0]!, appId });
    }
  }
  return changed ? next : records;
}

/** The catalog's network member records. */
export class NetworkMembers extends Context.Reference<{
  readonly read: Effect.Effect<ReadonlyArray<NetworkMemberRecord>, ConnectionAttemptError>;
  readonly changes: Stream.Stream<ReadonlyArray<NetworkMemberRecord>, ConnectionAttemptError>;
  /** Runs `transform` alone: no other change starts until what it returns is saved. */
  readonly update: <E = never, R = never>(
    transform: (
      current: ReadonlyArray<NetworkMemberRecord>,
    ) => Effect.Effect<ReadonlyArray<NetworkMemberRecord>, E, R>,
  ) => Effect.Effect<void, ConnectionAttemptError | E, R>;
}>("@t3tools/client-runtime/connection/NetworkMembers", {
  defaultValue: () => ({
    read: Effect.succeed([]),
    changes: Stream.succeed([]),
    update: (transform) => Effect.asVoid(transform([])),
  }),
}) {}

/**
 * Loads on first use, so an unreadable catalog does not stop the connection layer starting. A
 * failed load fails that operation and is tried again next time; nothing is written until the
 * stored records were read.
 */
export const makeNetworkMembers = Effect.fn("makeNetworkMembers")(function* (storage: {
  readonly read: Effect.Effect<ReadonlyArray<NetworkMemberRecord>, ConnectionAttemptError>;
  readonly write: (
    records: ReadonlyArray<NetworkMemberRecord>,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const loadLock = yield* Semaphore.make(1);
  const lock = yield* Semaphore.make(1);
  let loaded: SubscriptionRef.SubscriptionRef<ReadonlyArray<NetworkMemberRecord>> | undefined;
  const state = loadLock.withPermits(1)(
    Effect.suspend(() =>
      loaded !== undefined
        ? Effect.succeed(loaded)
        : storage.read.pipe(
            Effect.flatMap(SubscriptionRef.make),
            Effect.tap((ref) => Effect.sync(() => void (loaded = ref))),
          ),
    ),
  );
  return NetworkMembers.of({
    read: Effect.flatMap(state, SubscriptionRef.get),
    changes: Stream.unwrap(Effect.map(state, SubscriptionRef.changes)),
    update: Effect.fn("NetworkMembers.update")(function* <E, R>(
      transform: (
        current: ReadonlyArray<NetworkMemberRecord>,
      ) => Effect.Effect<ReadonlyArray<NetworkMemberRecord>, E, R>,
    ) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const ref = yield* state;
          const current = yield* SubscriptionRef.get(ref);
          const next = yield* transform(current);
          if (next === current) return;
          yield* storage.write(next);
          yield* SubscriptionRef.set(ref, next);
        }),
      );
    }),
  });
});

/**
 * Applies what the followed hosts report and forgets the saved connection of every member it
 * drops. The saved environments are read under the catalog's lock, so a member the user saves
 * meanwhile never becomes a record. Nothing is minted here: see `openNetworkMember`.
 */
export const followNetworkRoster = Effect.fn("NetworkMembers.follow")(function* <ES, EF>(input: {
  readonly reports: ReadonlyArray<NetworkRosterReport>;
  readonly savedEnvironmentIds: Effect.Effect<ReadonlySet<EnvironmentId>, ES>;
  readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, EF>;
}) {
  const members = yield* NetworkMembers;
  yield* members.update((current) =>
    Effect.gen(function* () {
      const saved = yield* input.savedEnvironmentIds;
      // Saved members that are records stay managed; only the user's own entries are skipped.
      const managed = new Set(current.map((record) => record.environmentId));
      const networks = followedNetworks(input.reports);
      // Records a rebind drops are only unmanaged; their saved connections stay with the user.
      const released = rebindNetwork(current, input.reports, networks);
      const next = followRoster(released, {
        networks,
        saved,
        userSaved: new Set([...saved].filter((id) => !managed.has(id))),
      });
      if (next === current) return current;
      const remaining = new Set(next.map((record) => record.environmentId));
      for (const record of released) {
        if (remaining.has(record.environmentId) || !saved.has(record.environmentId)) continue;
        // A credential minted under another app id is not this network's to delete.
        if ((record.openedAs ?? record.appId) !== record.appId) continue;
        yield* input.forget(record.environmentId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not forget a member that left the network.", {
              environmentId: record.environmentId,
              cause,
            }),
          ),
        );
      }
      return next;
    }),
  );
});

/**
 * Opens a member: asks a connected host for a one-time credential and saves the member with it.
 * The one it came `via` is asked first, then the other `hosts`. Every open becomes a record
 * keyed by the host that answered, so it is renewed and its state shown however it was opened.
 */
export const openNetworkMember = Effect.fn("NetworkMembers.open")(function* <EM, ER>(input: {
  readonly environmentId: EnvironmentId;
  /** Shown until a roster names it. */
  readonly label?: string;
  /** Connected hosts that may open it (`openingHosts`). */
  readonly hosts: ReadonlyArray<OpeningHost>;
  readonly mint: (
    via: EnvironmentId,
    environmentId: EnvironmentId,
  ) => Effect.Effect<TailnetDeviceClientCredential, EM>;
  readonly register: (
    credential: TailnetDeviceClientCredential,
  ) => Effect.Effect<
    { readonly environmentId: EnvironmentId; readonly sessionExpiresAt: number },
    ER
  >;
}) {
  const members = yield* NetworkMembers;
  const record = (yield* members.read).find(
    (candidate) => candidate.environmentId === input.environmentId,
  );
  const hosts = [
    ...input.hosts.filter((candidate) => candidate.host === record?.via),
    ...input.hosts,
  ].filter(
    (candidate, index, all) =>
      candidate.host !== input.environmentId &&
      all.findIndex((other) => other.host === candidate.host) === index,
  );
  const label = record?.label ?? input.label ?? "this machine";
  // A client with no reachable member cannot reach the network: only a new pairing code helps.
  let failure: EM | ConnectionBlockedError = new ConnectionBlockedError({
    reason: "authentication",
    detail: `None of your machines that can open ${label} is connected. Pair with it again using a code.`,
  });
  for (const { host, appId } of hosts) {
    const minted = yield* Effect.result(input.mint(host, input.environmentId));
    if (minted._tag === "Failure") {
      failure = minted.failure;
      continue;
    }
    const opened = yield* input.register(minted.success);
    const { left: _left, openedAs: _openedAs, appId: _appId, ...kept } = record ?? {};
    const next: NetworkMemberRecord = {
      ...kept,
      environmentId: opened.environmentId,
      label,
      via: host,
      sessionExpiresAt: opened.sessionExpiresAt,
      ...(appId === null ? {} : { appId, openedAs: appId }),
    };
    yield* members
      .update((current) =>
        Effect.succeed(
          current.some((candidate) => candidate.environmentId === opened.environmentId)
            ? current.map((candidate) =>
                candidate.environmentId === opened.environmentId ? next : candidate,
              )
            : [...current, next],
        ),
      )
      .pipe(Effect.ignore);
    return opened.environmentId;
  }
  return yield* Effect.fail(failure);
});

/** What the client can show and do for a member it holds a record of. */
export type NetworkMemberStatus =
  /** Not saved here yet: Open. */
  | "unopened"
  /** Saved with a session the host accepts. */
  | "open"
  /** Saved, but its session expired or was cut (its relay revoked): Open again. */
  | "reopen"
  /** It left the network; the kept session lasts until `sessionExpiresAt`, then pair by code. */
  | "left";

export function networkMemberStatus(
  record: NetworkMemberRecord,
  saved: { readonly needsPairing: boolean } | undefined,
): NetworkMemberStatus {
  if (record.left === true) return "left";
  if (saved === undefined) return "unopened";
  return saved.needsPairing ? "reopen" : "open";
}

/**
 * Runs `claim` (the user saving the member themselves) under the catalog's lock, then hands the
 * member to the user when it claimed it: a later roster change no longer removes it.
 */
export const releaseNetworkMember = Effect.fn("NetworkMembers.release")(function* <E, R>(
  environmentId: EnvironmentId,
  claim: Effect.Effect<boolean, E, R>,
) {
  const members = yield* NetworkMembers;
  let claimed = false;
  yield* members.update((current) =>
    claim.pipe(
      Effect.map((value) => {
        claimed = value;
        return value && current.some((record) => record.environmentId === environmentId)
          ? current.filter((record) => record.environmentId !== environmentId)
          : current;
      }),
    ),
  );
  return claimed;
});

/** A managed member to open again because its host refused the saved credential. */
export interface NetworkMemberRenewal {
  readonly environmentId: EnvironmentId;
  /** Changes when the followed hosts change or the member connects; one attempt per value. */
  readonly attemptKey: string;
}

/**
 * Bounds renewal: one attempt per member and `attemptKey`, and successive attempts spaced by an
 * exponential backoff from `baseMs` up to `capMs`. A member left alone for `capMs` starts over.
 */
export function makeNetworkMemberRenewals(options?: {
  readonly baseMs?: number;
  readonly capMs?: number;
}) {
  const baseMs = options?.baseMs ?? 2_000;
  const capMs = options?.capMs ?? 5 * 60_000;
  const attempts = new Map<
    EnvironmentId,
    { readonly key: string; readonly failures: number; readonly at: number }
  >();
  return {
    /** Runs `open` when the policy allows it, after waiting out the backoff; false when skipped. */
    renew: Effect.fn("NetworkMembers.renew")(function* <A, E, R>(
      renewal: NetworkMemberRenewal,
      open: Effect.Effect<A, E, R>,
    ) {
      const previous = attempts.get(renewal.environmentId);
      if (previous?.key === renewal.attemptKey) return false;
      let now = yield* Clock.currentTimeMillis;
      const failures = previous === undefined || now - previous.at >= capMs ? 0 : previous.failures;
      if (previous !== undefined && failures > 0) {
        const wait = previous.at + Math.min(capMs, baseMs * 2 ** (failures - 1)) - now;
        if (wait > 0) {
          yield* Effect.sleep(wait);
          now = yield* Clock.currentTimeMillis;
        }
      }
      attempts.set(renewal.environmentId, {
        key: renewal.attemptKey,
        failures: failures + 1,
        at: now,
      });
      yield* open;
      return true;
    }),
  };
}
