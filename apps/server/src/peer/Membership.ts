import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  NetworkMember,
  TailnetDeviceAccess,
  TailnetDevicesError,
  TailnetHlc,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const compareStamps = (a: TailnetHlc, b: TailnetHlc): number =>
  a.wallMs !== b.wallMs
    ? a.wallMs - b.wallMs
    : a.counter !== b.counter
      ? a.counter - b.counter
      : a.node < b.node
        ? -1
        : a.node > b.node
          ? 1
          : 0;

const ACCESS_ORDER: ReadonlyArray<AuthMcpClientAccess> = [
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** The narrower of two access levels. */
export const narrowerAccess = (a: AuthMcpClientAccess, b: AuthMcpClientAccess) =>
  ACCESS_ORDER.indexOf(a) <= ACCESS_ORDER.indexOf(b) ? a : b;

/** The roster after taking `incoming`: each member keeps its latest write, in any arrival order. */
export const mergeRoster = (
  current: ReadonlyMap<EnvironmentId, NetworkMember>,
  incoming: ReadonlyArray<NetworkMember>,
): ReadonlyMap<EnvironmentId, NetworkMember> => {
  const next = new Map(current);
  for (const member of incoming) {
    const existing = next.get(member.environmentId);
    if (existing === undefined || compareStamps(member.updatedAt, existing.updatedAt) > 0) {
      next.set(member.environmentId, member);
    }
  }
  return next;
};

interface MemberRow {
  readonly environment_id: string;
  readonly label: string;
  readonly node_id: string | null;
  readonly access: string;
  readonly stamp_json: string;
}

const isAccess = Schema.is(TailnetDeviceAccess);
const isClientAccess = (value: string): value is AuthMcpClientAccess =>
  (ACCESS_ORDER as ReadonlyArray<string>).includes(value);
const decodeMember = Schema.decodeUnknownEffect(NetworkMember);
const decodeStamp = Schema.decodeUnknownEffect(Schema.fromJsonString(TailnetHlc));
const encodeStamp = Schema.encodeEffect(Schema.fromJsonString(TailnetHlc));

const storageError = (cause: unknown) =>
  new TailnetDevicesError({
    reason: "storage",
    message: "The network roster could not be read or saved here. The server log has details.",
    cause,
  });

/**
 * The roster of the owner's network: which machines are members and what each may do. Every
 * member replicates it, stamped with a hybrid logical clock and merged last-writer-wins.
 * `revoked` entries are tombstones and never expire. A machine may also keep a narrower limit
 * for a member that it never replicates; what a member may do here is the narrower of the two.
 */
export class Membership extends Context.Service<
  Membership,
  {
    readonly members: Effect.Effect<ReadonlyArray<NetworkMember>, TailnetDevicesError>;
    readonly member: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<NetworkMember>, TailnetDevicesError>;
    /** This machine's limits for members, which never leave it. */
    readonly limits: Effect.Effect<ReadonlyMap<EnvironmentId, AuthMcpClientAccess>>;
    /**
     * What a member may do here: the roster's access narrowed by this machine's limit. None for a
     * machine that is not a member; an unreadable entry fails closed as `revoked`.
     */
    readonly accessOf: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<TailnetDeviceAccess>>;
    /** Writes a member here with a fresh stamp, so it wins over every earlier write. */
    readonly put: (input: {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly nodeId: string | null;
      readonly access: TailnetDeviceAccess;
    }) => Effect.Effect<NetworkMember, TailnetDevicesError>;
    /**
     * Records the Tailscale node a member answered from, the first time one is seen for it.
     * Never replaces a bound node: a member that moves to a new node is added again.
     */
    readonly bindNode: (
      environmentId: EnvironmentId,
      nodeId: string,
    ) => Effect.Effect<void, TailnetDevicesError>;
    readonly setLimit: (
      environmentId: EnvironmentId,
      limit: AuthMcpClientAccess | null,
    ) => Effect.Effect<void, TailnetDevicesError>;
    /**
     * Takes a sender's roster. The caller has already checked the sender is a full-access member
     * on a member session. Entries naming the sender are dropped, so no machine sets its own
     * access. Returns the members this merge newly revoked.
     */
    readonly merge: (
      sender: EnvironmentId,
      roster: ReadonlyArray<NetworkMember>,
    ) => Effect.Effect<ReadonlyArray<EnvironmentId>, TailnetDevicesError>;
    /**
     * Takes entries without the sender rule: the roster a machine joining a network was offered,
     * or a seed stamped at zero that only fills a gap.
     */
    readonly adopt: (
      roster: ReadonlyArray<NetworkMember>,
    ) => Effect.Effect<void, TailnetDevicesError>;
    /**
     * Drops an entry that never replicated, to undo an admission or join that did not complete.
     * Anything already shared is changed with `put` instead, so a tombstone is never lost.
     */
    readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, TailnetDevicesError>;
  }
>()("t3/peer/Membership") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const lastStamp = yield* Ref.make<TailnetHlc | null>(null);
  // Reads, merges and writes of the roster happen one at a time.
  const writes = yield* Semaphore.make(1);

  const members: Membership["Service"]["members"] = sql<MemberRow>`
    SELECT * FROM network_members
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeStamp(row.stamp_json).pipe(
          Effect.flatMap((updatedAt) =>
            decodeMember({
              environmentId: row.environment_id,
              label: row.label,
              nodeId: row.node_id,
              // An unreadable level fails closed.
              access: isAccess(row.access) ? row.access : "revoked",
              updatedAt,
            }),
          ),
        ),
      ),
    ),
    Effect.mapError(storageError),
  );

  const member: Membership["Service"]["member"] = Effect.fn("Membership.member")(
    function* (environmentId) {
      return Option.fromNullishOr(
        (yield* members).find((candidate) => candidate.environmentId === environmentId),
      );
    },
  );

  const limits: Membership["Service"]["limits"] = sql<{
    readonly environment_id: string;
    readonly access: string;
  }>`SELECT environment_id, access FROM network_member_limits`.pipe(
    Effect.map(
      (rows) =>
        new Map(
          rows.flatMap((row) =>
            isClientAccess(row.access)
              ? [[row.environment_id as EnvironmentId, row.access] as const]
              : // An unreadable limit narrows to the least access.
                [[row.environment_id as EnvironmentId, "read-only" as const] as const],
          ),
        ),
    ),
    Effect.tapError((cause) => Effect.logWarning("Network member limits unreadable", { cause })),
    Effect.orElseSucceed(() => new Map<EnvironmentId, AuthMcpClientAccess>()),
  );

  const accessOf: Membership["Service"]["accessOf"] = Effect.fn("Membership.accessOf")(
    function* (environmentId) {
      const found = yield* member(environmentId).pipe(
        // A roster that cannot be read admits nobody.
        Effect.orElseSucceed(() =>
          Option.some({ access: "revoked" as const } as Pick<NetworkMember, "access">),
        ),
      );
      if (Option.isNone(found)) return Option.none();
      const access = found.value.access;
      if (access === "revoked") return Option.some(access);
      const limit = (yield* limits).get(environmentId);
      return Option.some(limit === undefined ? access : narrowerAccess(access, limit));
    },
  );

  /** Later than every stamp this environment made or has seen, so its next write wins. */
  const observe = (stamps: ReadonlyArray<TailnetHlc>) =>
    Ref.update(lastStamp, (last) =>
      stamps.reduce<TailnetHlc | null>(
        (latest, stamp) => (latest === null || compareStamps(stamp, latest) > 0 ? stamp : latest),
        last,
      ),
    );

  const stamp = Effect.gen(function* () {
    const node = yield* identity.getEnvironmentId;
    const now = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(lastStamp, (last): [TailnetHlc, TailnetHlc] => {
      const next =
        last === null || now > last.wallMs
          ? { wallMs: now, counter: 0, node }
          : { wallMs: last.wallMs, counter: last.counter + 1, node };
      return [next, next];
    });
  });

  // A restart must not stamp earlier than what is already stored.
  yield* members.pipe(
    Effect.flatMap((stored) => observe(stored.map((entry) => entry.updatedAt))),
    Effect.ignore,
  );

  const write = (entry: NetworkMember) =>
    encodeStamp(entry.updatedAt).pipe(
      Effect.flatMap(
        (stampJson) => sql`
          INSERT INTO network_members (environment_id, label, node_id, access, stamp_json)
          VALUES (${entry.environmentId}, ${entry.label}, ${entry.nodeId}, ${entry.access}, ${stampJson})
          ON CONFLICT (environment_id) DO UPDATE SET
            label = excluded.label,
            node_id = excluded.node_id,
            access = excluded.access,
            stamp_json = excluded.stamp_json
        `,
      ),
      Effect.mapError(storageError),
    );

  const put: Membership["Service"]["put"] = Effect.fn("Membership.put")(
    function* (input) {
      const entry: NetworkMember = { ...input, updatedAt: yield* stamp };
      yield* write(entry);
      return entry;
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const bindNode: Membership["Service"]["bindNode"] = Effect.fn("Membership.bindNode")(
    function* (environmentId, nodeId) {
      const found = yield* member(environmentId);
      if (Option.isNone(found) || found.value.nodeId !== null) return;
      yield* write({ ...found.value, nodeId, updatedAt: yield* stamp });
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const setLimit: Membership["Service"]["setLimit"] = Effect.fn("Membership.setLimit")(
    function* (environmentId, limit) {
      yield* (
        limit === null
          ? sql`DELETE FROM network_member_limits WHERE environment_id = ${environmentId}`
          : sql`
              INSERT INTO network_member_limits (environment_id, access) VALUES (${environmentId}, ${limit})
              ON CONFLICT (environment_id) DO UPDATE SET access = excluded.access
            `
      ).pipe(Effect.mapError(storageError));
    },
  );

  const applyRoster = Effect.fn("Membership.applyRoster")(function* (
    incoming: ReadonlyArray<NetworkMember>,
  ) {
    const stored = yield* members;
    const current = new Map(stored.map((entry) => [entry.environmentId, entry]));
    const next = mergeRoster(current, incoming);
    const newlyRevoked: Array<EnvironmentId> = [];
    for (const [environmentId, entry] of next) {
      const before = current.get(environmentId);
      if (before === entry) continue;
      // A bound node is never dropped for an unbound copy. Restamped, so the binding spreads.
      if (entry.nodeId === null && before !== undefined && before.nodeId !== null) {
        yield* write({ ...entry, nodeId: before.nodeId, updatedAt: yield* stamp });
      } else {
        yield* write(entry);
      }
      if (entry.access === "revoked" && before?.access !== "revoked") {
        newlyRevoked.push(environmentId);
      }
    }
    yield* observe(incoming.map((entry) => entry.updatedAt));
    return newlyRevoked;
  });

  const merge: Membership["Service"]["merge"] = Effect.fn("Membership.merge")(
    function* (sender, roster) {
      return yield* applyRoster(roster.filter((entry) => entry.environmentId !== sender));
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const adopt: Membership["Service"]["adopt"] = Effect.fn("Membership.adopt")(
    function* (roster) {
      yield* applyRoster(roster);
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const forget: Membership["Service"]["forget"] = Effect.fn("Membership.forget")(
    function* (environmentId) {
      yield* sql`DELETE FROM network_members WHERE environment_id = ${environmentId}`.pipe(
        Effect.mapError(storageError),
      );
    },
    (effect) => writes.withPermits(1)(effect),
  );

  return Membership.of({
    members,
    member,
    limits,
    accessOf,
    put,
    bindNode,
    setLimit,
    merge,
    adopt,
    forget,
  });
});

export const layer = Layer.effect(Membership, make);
