import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  NetworkApp,
  NetworkMember,
  TailnetDeviceAccess,
  TailnetDevicesError,
  TailnetHlc,
  compareNetworkApps,
  compareNetworkMembers,
  compareTailnetHlc,
  narrowsAccess,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

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

const mergeBy = <K, A>(
  current: ReadonlyMap<K, A>,
  incoming: ReadonlyArray<A>,
  keyOf: (entry: A) => K,
  compare: (a: A, b: A) => number,
): ReadonlyMap<K, A> => {
  const next = new Map(current);
  for (const entry of incoming) {
    const existing = next.get(keyOf(entry));
    if (existing === undefined || compare(entry, existing) > 0) next.set(keyOf(entry), entry);
  }
  return next;
};

/** The roster after taking `incoming`: the same entries whatever order writes arrive in. */
export const mergeMembers = (
  current: ReadonlyMap<EnvironmentId, NetworkMember>,
  incoming: ReadonlyArray<NetworkMember>,
) => mergeBy(current, incoming, (entry) => entry.environmentId, compareNetworkMembers);

const mergeApps = (current: ReadonlyMap<string, NetworkApp>, incoming: ReadonlyArray<NetworkApp>) =>
  mergeBy(current, incoming, (app) => app.appId, compareNetworkApps);

interface MemberRow {
  readonly environment_id: string;
  readonly label: string;
  readonly node_id: string | null;
  readonly access: string;
  readonly stamp_json: string;
  readonly restores_json: string | null;
  readonly hidden: number;
}

interface AppRow {
  readonly app_id: string;
  readonly label: string;
  readonly access: string;
  readonly stamp_json: string;
  readonly hidden: number;
}

/** A machine linked to this one only, at `access`, bound to the node that proved it. */
export interface LocalMember {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly nodeId: string;
  readonly access: AuthMcpClientAccess;
}

const isAccess = Schema.is(TailnetDeviceAccess);
const isClientAccess = (value: string): value is AuthMcpClientAccess =>
  (ACCESS_ORDER as ReadonlyArray<string>).includes(value);
const decodeMember = Schema.decodeUnknownEffect(NetworkMember);
const decodeApp = Schema.decodeUnknownEffect(NetworkApp);

/** What a merge changed that needs acting on. */
export interface RosterCuts {
  /** Members newly revoked. */
  readonly revoked: ReadonlyArray<EnvironmentId>;
  /** Members narrowed but not revoked, whose brokered sessions were minted for more. */
  readonly narrowed: ReadonlyArray<EnvironmentId>;
  /** Apps narrowed or revoked, whose sessions were minted for more. */
  readonly appsCut: ReadonlyArray<string>;
  /** Machines that were not in the roster before. */
  readonly added: ReadonlyArray<EnvironmentId>;
}

/** `appRedeemed` is a change no caller pushes to the other members itself. */
export type RosterChange = "written" | "appRedeemed";

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
 * member replicates it, stamped with a hybrid logical clock; `revoked` entries are tombstones and
 * never expire. A machine also keeps, without replicating them, a narrower limit for a member,
 * machines linked to it alone, and what the user removed from its view.
 */
