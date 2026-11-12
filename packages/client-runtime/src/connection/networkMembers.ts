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
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

/** Who this client opened a member as: an app of a network, or a session without an app id. */
const NetworkMemberOpener = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("app"), appId: Schema.String }),
  /** The desktop app or a code-paired session: it follows only the roster of its `via` host. */
  Schema.Struct({ kind: Schema.Literal("host") }),
]);

const networkMemberFields = {
  environmentId: EnvironmentId,
  label: Schema.String,
  /** The host that opened it or lists it, and the first one asked to open it again. */
  via: EnvironmentId,
  /** When the session it was opened with ends (epoch ms). Nothing extends a session. */
  sessionExpiresAt: Schema.optionalKey(Schema.Number),
  /**
   * It left the network by its own act. Its kept session lasts until `sessionExpiresAt`; it is
   * never renewed or forgotten, and is managed again once its roster lists it live.
   */
  left: Schema.optionalKey(Schema.Literal(true)),
};

const NetworkMemberRecordType = Schema.Struct({
  ...networkMemberFields,
  opener: NetworkMemberOpener,
});

// Records saved before `opener` carry the app id alone; without one they were app-less opens.
const StoredNetworkMemberRecord = Schema.Struct({
  ...networkMemberFields,
  opener: Schema.optionalKey(NetworkMemberOpener),
  appId: Schema.optionalKey(Schema.String),
});

/**
 * A machine of the user's network this client keeps because a host listed or opened it, not
 * because the user saved it by hand. It is opened only on demand and follows its opener's roster.
 */
export const NetworkMemberRecord = StoredNetworkMemberRecord.pipe(
  Schema.decodeTo(
    Schema.toType(NetworkMemberRecordType),
    SchemaTransformation.transform<
      typeof NetworkMemberRecordType.Type,
      typeof StoredNetworkMemberRecord.Type
    >({
      decode: ({ appId, opener, ...record }) => ({
        ...record,
        opener: opener ?? (appId === undefined ? { kind: "host" } : { kind: "app", appId }),
      }),
      // Older builds read the app id alone.
      encode: (record) =>
        record.opener.kind === "app" ? { ...record, appId: record.opener.appId } : record,
    }),
  ),
);
export type NetworkMemberRecord = typeof NetworkMemberRecordType.Type;

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
 * App records whose app id no network takes. Proven lost (revoked, unlisted by a host still using
 * it, or re-paired on their `via` host), each moves to a network listing it live, or goes. Not
 * proven, only a machine listed live elsewhere (it moved) goes. Dropped ones keep their sessions.
 */
