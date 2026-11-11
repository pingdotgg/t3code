import {
  EnvironmentId,
  type TailnetDeviceClientCredential,
  type TailnetDevicesSnapshot,
} from "@t3tools/contracts";
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
 * demand, and it goes away with the roster entry that brought it.
 */
export const NetworkMemberRecord = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** The member that listed it, and the first one asked to open it. */
  via: EnvironmentId,
});
export type NetworkMemberRecord = typeof NetworkMemberRecord.Type;

/** What one member reports about the network, or null when it offers none. */
export type NetworkRoster = Pick<TailnetDevicesSnapshot, "selfMember" | "devices">;

/**
 * The records after `host` reported `roster`. `savedEnvironmentIds` are the environments this
 * client holds a connection to; one the user saved never becomes a record. A member any host
 * reports revoked is dropped; one only `host` brought is dropped when `host` stops listing it or
 * stops offering the network. Returns `records` itself when nothing changed.
 */
export function followRoster(
  records: ReadonlyArray<NetworkMemberRecord>,
  input: {
    readonly host: EnvironmentId;
    readonly roster: NetworkRoster | null;
    readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
  },
): ReadonlyArray<NetworkMemberRecord> {
  const roster =
    input.roster !== null &&
    input.roster.selfMember !== null &&
    input.roster.selfMember.access !== "revoked"
      ? input.roster
      : null;
  const members = new Map<EnvironmentId, string>();
  const revoked = new Set<EnvironmentId>();
  for (const device of roster?.devices ?? []) {
    if (device.member === null || device.environmentId === input.host) continue;
    if (device.access === "revoked" || device.member.access === "revoked") {
      revoked.add(device.environmentId);
    } else {
      members.set(device.environmentId, device.label);
    }
  }
  let changed = false;
  const next: Array<NetworkMemberRecord> = [];
  const kept = new Set<EnvironmentId>();
  for (const record of records) {
    const label = members.get(record.environmentId);
    if (revoked.has(record.environmentId) || (record.via === input.host && label === undefined)) {
      changed = true;
      continue;
    }
    kept.add(record.environmentId);
    if (label !== undefined && label !== record.label) {
      changed = true;
      next.push({ ...record, label });
    } else {
      next.push(record);
    }
  }
  for (const [environmentId, label] of members) {
    if (kept.has(environmentId) || input.savedEnvironmentIds.has(environmentId)) continue;
    changed = true;
    next.push({ environmentId, label, via: input.host });
  }
  return changed ? next : records;
}

/** The catalog's network member records. */
export class NetworkMembers extends Context.Reference<{
  readonly read: Effect.Effect<ReadonlyArray<NetworkMemberRecord>>;
  readonly changes: Stream.Stream<ReadonlyArray<NetworkMemberRecord>>;
  readonly update: (
    transform: (current: ReadonlyArray<NetworkMemberRecord>) => ReadonlyArray<NetworkMemberRecord>,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}>("@t3tools/client-runtime/connection/NetworkMembers", {
  defaultValue: () => ({
    read: Effect.succeed([]),
    changes: Stream.succeed([]),
    update: () => Effect.void,
  }),
}) {}

export const makeNetworkMembers = Effect.fn("makeNetworkMembers")(function* (storage: {
  readonly read: Effect.Effect<ReadonlyArray<NetworkMemberRecord>, ConnectionAttemptError>;
  readonly write: (
    records: ReadonlyArray<NetworkMemberRecord>,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const state = yield* SubscriptionRef.make(yield* storage.read);
  const lock = yield* Semaphore.make(1);
  return NetworkMembers.of({
    read: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    update: Effect.fn("NetworkMembers.update")(function* (transform) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const next = transform(current);
          if (next === current) return;
          yield* storage.write(next);
          yield* SubscriptionRef.set(state, next);
        }),
      );
    }),
  });
});

/**
 * Applies what `host` reported and forgets the saved connection of every member it drops.
 * Nothing is minted here: members are opened one at a time by `openNetworkMember`.
 */
export const followNetworkRoster = Effect.fn("NetworkMembers.follow")(function* <E>(input: {
  readonly host: EnvironmentId;
  readonly roster: NetworkRoster | null;
  readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, E>;
}) {
  const members = yield* NetworkMembers;
  let dropped: ReadonlyArray<EnvironmentId> = [];
  yield* members.update((current) => {
    // Saved members that are records stay managed; only the user's own entries are skipped.
    const managed = new Set(current.map((record) => record.environmentId));
    const userSaved = new Set([...input.savedEnvironmentIds].filter((id) => !managed.has(id)));
    userSaved.add(input.host);
    const next = followRoster(current, {
      host: input.host,
      roster: input.roster,
      savedEnvironmentIds: userSaved,
    });
    const remaining = new Set(next.map((record) => record.environmentId));
    dropped = current.flatMap((record) =>
      remaining.has(record.environmentId) ? [] : [record.environmentId],
    );
    return next;
  });
  yield* Effect.forEach(
    dropped.filter((environmentId) => input.savedEnvironmentIds.has(environmentId)),
    (environmentId) =>
      input.forget(environmentId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not forget a member that left the network.", {
            environmentId,
            cause,
          }),
        ),
      ),
    { discard: true },
  );
});

/**
 * Opens a member: asks a connected member for a one-time credential and saves the member with it.
 * The member that listed it is asked first, then every other connected environment, so renewal
 * still works while the first host is offline. The one that answered becomes `via`.
 */
export const openNetworkMember = Effect.fn("NetworkMembers.open")(function* <EM, ER>(input: {
  readonly environmentId: EnvironmentId;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
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
    ...(record === undefined ? [] : [record.via]),
    ...input.connectedEnvironmentIds,
  ].filter(
    (host, index, all) =>
      host !== input.environmentId &&
      input.connectedEnvironmentIds.has(host) &&
      all.indexOf(host) === index,
  );
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
          current.map((candidate) =>
            candidate.environmentId === environmentId ? { ...candidate, via: host } : candidate,
          ),
        )
        .pipe(Effect.ignore);
    }
    return environmentId;
  }
  return yield* Effect.fail(failure);
});

/** Hands a member to the user: a later roster change no longer removes it. */
export const releaseNetworkMember = Effect.fn("NetworkMembers.release")(function* (
  environmentId: EnvironmentId,
) {
  const members = yield* NetworkMembers;
  yield* members.update((current) =>
    current.some((record) => record.environmentId === environmentId)
      ? current.filter((record) => record.environmentId !== environmentId)
      : current,
  );
});