export class Membership extends Context.Service<
  Membership,
  {
    readonly members: Effect.Effect<ReadonlyArray<NetworkMember>, TailnetDevicesError>;
    readonly apps: Effect.Effect<ReadonlyArray<NetworkApp>, TailnetDevicesError>;
    /** What an app of the network may do; none for an app that is not in it. */
    readonly appAccessOf: (appId: string) => Effect.Effect<Option.Option<TailnetDeviceAccess>>;
    /** Writes an app with a fresh stamp. Returns whether its sessions must end. */
    readonly putApp: (input: {
      readonly appId: string;
      readonly label: string;
      readonly access: TailnetDeviceAccess;
    }) => Effect.Effect<{ readonly app: NetworkApp; readonly cut: boolean }, TailnetDevicesError>;
    /**
     * Adds an app the first time its invitation is redeemed; a known app keeps its entry. With
     * `replaces`, the app it was paired again for is revoked and hidden in the same write.
     */
    readonly redeemApp: (input: {
      readonly appId: string;
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly replaces?: string;
    }) => Effect.Effect<"added" | "known" | "revoked", TailnetDevicesError>;
    readonly member: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<NetworkMember>, TailnetDevicesError>;
    /** This machine's limits for members, which never leave it. */
    readonly limits: Effect.Effect<ReadonlyMap<EnvironmentId, AuthMcpClientAccess>>;
    /** Machines linked to this one only. */
    readonly local: Effect.Effect<ReadonlyArray<LocalMember>, TailnetDevicesError>;
    readonly putLocal: (input: LocalMember) => Effect.Effect<void, TailnetDevicesError>;
    readonly forgetLocal: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, TailnetDevicesError>;
    /**
     * What a machine may do here: a member's roster access narrowed by this machine's limit, or a
     * machine linked here only at its local access. None for anything else; an unreadable entry
     * fails closed as `revoked`.
     */
    readonly accessOf: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<TailnetDeviceAccess>>;
    /**
     * Writes a member here with a fresh stamp, so it wins over every earlier write it knew about.
     * A level over a revocation restores it; anything else carries the revocation it knew.
     */
    readonly put: (input: {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly nodeId: string | null;
      readonly access: TailnetDeviceAccess;
    }) => Effect.Effect<NetworkMember, TailnetDevicesError>;
    /** Binds an unbound member to the node that proved it, after the owner consented here. */
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
     * access, except its own revocation: that is how a machine leaves. `narrowOnly` takes only
     * entries that narrow or revoke a member or app already here.
     */
    readonly merge: (
      sender: EnvironmentId,
      roster: {
        readonly members: ReadonlyArray<NetworkMember>;
        readonly apps: ReadonlyArray<NetworkApp>;
      },
      options?: { readonly narrowOnly?: boolean },
    ) => Effect.Effect<RosterCuts, TailnetDevicesError>;
    /**
     * Takes entries without the sender rule: the roster a machine joining a network was offered,
     * or a seed stamped at zero that only fills a gap.
     */
    readonly adopt: (roster: {
      readonly members: ReadonlyArray<NetworkMember>;
      readonly apps?: ReadonlyArray<NetworkApp>;
    }) => Effect.Effect<void, TailnetDevicesError>;
    /**
     * Drops an entry that never replicated, to undo an admission or join that did not complete.
     * Anything already shared is changed with `put` instead, so a tombstone is never lost.
     */
    readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, TailnetDevicesError>;
    /** Removes a revoked member or app from this machine's view; the tombstone stays. */
    readonly hide: (
      target: { readonly environmentId: EnvironmentId } | { readonly appId: string },
    ) => Effect.Effect<void, TailnetDevicesError>;
    /** Members and apps removed from this machine's view. */
    readonly hidden: Effect.Effect<
      { readonly members: ReadonlySet<string>; readonly apps: ReadonlySet<string> },
      TailnetDevicesError
    >;
    /** Forgets the whole network here, when this machine leaves it. Local links stay. */
    readonly clear: Effect.Effect<void, TailnetDevicesError>;
    /** Every write after subscribing. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<RosterChange>, never, Scope.Scope>;
  }
>()("t3/peer/Membership") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const lastStamp = yield* Ref.make<TailnetHlc | null>(null);
  const changes = yield* PubSub.unbounded<RosterChange>();
  const changed = (change: RosterChange = "written") => PubSub.publish(changes, change);
  // Reads, merges and writes of the roster happen one at a time.
  const writes = yield* Semaphore.make(1);

  const memberRows = sql<MemberRow>`SELECT * FROM network_members`.pipe(
    Effect.mapError(storageError),
  );

  const members: Membership["Service"]["members"] = memberRows.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Effect.all([
          decodeStamp(row.stamp_json),
          row.restores_json === null ? Effect.undefined : decodeStamp(row.restores_json),
        ]).pipe(
          Effect.flatMap(([updatedAt, restores]) =>
            decodeMember({
              environmentId: row.environment_id,
              label: row.label,
              nodeId: row.node_id,
              // An unreadable level fails closed.
              access: isAccess(row.access) ? row.access : "revoked",
              updatedAt,
              ...(restores === undefined ? {} : { restores }),
            }),
          ),
        ),
      ),
    ),
    Effect.mapError(storageError),
  );

  const appRows = sql<AppRow>`SELECT * FROM network_apps`.pipe(Effect.mapError(storageError));

  const apps: Membership["Service"]["apps"] = appRows.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeStamp(row.stamp_json).pipe(
          Effect.flatMap((updatedAt) =>
            decodeApp({
              appId: row.app_id,
              label: row.label,
              access: isAccess(row.access) ? row.access : "revoked",
              updatedAt,
            }),
          ),
        ),
      ),
    ),
    Effect.mapError(storageError),
  );

  const hidden: Membership["Service"]["hidden"] = Effect.all([memberRows, appRows]).pipe(
    Effect.map(([memberList, appList]) => ({
      members: new Set(
        memberList.filter((row) => row.hidden !== 0).map((row) => row.environment_id),
      ),
      apps: new Set(appList.filter((row) => row.hidden !== 0).map((row) => row.app_id)),
    })),
  );

  const appAccessOf: Membership["Service"]["appAccessOf"] = Effect.fn("Membership.appAccessOf")(
    function* (appId) {
      const found = yield* apps.pipe(
        Effect.map((all) => all.find((app) => app.appId === appId)),
        // An app roster that cannot be read admits no app.
        Effect.orElseSucceed(() => ({ access: "revoked" as const })),
      );
      return found === undefined ? Option.none() : Option.some(found.access);
    },
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

  const local: Membership["Service"]["local"] = sql<{
    readonly environment_id: string;
    readonly label: string;
    readonly node_id: string;
    readonly access: string;
  }>`SELECT * FROM network_local_members`.pipe(
    Effect.map((rows) =>
      rows.map((row): LocalMember => ({
        environmentId: row.environment_id as EnvironmentId,
        label: row.label,
        nodeId: row.node_id,
        access: isClientAccess(row.access) ? row.access : "read-only",
      })),
    ),
    Effect.mapError(storageError),
  );

  const accessOf: Membership["Service"]["accessOf"] = Effect.fn("Membership.accessOf")(
    function* (environmentId) {
      const found = yield* member(environmentId).pipe(
        // A roster that cannot be read admits nobody.
        Effect.orElseSucceed(() =>
          Option.some({ access: "revoked" as const } as Pick<NetworkMember, "access">),
        ),
      );
      if (Option.isNone(found)) {
        const linked = yield* local.pipe(
          Effect.map((all) => all.find((entry) => entry.environmentId === environmentId)),
          Effect.orElseSucceed(() => ({ access: "read-only" as const })),
        );
        return Option.fromNullishOr(linked?.access);
      }
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
        (latest, stamp) =>
          latest === null || compareTailnetHlc(stamp, latest) > 0 ? stamp : latest,
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
  yield* Effect.all([members, apps]).pipe(
    Effect.flatMap(([storedMembers, storedApps]) =>
      observe([...storedMembers, ...storedApps].map((entry) => entry.updatedAt)),
    ),
    Effect.ignore,
  );

  const writeApp = (entry: NetworkApp) =>
    encodeStamp(entry.updatedAt).pipe(
      Effect.flatMap(
        (stampJson) => sql`
          INSERT INTO network_apps (app_id, label, access, stamp_json)
          VALUES (${entry.appId}, ${entry.label}, ${entry.access}, ${stampJson})
          ON CONFLICT (app_id) DO UPDATE SET
            label = excluded.label,
            access = excluded.access,
            stamp_json = excluded.stamp_json
        `,
      ),
      Effect.mapError(storageError),
    );

  /**
   * The level an older build would read, in the table it reads: without a row there it lets a
   * machine in at its default, full access, so a revocation must survive a downgrade.
   */
  const writeLegacyPolicy = Effect.fn("Membership.writeLegacyPolicy")(function* (
    entry: NetworkMember,
    stampJson: string,
  ) {
    const limit = (yield* limits).get(entry.environmentId);
    const access =
      entry.access === "revoked" || limit === undefined
        ? entry.access
        : narrowerAccess(entry.access, limit);
    yield* writePolicyRow(entry.environmentId, access, stampJson, entry.updatedAt.node);
  });

  const writePolicyRow = (
    environmentId: EnvironmentId,
    access: TailnetDeviceAccess,
    stampJson: string,
    updatedBy: EnvironmentId,
  ) => sql`
    INSERT INTO tailnet_device_policy (environment_id, access, stamp_json, updated_by)
    VALUES (${environmentId}, ${access}, ${stampJson}, ${updatedBy})
    ON CONFLICT (environment_id) DO UPDATE SET
      access = excluded.access,
      stamp_json = excluded.stamp_json,
      updated_by = excluded.updated_by
  `;

  /**
   * The older build's level for a machine outside the roster: its link here only, or none once
   * that is forgotten. A roster entry is already mirrored by its own writes and outranks it here.
   */
  const writeLegacyLocal = Effect.fn("Membership.writeLegacyLocal")(function* (
    environmentId: EnvironmentId,
    access: TailnetDeviceAccess,
  ) {
    if (Option.isSome(yield* member(environmentId))) return;
    const at = yield* stamp;
    yield* writePolicyRow(environmentId, access, yield* encodeStamp(at), at.node);
  });

  const write = (entry: NetworkMember) =>
    Effect.all([
      encodeStamp(entry.updatedAt),
      entry.restores === undefined ? Effect.succeed(null) : encodeStamp(entry.restores),
    ]).pipe(
      Effect.flatMap(([stampJson, restoresJson]) =>
        sql`
          INSERT INTO network_members
            (environment_id, label, node_id, access, stamp_json, restores_json)
          VALUES (
            ${entry.environmentId}, ${entry.label}, ${entry.nodeId}, ${entry.access},
            ${stampJson}, ${restoresJson}
          )
          ON CONFLICT (environment_id) DO UPDATE SET
            label = excluded.label,
            node_id = excluded.node_id,
            access = excluded.access,
            stamp_json = excluded.stamp_json,
            restores_json = excluded.restores_json,
            hidden = CASE WHEN excluded.access = 'revoked' THEN network_members.hidden ELSE 0 END
        `.pipe(Effect.andThen(writeLegacyPolicy(entry, stampJson)), sql.withTransaction),
      ),
      Effect.mapError(storageError),
    );

  const put: Membership["Service"]["put"] = Effect.fn("Membership.put")(
    function* (input) {
      const before = yield* member(input.environmentId);
      const restores =
        input.access === "revoked" || Option.isNone(before)
          ? undefined
          : before.value.access === "revoked"
            ? before.value.updatedAt
            : before.value.restores;
      const entry: NetworkMember = {
        ...input,
        updatedAt: yield* stamp,
        ...(restores === undefined ? {} : { restores }),
      };
      yield* write(entry);
      yield* changed();
      return entry;
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const putApp: Membership["Service"]["putApp"] = Effect.fn("Membership.putApp")(
    function* (input) {
      const before = (yield* apps).find((app) => app.appId === input.appId);
      const app: NetworkApp = { ...input, updatedAt: yield* stamp };
      yield* writeApp(app);
      yield* changed();
      return { app, cut: before !== undefined && narrowsAccess(before.access, app.access) };
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const redeemApp: Membership["Service"]["redeemApp"] = Effect.fn("Membership.redeemApp")(
    function* ({ replaces, ...input }) {
      const current = yield* apps;
      const before = current.find((app) => app.appId === input.appId);
      if (before !== undefined) return before.access === "revoked" ? "revoked" : "known";
      yield* writeApp({ ...input, updatedAt: yield* stamp });
      const replaced = current.find((app) => app.appId === replaces);
      if (replaced !== undefined) {
        yield* writeApp({ ...replaced, access: "revoked", updatedAt: yield* stamp });
        yield* sql`UPDATE network_apps SET hidden = 1 WHERE app_id = ${replaced.appId}`.pipe(
          Effect.mapError(storageError),
        );
      }
      yield* changed("appRedeemed");
      return "added";
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const bindNode: Membership["Service"]["bindNode"] = Effect.fn("Membership.bindNode")(
    function* (environmentId, nodeId) {
      const found = yield* member(environmentId);
      if (Option.isNone(found) || found.value.nodeId !== null) return;
      yield* write({ ...found.value, nodeId, updatedAt: yield* stamp });
      yield* changed();
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const setLimit: Membership["Service"]["setLimit"] = Effect.fn("Membership.setLimit")(
    function* (environmentId, limit) {
      const found = yield* member(environmentId);
      yield* (
        limit === null
          ? sql`DELETE FROM network_member_limits WHERE environment_id = ${environmentId}`
          : sql`
              INSERT INTO network_member_limits (environment_id, access) VALUES (${environmentId}, ${limit})
              ON CONFLICT (environment_id) DO UPDATE SET access = excluded.access
            `
      ).pipe(
        Effect.andThen(
          Option.isNone(found)
            ? Effect.void
            : encodeStamp(found.value.updatedAt).pipe(
                Effect.flatMap((stampJson) => writeLegacyPolicy(found.value, stampJson)),
              ),
        ),
        sql.withTransaction,
        Effect.mapError(storageError),
      );
      yield* changed();
    },
  );

  const putLocal: Membership["Service"]["putLocal"] = Effect.fn("Membership.putLocal")(
    function* (input) {
      yield* sql`
        INSERT INTO network_local_members (environment_id, label, node_id, access)
        VALUES (${input.environmentId}, ${input.label}, ${input.nodeId}, ${input.access})
        ON CONFLICT (environment_id) DO UPDATE SET
          label = excluded.label,
          node_id = excluded.node_id,
          access = excluded.access
      `.pipe(
        Effect.andThen(writeLegacyLocal(input.environmentId, input.access)),
        sql.withTransaction,
        Effect.mapError(storageError),
      );
      yield* changed();
    },
  );

  const forgetLocal: Membership["Service"]["forgetLocal"] = Effect.fn("Membership.forgetLocal")(
    function* (environmentId) {
      yield* sql`DELETE FROM network_local_members WHERE environment_id = ${environmentId}`.pipe(
        Effect.andThen(writeLegacyLocal(environmentId, "revoked")),
        sql.withTransaction,
        Effect.mapError(storageError),
      );
      yield* changed();
    },
  );

  const applyApps = Effect.fn("Membership.applyApps")(function* (
    incoming: ReadonlyArray<NetworkApp>,
  ) {
    const current = new Map((yield* apps).map((app) => [app.appId, app]));
    const next = mergeApps(current, incoming);
    const cut: Array<string> = [];
    let wrote = false;
    for (const [appId, app] of next) {
      const before = current.get(appId);
      if (before === app) continue;
      yield* writeApp(app);
      wrote = true;
      if (before !== undefined && narrowsAccess(before.access, app.access)) cut.push(appId);
    }
    yield* observe(incoming.map((app) => app.updatedAt));
    return { cut, wrote };
  });

  const applyRoster = Effect.fn("Membership.applyRoster")(function* (
    incoming: ReadonlyArray<NetworkMember>,
  ) {
    const stored = yield* members;
    const current = new Map(stored.map((entry) => [entry.environmentId, entry]));
    const next = mergeMembers(current, incoming);
    const revoked: Array<EnvironmentId> = [];
    const narrowed: Array<EnvironmentId> = [];
    const added: Array<EnvironmentId> = [];
    let wrote = false;
    for (const [environmentId, entry] of next) {
      const before = current.get(environmentId);
      if (before === entry) continue;
      wrote = true;
      // A bound node is never dropped for an unbound copy. Restamped, so the binding spreads,
      // except a revocation: its stamp is its rank, and names who revoked it (a leave or not).
      if (entry.nodeId === null && before !== undefined && before.nodeId !== null) {
        yield* write({
          ...entry,
          nodeId: before.nodeId,
          updatedAt: entry.access === "revoked" ? entry.updatedAt : yield* stamp,
        });
      } else {
        yield* write(entry);
      }
      if (before === undefined) added.push(environmentId);
      if (entry.access === "revoked" && before?.access !== "revoked") revoked.push(environmentId);
      else if (before !== undefined && narrowsAccess(before.access, entry.access)) {
        narrowed.push(environmentId);
      }
    }
    yield* observe(incoming.map((entry) => entry.updatedAt));
    return { revoked, narrowed, added, wrote };
  });

  const merge: Membership["Service"]["merge"] = Effect.fn("Membership.merge")(
    function* (sender, roster, options) {
      let memberWrites = roster.members.filter(
        (entry) => entry.environmentId !== sender || entry.access === "revoked",
      );
      let appWrites = roster.apps;
      if (options?.narrowOnly === true) {
        const knownMembers = new Map((yield* members).map((entry) => [entry.environmentId, entry]));
        const knownApps = new Map((yield* apps).map((app) => [app.appId, app]));
        memberWrites = memberWrites.filter((entry) => {
          const known = knownMembers.get(entry.environmentId);
          return known !== undefined && narrowsAccess(known.access, entry.access);
        });
        appWrites = appWrites.filter((app) => {
          const known = knownApps.get(app.appId);
          return known !== undefined && narrowsAccess(known.access, app.access);
        });
      }
      const { wrote, ...memberCuts } = yield* applyRoster(memberWrites);
      const appCuts = yield* applyApps(appWrites);
      if (wrote || appCuts.wrote) yield* changed();
      return { ...memberCuts, appsCut: appCuts.cut };
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const adopt: Membership["Service"]["adopt"] = Effect.fn("Membership.adopt")(
    function* (roster) {
      yield* applyRoster(roster.members);
      yield* applyApps(roster.apps ?? []);
      yield* changed();
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const forget: Membership["Service"]["forget"] = Effect.fn("Membership.forget")(
    function* (environmentId) {
      yield* sql`DELETE FROM network_members WHERE environment_id = ${environmentId}`.pipe(
        Effect.mapError(storageError),
      );
      yield* changed();
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const hide: Membership["Service"]["hide"] = Effect.fn("Membership.hide")(function* (target) {
    yield* (
      "appId" in target
        ? sql`UPDATE network_apps SET hidden = 1 WHERE app_id = ${target.appId}`
        : sql`UPDATE network_members SET hidden = 1 WHERE environment_id = ${target.environmentId}`
    ).pipe(Effect.mapError(storageError));
    yield* changed();
  });

  const clear: Membership["Service"]["clear"] = Effect.gen(function* () {
    yield* sql`DELETE FROM network_members`;
    yield* sql`DELETE FROM network_apps`;
    yield* sql`DELETE FROM network_member_limits`;
  }).pipe(
    Effect.mapError(storageError),
    Effect.andThen(changed()),
    writes.withPermits(1),
    Effect.withSpan("Membership.clear"),
  );

  return Membership.of({
    members,
    apps,
    appAccessOf,
    putApp,
    redeemApp,
    member,
    limits,
    local,
    putLocal,
    forgetLocal,
    accessOf,
    put,
    bindNode,
    setLimit,
    merge,
    adopt,
    forget,
    hide,
    hidden,
    clear,
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(Membership, make);