function rebindNetwork(
  records: ReadonlyArray<NetworkMemberRecord>,
  reports: ReadonlyArray<NetworkRosterReport>,
  networks: ReadonlyArray<FollowedNetwork>,
): ReadonlyArray<NetworkMemberRecord> {
  const followed = new Set(networks.map((network) => network.appId));
  const appIdOf = (record: NetworkMemberRecord) =>
    record.opener.kind === "app" ? record.opener.appId : null;
  const stale = new Set(
    records.flatMap((record) => {
      const appId = appIdOf(record);
      return appId !== null && !followed.has(appId) ? [appId] : [];
    }),
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
  const disowned = new Set(
    [...stale].filter((appId) => {
      const entry = apps.get(appId);
      if (entry !== undefined && entry.access !== "revoked") return false;
      const vias = new Set(
        records.flatMap((record) => (appIdOf(record) === appId ? [record.via] : [])),
      );
      return (
        entry !== undefined ||
        reports.some(
          ({ host, roster }) =>
            roster.enabled &&
            (roster.callerAppId === appId ||
              (vias.has(host) && callerAppIdOf(roster, apps) !== null)),
        )
      );
    }),
  );
  let changed = false;
  const next = records.flatMap((record) => {
    const appId = appIdOf(record);
    if (appId === null || !stale.has(appId)) return [record];
    const entry = apps.get(appId);
    if (entry !== undefined && entry.access !== "revoked") return [record];
    const successor = live.find((network) => network.members.has(record.environmentId))?.appId;
    if (successor !== undefined && disowned.has(appId)) {
      changed = true;
      return [{ ...record, opener: { kind: "app" as const, appId: successor } }];
    }
    if (successor !== undefined || disowned.has(appId)) {
      changed = true;
      return [];
    }
    return [record];
  });
  return changed ? next : records;
}

/**
 * One roster's verdict on one record, whoever opened it. A member that left keeps the session the
 * server kept (while saved here); a newest revocation drops it; so does its `via` host omitting it
 * while no host lists it (self counts). Listed live, it is managed again. "drop" means drop.
 */
function followRecord(
  record: NetworkMemberRecord,
  view: NetworkView,
  saved: ReadonlySet<EnvironmentId>,
): NetworkMemberRecord | "drop" {
  const newest = view.newest.get(record.environmentId);
  if (newest !== undefined && hasLeftNetwork(newest)) {
    if (!saved.has(record.environmentId)) return "drop";
    return record.left === true ? record : { ...record, left: true };
  }
  if (newest?.access === "revoked") return "drop";
  const entry = view.listed.get(record.environmentId);
  if (entry === undefined) {
    const omitted =
      record.left !== true && !view.hosts.has(record.environmentId) && view.hosts.has(record.via);
    return omitted ? "drop" : record;
  }
  const via = entry.hosts.includes(record.via) ? record.via : entry.hosts[0]!;
  if (record.left !== true && entry.label === record.label && via === record.via) return record;
  const { left: _left, ...managed } = record;
  return { ...managed, label: entry.label, via };
}

/**
 * Follows every record: an app record by its followed network's hosts, an app-less one by the
 * roster of the host that opened it, under the same rule (`followRecord`). Followed networks
 * also add the members they list; `userSaved` and unbound ones never become records. Returns
 * `records` itself when nothing changed.
 */
function followRoster(
  records: ReadonlyArray<NetworkMemberRecord>,
  input: {
    readonly reports: ReadonlyArray<NetworkRosterReport>;
    readonly networks: ReadonlyArray<FollowedNetwork>;
    readonly saved: ReadonlySet<EnvironmentId>;
    readonly userSaved: ReadonlySet<EnvironmentId>;
  },
): ReadonlyArray<NetworkMemberRecord> {
  const appViews = new Map(
    input.networks.map((network) => [network.appId, networkView(network.reports)] as const),
  );
  const hostViews = new Map(
    input.reports.flatMap((report) =>
      report.roster.enabled && isLive(report.roster.selfMember)
        ? [[report.host, networkView([report])] as const]
        : [],
    ),
  );
  let changed = false;
  const next: Array<NetworkMemberRecord> = [];
  for (const record of records) {
    const view =
      record.opener.kind === "app" ? appViews.get(record.opener.appId) : hostViews.get(record.via);
    const followed = view === undefined ? record : followRecord(record, view, input.saved);
    if (followed !== record) changed = true;
    if (followed !== "drop") next.push(followed);
  }
  const taken = new Set(records.map((record) => record.environmentId));
  for (const [appId, view] of appViews) {
    for (const [environmentId, entry] of view.listed) {
      if (
        taken.has(environmentId) ||
        view.newest.get(environmentId)?.access === "revoked" ||
        view.newest.get(environmentId)?.nodeId === null ||
        view.hosts.has(environmentId) ||
        input.userSaved.has(environmentId)
      ) {
        continue;
      }
      taken.add(environmentId);
      changed = true;
      next.push({
        environmentId,
        label: entry.label,
        via: entry.hosts[0]!,
        opener: { kind: "app", appId },
      });
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
      const networks = followedNetworks(input.reports);
      // Records a rebind drops are released: their saved connections become the user's own.
      const released = rebindNetwork(current, input.reports, networks);
      // Saved members that are records stay managed; only the user's own entries are skipped.
      const managed = new Set(released.map((record) => record.environmentId));
      const next = followRoster(released, {
        reports: input.reports,
        networks,
        saved,
        userSaved: new Set([...saved].filter((id) => !managed.has(id))),
      });
      if (next === current) return current;
      const remaining = new Set(next.map((record) => record.environmentId));
      for (const record of released) {
        if (remaining.has(record.environmentId) || !saved.has(record.environmentId)) continue;
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
    const next: NetworkMemberRecord = {
      environmentId: opened.environmentId,
      label,
      via: host,
      opener: appId === null ? { kind: "host" } : { kind: "app", appId },
      sessionExpiresAt: opened.sessionExpiresAt,
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
  /** Its session was refused (expired, or cut with its relay); a connected host can open it again. */
  | "reopen"
  /** Its session was refused and nothing here can open it again (it left, or no host is connected). */
  | "refused"
  /** It left the network; the session the server kept lasts until `sessionExpiresAt`. */
  | "left";

/** The one precedence: a refused session outranks everything the roster says. */
export function networkMemberStatus(
  record: NetworkMemberRecord,
  saved: { readonly needsPairing: boolean } | undefined,
  canOpen: boolean,
): NetworkMemberStatus {
  if (saved === undefined) return "unopened";
  if (saved.needsPairing) return record.left !== true && canOpen ? "reopen" : "refused";
  return record.left === true ? "left" : "open";
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
