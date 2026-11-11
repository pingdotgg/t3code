import {
  EnvironmentId,
  type TailnetDeviceClientCredential,
  type TailnetDevicesSnapshot,
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

/** This client's app id on `roster`'s host, when the host takes part in a network it is an app of. */
function callerAppIdOf(roster: NetworkRoster): string | null {
  const appId = roster.callerAppId;
  if (!roster.enabled || appId === null) return null;
  if (roster.selfMember === null || roster.selfMember.access === "revoked") return null;
  return roster.apps.some((app) => app.appId === appId && app.access !== "revoked") ? appId : null;
}

/**
 * The network this client follows, and the reports of the hosts in it. Its identity is the app id
 * its records were brought under; with none yet, the smallest one a host reports. A host reporting
 * another app id, or none, is another network or a plain pairing and contributes nothing.
 */
export function followedNetwork(
  records: ReadonlyArray<NetworkMemberRecord>,
  reports: ReadonlyArray<NetworkRosterReport>,
): { readonly appId: string | null; readonly reports: ReadonlyArray<NetworkRosterReport> } {
  const candidates = reports.flatMap((report) => {
    const appId = callerAppIdOf(report.roster);
    return appId === null ? [] : [{ appId, report }];
  });
  const appId =
    records.find((record) => record.appId !== undefined)?.appId ??
    candidates.map((candidate) => candidate.appId).sort()[0] ??
    null;
  return {
    appId,
    reports: candidates.flatMap((candidate) =>
      candidate.appId === appId ? [candidate.report] : [],
    ),
  };
}

/**
 * A member any followed host reports revoked is dropped. Otherwise a record goes only when no
 * followed host lists it (a host vouching for itself counts) and its `via` host is followed and
 * omits it: an offline, switched-off or foreign host says nothing. `userSaved` environments never
 * become records. Returns `records` itself when nothing changed.
 */
function followRoster(
  records: ReadonlyArray<NetworkMemberRecord>,
  input: {
    readonly reports: ReadonlyArray<NetworkRosterReport>;
    readonly userSaved: ReadonlySet<EnvironmentId>;
  },
): ReadonlyArray<NetworkMemberRecord> {
  const network = followedNetwork(records, input.reports);
  const hosts = new Set(network.reports.map((report) => report.host));
  const listed = new Map<EnvironmentId, { label: string; hosts: Array<EnvironmentId> }>();
  const revoked = new Set<EnvironmentId>();
  for (const { host, roster } of network.reports) {
    for (const device of roster.devices) {
      if (device.member === null || device.environmentId === host) continue;
      if (device.access === "revoked" || device.member.access === "revoked") {
        revoked.add(device.environmentId);
        continue;
      }
      const entry = listed.get(device.environmentId);
      if (entry === undefined)
        listed.set(device.environmentId, { label: device.label, hosts: [host] });
      else entry.hosts.push(host);
    }
  }
  const appId = network.appId ?? undefined;
  let changed = false;
  const next: Array<NetworkMemberRecord> = [];
  for (const record of records) {
    const entry = listed.get(record.environmentId);
    if (
      revoked.has(record.environmentId) ||
      (entry === undefined && !hosts.has(record.environmentId) && hosts.has(record.via))
    ) {
      changed = true;
      continue;
    }
    if (entry === undefined) {
      next.push(record);
      continue;
    }
    const updated: NetworkMemberRecord = {
      environmentId: record.environmentId,
      label: entry.label,
      via: entry.hosts.includes(record.via) ? record.via : entry.hosts[0]!,
      ...(appId === undefined ? {} : { appId }),
    };
    if (
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
  const kept = new Set(records.map((record) => record.environmentId));
  for (const [environmentId, entry] of listed) {
    if (
      kept.has(environmentId) ||
      revoked.has(environmentId) ||
      hosts.has(environmentId) ||
      input.userSaved.has(environmentId)
    ) {
      continue;
    }
    changed = true;
    next.push({
      environmentId,
      label: entry.label,
      via: entry.hosts[0]!,
      ...(appId === undefined ? {} : { appId }),
    });
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
      const next = followRoster(current, {
        reports: input.reports,
        userSaved: new Set([...saved].filter((id) => !managed.has(id))),
      });
      if (next === current) return current;
      const remaining = new Set(next.map((record) => record.environmentId));
      for (const record of current) {
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
 * Opens a member: asks a followed host for a one-time credential and saves the member with it.
 * The one it came `via` is asked first, then the other `hosts`, so renewal still works while that
 * one is offline. The one that answered becomes `via`.
 */
export const openNetworkMember = Effect.fn("NetworkMembers.open")(function* <EM, ER>(input: {
  readonly environmentId: EnvironmentId;
  /** Connected hosts of the followed network (`followedNetwork`). */
  readonly hosts: ReadonlyArray<EnvironmentId>;
  readonly mint: (
    via: EnvironmentId,
    environmentId: EnvironmentId,
  ) => Effect.Effect<TailnetDeviceClientCredential, EM>;
  readonly register: (
    credential: TailnetDeviceClientCredential,
  ) => Effect.Effect<EnvironmentId, ER>;
}) {
  const members = yield* NetworkMembers;
  const record = (yield* members.read).find(
    (candidate) => candidate.environmentId === input.environmentId,
  );
  const hosts = [
    ...(record !== undefined && input.hosts.includes(record.via) ? [record.via] : []),
    ...input.hosts,
  ].filter((host, index, all) => host !== input.environmentId && all.indexOf(host) === index);
  const label = record?.label ?? "this machine";
  // A client with no reachable member cannot reach the network: only a new pairing code helps.
  let failure: EM | ConnectionBlockedError = new ConnectionBlockedError({
    reason: "authentication",
    detail: `None of your machines that can open ${label} is connected. Pair with it again using a code.`,
  });
  for (const host of hosts) {
    const minted = yield* Effect.result(input.mint(host, input.environmentId));
    if (minted._tag === "Failure") {
      failure = minted.failure;
      continue;
    }
    const environmentId = yield* input.register(minted.success);
    if (record !== undefined && record.via !== host) {
      yield* members
        .update((current) =>
          Effect.succeed(
            current.map((candidate) =>
              candidate.environmentId === environmentId ? { ...candidate, via: host } : candidate,
            ),
          ),
        )
        .pipe(Effect.ignore);
    }
    return environmentId;
  }
  return yield* Effect.fail(failure);
});

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
