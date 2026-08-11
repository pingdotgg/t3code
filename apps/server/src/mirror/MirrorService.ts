/**
 * MirrorService - host-side orchestration of project mirroring.
 *
 * Owns the registry of connected origin agents (one per mirrored project),
 * the directive/response broker over the mirror.connect stream (the
 * previewAutomation pattern), and the sync state machine: seed, pre-turn
 * push (`ensureFresh`, the turn gate), and post-turn apply-back. Sync
 * watermarks and the queued apply-back survive restarts in
 * `mirror_sync_runtime`.
 *
 * @module MirrorService
 */
import {
  MirrorOriginOfflineError,
  MirrorProjectNotMirroredError,
  MirrorSyncFailedError,
  type MirrorAgentResponse,
  type MirrorConnectInput,
  type MirrorConnectionId,
  type MirrorDirective,
  type MirrorProjectStatus,
  type MirrorRefUpdate,
  type MirrorRespondInput,
  type MirrorStreamEvent,
  type MirrorSyncReason,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { GitSync, mirrorSnapshotRef } from "./GitSync.ts";
import { MirrorBundleTransfer } from "./MirrorBundleTransfer.ts";
import { MirrorHooks } from "./MirrorHooks.ts";
import { MIRROR_EXTRA_ENV_PATTERNS, readMirrorIncludePaths } from "./mirrorInclude.ts";
import { diffGitlinks, discoverAllGitlinks, MIRROR_SUBMODULE_MAX_DEPTH } from "./SubmoduleSync.ts";

const SEED_TIMEOUT = Duration.minutes(30);
const SYNC_TIMEOUT = Duration.minutes(10);
const APPLY_TIMEOUT = Duration.minutes(10);

const PendingApplySubmoduleSchema = Schema.Struct({
  path: Schema.String,
  syncId: Schema.String,
  targetOid: Schema.String,
  baseOid: Schema.NullOr(Schema.String),
});

const PendingApplySchema = Schema.Struct({
  syncId: Schema.String,
  targetOid: Schema.String,
  refUpdates: Schema.Array(Schema.Struct({ ref: Schema.String, oid: Schema.String })),
  submodules: Schema.optional(Schema.Array(PendingApplySubmoduleSchema)),
});
type PendingApply = typeof PendingApplySchema.Type;
const PendingApplyJson = Schema.fromJsonString(PendingApplySchema);
const decodePendingApply = Schema.decodeUnknownOption(PendingApplyJson);
const encodePendingApply = Schema.encodeSync(PendingApplyJson);

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStringArray = Schema.decodeUnknownOption(StringArrayJson);
const encodeStringArray = Schema.encodeSync(StringArrayJson);

/** path -> last snapshot oid synced onto the mirror-side nested repository. */
const SubmoduleStateSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ lastSyncedSnapshotOid: Schema.String }),
);
type SubmoduleState = typeof SubmoduleStateSchema.Type;
const SubmoduleStateJson = Schema.fromJsonString(SubmoduleStateSchema);
const decodeSubmoduleState = Schema.decodeUnknownOption(SubmoduleStateJson);
const encodeSubmoduleState = Schema.encodeSync(SubmoduleStateJson);

const SubmoduleWarningSchema = Schema.Struct({ path: Schema.String, detail: Schema.String });
const SubmoduleWarningsJson = Schema.fromJsonString(Schema.Array(SubmoduleWarningSchema));
const decodeSubmoduleWarnings = Schema.decodeUnknownOption(SubmoduleWarningsJson);
const encodeSubmoduleWarnings = Schema.encodeSync(SubmoduleWarningsJson);

interface MirrorRuntimeRow {
  readonly projectId: string;
  readonly lastSyncedSnapshotOid: string | null;
  readonly lastSyncedAt: string | null;
  readonly lastBranchesJson: string | null;
  readonly pendingApplyJson: string | null;
  readonly conflictPathsJson: string | null;
  readonly submoduleStateJson: string | null;
  readonly submoduleWarningsJson: string | null;
}

interface AgentConnection {
  readonly projectId: ProjectId;
  readonly connectionId: string;
  readonly queue: Queue.Queue<MirrorStreamEvent>;
  /** Whether this origin's MirrorAgent understands submodule-* directives. */
  readonly supportsSubmodules: boolean;
}

interface PendingRequest {
  readonly connectionId: string;
  readonly deferred: Deferred.Deferred<MirrorAgentResponse, MirrorSyncFailedError>;
}

interface ServiceState {
  readonly connections: ReadonlyMap<string, AgentConnection>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  /** Transient activity used to derive the status `state` field. */
  readonly activity: ReadonlyMap<string, "seeding" | "syncing" | "applying">;
}

export class MirrorService extends Context.Service<
  MirrorService,
  {
    readonly connect: (
      input: MirrorConnectInput,
    ) => Effect.Effect<Stream.Stream<MirrorStreamEvent>, MirrorProjectNotMirroredError>;
    readonly respond: (input: MirrorRespondInput) => Effect.Effect<void, MirrorSyncFailedError>;
    /**
     * The project a live connection id belongs to, or null if there is no
     * such connection. Used to bind `mirror.respond` to the caller's
     * authenticated peer subject before the response is accepted.
     */
    readonly projectIdForConnection: (
      connectionId: MirrorConnectionId,
    ) => Effect.Effect<ProjectId | null>;
    /**
     * The turn gate: bring the mirror up to date with the origin working
     * copy before a turn starts. No-op for projects without an origin.
     */
    readonly ensureFresh: (
      projectId: ProjectId,
      options?: { readonly reason?: MirrorSyncReason },
    ) => Effect.Effect<
      void,
      MirrorOriginOfflineError | MirrorSyncFailedError | MirrorProjectNotMirroredError
    >;
    /** Queue and deliver a post-turn apply-back; resolves once delivery finishes (or is queued for later). */
    readonly applyBack: (projectId: ProjectId) => Effect.Effect<void>;
    /**
     * Stage a post-turn apply-back synchronously (snapshot + persist under
     * the project lock) and deliver it in the background. Use this instead
     * of `applyBack` when the caller must not block on network delivery to
     * the origin but a following turn's `ensureFresh` must never race the
     * still-unstaged mirror working tree.
     */
    readonly queueApplyBack: (projectId: ProjectId) => Effect.Effect<void>;
    readonly requestSync: (
      projectId: ProjectId,
    ) => Effect.Effect<
      void,
      MirrorOriginOfflineError | MirrorSyncFailedError | MirrorProjectNotMirroredError
    >;
    readonly originConnected: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly statusStream: (
      projectId?: ProjectId,
    ) => Effect.Effect<Stream.Stream<MirrorProjectStatus>>;
    readonly isMirroredProject: (projectId: ProjectId) => Effect.Effect<boolean>;
    /**
     * Tell a connected origin its link is gone (host project deleted or
     * detached) so it deletes its mirror_links row and stored token, and
     * drop the host-side sync runtime rows. Best-effort: a disconnected
     * origin simply stops retrying via the stale-link path instead.
     */
    readonly revokeLink: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/mirror/MirrorService") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const gitSync = yield* GitSync;
  const transfer = yield* MirrorBundleTransfer;
  const projects = yield* ProjectionProjectRepository;
  const hooks = yield* MirrorHooks;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const includePathsFor = readMirrorIncludePaths({ fileSystem, path });
  /** Union a repo root's t3.json include list with the project's DB-configured extra patterns. */
  const withExtraIncludePaths = (
    paths: ReadonlyArray<string>,
    project: { readonly mirrorIncludeIgnoredFiles?: boolean | null },
  ): ReadonlyArray<string> =>
    project.mirrorIncludeIgnoredFiles
      ? [...new Set([...paths, ...MIRROR_EXTRA_ENV_PATTERNS])]
      : paths;

  const state = yield* SynchronizedRef.make<ServiceState>({
    connections: new Map(),
    pending: new Map(),
    activity: new Map(),
  });
  const statusPubSub = yield* PubSub.unbounded<MirrorProjectStatus>();

  // One sync flow at a time per project: connect forks the seed while a
  // first turn's ensureFresh may race it, and an apply-back must never
  // interleave with a push against the same mirror.
  const projectLocks = new Map<string, Semaphore.Semaphore>();
  const withProjectLock = <A, E, R>(
    projectId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let lock = projectLocks.get(projectId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        projectLocks.set(projectId, lock);
      }
      return lock.withPermits(1)(effect);
    });

  // --- runtime persistence -------------------------------------------------

  const loadRuntime = Effect.fn("MirrorService.loadRuntime")(function* (projectId: string) {
    const rows = yield* sql<MirrorRuntimeRow>`
      SELECT
        project_id AS "projectId",
        last_synced_snapshot_oid AS "lastSyncedSnapshotOid",
        last_synced_at AS "lastSyncedAt",
        last_branches_json AS "lastBranchesJson",
        pending_apply_json AS "pendingApplyJson",
        conflict_paths_json AS "conflictPathsJson",
        submodule_state_json AS "submoduleStateJson",
        submodule_warnings_json AS "submoduleWarningsJson"
      FROM mirror_sync_runtime
      WHERE project_id = ${projectId}
    `.pipe(Effect.orDie);
    return rows[0] ?? null;
  });

  const saveRuntime = Effect.fn("MirrorService.saveRuntime")(function* (input: {
    readonly projectId: string;
    readonly lastSyncedSnapshotOid?: string | null;
    readonly lastSyncedAt?: string | null;
    readonly lastBranchesJson?: string | null;
    readonly pendingApplyJson?: string | null;
    readonly conflictPathsJson?: string | null;
    readonly submoduleStateJson?: string | null;
    readonly submoduleWarningsJson?: string | null;
  }) {
    const existing = yield* loadRuntime(input.projectId);
    const next = {
      lastSyncedSnapshotOid:
        input.lastSyncedSnapshotOid !== undefined
          ? input.lastSyncedSnapshotOid
          : (existing?.lastSyncedSnapshotOid ?? null),
      lastSyncedAt:
        input.lastSyncedAt !== undefined ? input.lastSyncedAt : (existing?.lastSyncedAt ?? null),
      lastBranchesJson:
        input.lastBranchesJson !== undefined
          ? input.lastBranchesJson
          : (existing?.lastBranchesJson ?? null),
      pendingApplyJson:
        input.pendingApplyJson !== undefined
          ? input.pendingApplyJson
          : (existing?.pendingApplyJson ?? null),
      conflictPathsJson:
        input.conflictPathsJson !== undefined
          ? input.conflictPathsJson
          : (existing?.conflictPathsJson ?? null),
      submoduleStateJson:
        input.submoduleStateJson !== undefined
          ? input.submoduleStateJson
          : (existing?.submoduleStateJson ?? null),
      submoduleWarningsJson:
        input.submoduleWarningsJson !== undefined
          ? input.submoduleWarningsJson
          : (existing?.submoduleWarningsJson ?? null),
    };
    yield* sql`
      INSERT INTO mirror_sync_runtime (
        project_id,
        last_synced_snapshot_oid,
        last_synced_at,
        last_branches_json,
        pending_apply_json,
        conflict_paths_json,
        submodule_state_json,
        submodule_warnings_json
      )
      VALUES (
        ${input.projectId},
        ${next.lastSyncedSnapshotOid},
        ${next.lastSyncedAt},
        ${next.lastBranchesJson},
        ${next.pendingApplyJson},
        ${next.conflictPathsJson},
        ${next.submoduleStateJson},
        ${next.submoduleWarningsJson}
      )
      ON CONFLICT (project_id)
      DO UPDATE SET
        last_synced_snapshot_oid = excluded.last_synced_snapshot_oid,
        last_synced_at = excluded.last_synced_at,
        last_branches_json = excluded.last_branches_json,
        pending_apply_json = excluded.pending_apply_json,
        conflict_paths_json = excluded.conflict_paths_json,
        submodule_state_json = excluded.submodule_state_json,
        submodule_warnings_json = excluded.submodule_warnings_json
    `.pipe(Effect.orDie);
  });

  // --- project helpers -----------------------------------------------------

  const resolveMirroredProject = Effect.fn("MirrorService.resolveMirroredProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById({ projectId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (
      Option.isNone(project) ||
      project.value.origin == null ||
      project.value.deletedAt !== null
    ) {
      return null;
    }
    return project.value;
  });

  // --- status --------------------------------------------------------------

  const publishStatus = Effect.fn("MirrorService.publishStatus")(function* (projectId: ProjectId) {
    const status = yield* currentStatus(projectId);
    if (status !== null) yield* PubSub.publish(statusPubSub, status);
  });

  const currentStatus = Effect.fn("MirrorService.currentStatus")(function* (
    projectId: ProjectId,
  ): Effect.fn.Return<MirrorProjectStatus | null> {
    const project = yield* resolveMirroredProject(projectId);
    if (project === null) return null;
    const current = yield* SynchronizedRef.get(state);
    const connected = current.connections.has(projectId);
    const runtime = yield* loadRuntime(projectId);
    const conflictPaths =
      runtime?.conflictPathsJson != null
        ? Option.getOrElse(decodeStringArray(runtime.conflictPathsJson), () => [])
        : [];
    const submoduleWarnings =
      runtime?.submoduleWarningsJson != null
        ? Option.getOrElse(decodeSubmoduleWarnings(runtime.submoduleWarningsJson), () => [])
        : [];
    const activity = current.activity.get(projectId);
    const seeded = runtime?.lastSyncedSnapshotOid != null;
    const stateValue = activity
      ? activity
      : !seeded
        ? "seeding"
        : conflictPaths.length > 0
          ? "conflict"
          : connected
            ? "idle"
            : "offline";
    const transferProgress =
      activity !== undefined ? yield* transfer.uploadProgressForProject(projectId) : null;
    return {
      projectId,
      state: stateValue,
      originConnected: connected,
      lastSyncedAt: runtime?.lastSyncedAt ?? null,
      lastSyncedSnapshotOid: runtime?.lastSyncedSnapshotOid ?? null,
      conflictPaths,
      submoduleWarnings,
      ...(transferProgress !== null ? { transfer: transferProgress } : {}),
    } satisfies MirrorProjectStatus;
  });

  const withActivity = <A, E, R>(
    projectId: ProjectId,
    activity: "seeding" | "syncing" | "applying",
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      SynchronizedRef.update(state, (current) => {
        const next = new Map(current.activity);
        next.set(projectId, activity);
        return { ...current, activity: next };
      }).pipe(
        Effect.andThen(publishStatus(projectId)),
        // While the activity runs, republish once a second whenever a bundle
        // upload is in flight so subscribers see transfer progress move.
        Effect.andThen(
          Effect.forkDetach(
            transfer.uploadProgressForProject(projectId).pipe(
              Effect.flatMap((progress) =>
                progress === null ? Effect.void : publishStatus(projectId),
              ),
              Effect.delay("1 second"),
              Effect.forever,
            ),
          ),
        ),
      ),
      () => effect,
      (progressFiber) =>
        Fiber.interrupt(progressFiber).pipe(
          Effect.andThen(
            SynchronizedRef.update(state, (current) => {
              const next = new Map(current.activity);
              next.delete(projectId);
              return { ...current, activity: next };
            }),
          ),
          Effect.andThen(publishStatus(projectId)),
        ),
    );

  // --- broker --------------------------------------------------------------

  const failPending = (
    projectId: ProjectId,
    pending: ReadonlyArray<[string, PendingRequest]>,
    detail: string,
  ) =>
    Effect.forEach(
      pending,
      ([syncId, entry]) =>
        Deferred.fail(
          entry.deferred,
          new MirrorSyncFailedError({
            projectId,
            syncId,
            detail,
          }),
        ),
      { discard: true },
    );

  const disconnect = Effect.fn("MirrorService.disconnect")(function* (
    projectId: ProjectId,
    queue: Queue.Queue<MirrorStreamEvent>,
  ) {
    const dropped = yield* SynchronizedRef.modify(state, (current) => {
      if (current.connections.get(projectId)?.queue !== queue) {
        return [[] as Array<[string, PendingRequest]>, current] as const;
      }
      const connections = new Map(current.connections);
      const removed = connections.get(projectId);
      connections.delete(projectId);
      const pending = new Map(current.pending);
      const dropped: Array<[string, PendingRequest]> = [];
      for (const [syncId, entry] of pending) {
        if (entry.connectionId === removed?.connectionId) {
          pending.delete(syncId);
          dropped.push([syncId, entry]);
        }
      }
      return [dropped, { ...current, connections, pending }] as const;
    });
    yield* failPending(projectId, dropped, "The origin agent disconnected mid-sync.");
    yield* Queue.shutdown(queue);
    yield* publishStatus(projectId);
  });

  const connect: MirrorService["Service"]["connect"] = Effect.fn("MirrorService.connect")(
    function* (input) {
      const project = yield* resolveMirroredProject(input.projectId);
      if (project === null) {
        return yield* new MirrorProjectNotMirroredError({ projectId: input.projectId });
      }
      const runtime = yield* loadRuntime(input.projectId);
      const needsSeed = runtime?.lastSyncedSnapshotOid == null;
      const extraIncludePaths = project.mirrorIncludeIgnoredFiles ? MIRROR_EXTRA_ENV_PATTERNS : [];

      const acquire = Effect.gen(function* () {
        const queue = yield* Queue.unbounded<MirrorStreamEvent>();
        const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* Queue.offer(queue, {
          type: "connected",
          connectionId,
          needsSeed,
          extraIncludePaths,
        });
        const connection: AgentConnection = {
          projectId: input.projectId,
          connectionId,
          queue,
          supportsSubmodules: input.supportsSubmodules === true,
        };
        // The old connection's pending requests must be dropped in the same
        // atomic step that replaces it: calling disconnect() afterward would
        // check current.connections against the now-superseded queue and
        // find no match, silently skipping failPending and leaking the old
        // requests until their multi-minute timeout.
        const { previous, droppedPending } = yield* SynchronizedRef.modify(state, (current) => {
          const connections = new Map(current.connections);
          const previous = connections.get(input.projectId);
          connections.set(input.projectId, connection);
          const pending = new Map(current.pending);
          const droppedPending: Array<[string, PendingRequest]> = [];
          if (previous !== undefined) {
            for (const [syncId, entry] of pending) {
              if (entry.connectionId === previous.connectionId) {
                pending.delete(syncId);
                droppedPending.push([syncId, entry]);
              }
            }
          }
          return [
            { previous, droppedPending },
            { ...current, connections, pending },
          ] as const;
        });
        if (previous !== undefined) {
          yield* failPending(
            input.projectId,
            droppedPending,
            "A new origin connection replaced this one.",
          );
          yield* Queue.shutdown(previous.queue);
        }
        yield* publishStatus(input.projectId);
        // Kick work the agent owes us as soon as it appears: the initial
        // seed, or a queued apply-back from a turn that finished while the
        // origin was offline.
        yield* Effect.forkDetach(
          withProjectLock(
            input.projectId,
            needsSeed
              ? seedCore(input.projectId).pipe(Effect.ignore)
              : processPendingApplyCore(input.projectId).pipe(Effect.ignore),
          ),
        );
        return connection;
      });

      return Stream.unwrap(
        Effect.acquireRelease(acquire, (connection) =>
          disconnect(input.projectId, connection.queue),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      );
    },
  );

  const respond: MirrorService["Service"]["respond"] = Effect.fn("MirrorService.respond")(
    function* (input) {
      const entry = yield* SynchronizedRef.modify(state, (current) => {
        const entry = current.pending.get(input.response.syncId);
        if (!entry || entry.connectionId !== input.connectionId) {
          return [undefined, current] as const;
        }
        const pending = new Map(current.pending);
        pending.delete(input.response.syncId);
        return [entry, { ...current, pending }] as const;
      });
      if (!entry) return;
      yield* Deferred.succeed(entry.deferred, input.response);
    },
  );

  /** Send one directive to the project's agent and await its response. */
  const request = Effect.fn("MirrorService.request")(function* (input: {
    readonly projectId: ProjectId;
    readonly originLabel: string | null;
    readonly syncId: string;
    readonly directive: MirrorDirective;
    readonly timeout: Duration.Duration;
  }): Effect.fn.Return<MirrorAgentResponse, MirrorOriginOfflineError | MirrorSyncFailedError> {
    const deferred = yield* Deferred.make<MirrorAgentResponse, MirrorSyncFailedError>();
    const connection = yield* SynchronizedRef.modify(state, (current) => {
      const connection = current.connections.get(input.projectId);
      if (!connection) return [undefined, current] as const;
      const pending = new Map(current.pending);
      pending.set(input.syncId, { connectionId: connection.connectionId, deferred });
      return [connection, { ...current, pending }] as const;
    });
    if (!connection) {
      return yield* new MirrorOriginOfflineError({
        projectId: input.projectId,
        originLabel: input.originLabel,
      });
    }
    const removePending = SynchronizedRef.update(state, (current) => {
      if (!current.pending.has(input.syncId)) return current;
      const pending = new Map(current.pending);
      pending.delete(input.syncId);
      return { ...current, pending };
    });
    // Re-resolve the project's current settings right before every directive:
    // the connection is long-lived, but a settings change (e.g. toggling
    // mirrorIncludeIgnoredFiles) should apply on the next sync, not only on
    // the next reconnect.
    const currentProject = yield* resolveMirroredProject(input.projectId);
    yield* Queue.offer(connection.queue, {
      type: "settings-updated",
      connectionId: connection.connectionId,
      extraIncludePaths: currentProject?.mirrorIncludeIgnoredFiles ? MIRROR_EXTRA_ENV_PATTERNS : [],
    });
    const offered = yield* Queue.offer(connection.queue, {
      type: "directive",
      connectionId: connection.connectionId,
      directive: input.directive,
    });
    if (!offered) {
      yield* removePending;
      return yield* new MirrorOriginOfflineError({
        projectId: input.projectId,
        originLabel: input.originLabel,
      });
    }
    const response = yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(input.timeout),
      Effect.ensuring(removePending),
    );
    if (Option.isNone(response)) {
      return yield* new MirrorSyncFailedError({
        projectId: input.projectId,
        syncId: input.syncId,
        detail: `The origin did not answer within ${Duration.toMillis(input.timeout) / 1000}s.`,
      });
    }
    const value = response.value;
    if (value.type === "sync-failed") {
      return yield* new MirrorSyncFailedError({
        projectId: input.projectId,
        syncId: input.syncId,
        detail: value.message,
      });
    }
    return value;
  });

  // --- sync flows ----------------------------------------------------------

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const ingestBranchUpdates = Effect.fn("MirrorService.ingestBranchUpdates")(function* (
    root: string,
  ) {
    const incoming = yield* gitSync.listRefs(root, "refs/t3/mirror/incoming");
    const updates: MirrorRefUpdate[] = incoming.map((entry) => ({
      ref: `refs/heads/${entry.ref.slice("refs/t3/mirror/incoming/".length)}`,
      oid: entry.oid,
    }));
    yield* gitSync.applyBranchUpdates({ root, refUpdates: updates });
    for (const entry of incoming) {
      yield* gitSync.updateRef(root, entry.ref, null);
    }
    const currentBranch = yield* gitSync.symbolicHead(root);
    if (currentBranch !== null && updates.some((update) => update.ref === currentBranch)) {
      yield* gitSync.resetIndexToHead(root);
    }
    return updates;
  });

  // --- submodule cascade -----------------------------------------------------
  //
  // Gitlinks (mode 160000 tree entries) never travel with a superproject
  // bundle. Once the top-level seed/sync has materialized the superproject
  // (which creates each gitlink's empty directory), diff gitlinks between the
  // base and target superproject trees and mirror every changed path through
  // the same seed/sync primitives, rooted at that path. Skipped entirely for
  // origins that predate submodule support.

  const submoduleCascadeSupported = (projectId: ProjectId) =>
    SynchronizedRef.get(state).pipe(
      Effect.map((current) => current.connections.get(projectId)?.supportsSubmodules === true),
    );

  /** Materialize a successful submodule-seed-uploaded response at `nestedRoot`. */
  const materializeSubmoduleSeed = Effect.fn("MirrorService.materializeSubmoduleSeed")(function* (
    nestedRoot: string,
    syncId: string,
    response: Extract<MirrorAgentResponse, { type: "submodule-seed-uploaded" }>,
  ) {
    const isRepo = yield* gitSync.isRepository(nestedRoot);
    if (!isRepo) yield* gitSync.initRepository(nestedRoot);
    const bundlePath = yield* transfer.stagingPath(syncId);
    yield* gitSync.fetchBundle({
      root: nestedRoot,
      bundlePath,
      refspecs: [
        "+refs/heads/*:refs/heads/*",
        "+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*",
      ],
    });
    yield* gitSync.checkoutSeedHead(nestedRoot, response.headRef, response.snapshotOid);
    const headCommit = yield* gitSync.headCommit(nestedRoot);
    if (headCommit !== null && headCommit !== response.snapshotOid) {
      yield* gitSync.applySnapshot({
        root: nestedRoot,
        syncId,
        baseOid: headCommit,
        targetOid: response.snapshotOid,
        conflictPreference: "target",
      });
    }
    yield* gitSync.setRemotes(nestedRoot, response.remotes);
    yield* gitSync
      .pruneSnapshotRefs({ root: nestedRoot, keepOids: [response.snapshotOid] })
      .pipe(Effect.ignore);
    yield* transfer.removeStaged(syncId);
  });

  /** Materialize a successful submodule-sync-uploaded response at `nestedRoot`. */
  const materializeSubmoduleSync = Effect.fn("MirrorService.materializeSubmoduleSync")(function* (
    nestedRoot: string,
    syncId: string,
    baseOid: string,
    targetOid: string,
  ) {
    const bundlePath = yield* transfer.stagingPath(syncId);
    yield* gitSync.fetchBundle({
      root: nestedRoot,
      bundlePath,
      refspecs: [
        "+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*",
        "+refs/heads/*:refs/t3/mirror/incoming/*",
      ],
    });
    yield* gitSync.applySnapshot({
      root: nestedRoot,
      syncId,
      baseOid,
      targetOid,
      conflictPreference: "target",
    });
    yield* ingestBranchUpdates(nestedRoot).pipe(Effect.ignore);
    yield* gitSync
      .pruneSnapshotRefs({ root: nestedRoot, keepOids: [targetOid] })
      .pipe(Effect.ignore);
    yield* transfer.removeStaged(syncId);
  });

  interface SubmoduleCascadeContext {
    readonly projectId: ProjectId;
    readonly originLabel: string | null;
    readonly reason: MirrorSyncReason;
  }

  /** Mirror one changed gitlink path, then recurse into its own gitlinks. */
  const processGitlink = (params: {
    readonly ctx: SubmoduleCascadeContext;
    readonly root: string;
    readonly gitlinkPath: string;
    readonly fullPath: string;
    readonly priorOid: string | null;
    readonly nextState: Record<string, { lastSyncedSnapshotOid: string }>;
    readonly warnings: Array<{ path: string; detail: string }>;
    readonly depth: number;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { ctx, root, gitlinkPath, fullPath, priorOid, nextState, warnings, depth } = params;
      const syncId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const nestedRoot = path.join(root, gitlinkPath);
      const outcome = yield* Effect.gen(function* () {
        const upload = yield* transfer.issueUrl({
          projectId: ctx.projectId,
          syncId,
          direction: "upload",
        });
        const directive: MirrorDirective =
          priorOid === null
            ? {
                type: "submodule-seed-requested",
                syncId,
                path: fullPath,
                uploadUrl: upload.relativeUrl,
                expiresAt: upload.expiresAt,
              }
            : {
                type: "submodule-sync-requested",
                syncId,
                path: fullPath,
                baseSnapshotOid: priorOid,
                uploadUrl: upload.relativeUrl,
                expiresAt: upload.expiresAt,
                reason: ctx.reason,
              };
        const response = yield* request({
          projectId: ctx.projectId,
          originLabel: ctx.originLabel,
          syncId,
          directive,
          timeout: SYNC_TIMEOUT,
        });
        if (response.type === "submodule-skipped") {
          warnings.push({ path: fullPath, detail: response.detail });
          return null;
        }
        if (
          response.type !== "submodule-seed-uploaded" &&
          response.type !== "submodule-sync-uploaded" &&
          response.type !== "submodule-sync-no-change"
        ) {
          warnings.push({
            path: fullPath,
            detail: `Unexpected agent response '${response.type}' to a submodule sync request.`,
          });
          return null;
        }
        if (response.type === "submodule-seed-uploaded") {
          yield* materializeSubmoduleSeed(nestedRoot, syncId, response);
        } else if (response.type === "submodule-sync-uploaded") {
          yield* materializeSubmoduleSync(nestedRoot, syncId, priorOid ?? "", response.snapshotOid);
        }
        nextState[fullPath] = { lastSyncedSnapshotOid: response.snapshotOid };
        return {
          snapshotOid: response.snapshotOid,
          changed: response.type !== "submodule-sync-no-change",
        };
      }).pipe(
        Effect.catch((cause) => {
          warnings.push({ path: fullPath, detail: cause.message });
          return Effect.succeed(null);
        }),
      );
      if (outcome === null || !outcome.changed || depth + 1 >= MIRROR_SUBMODULE_MAX_DEPTH) return;
      // Recurse into the just-materialized nested repo's own gitlinks.
      const nestedBaseTree =
        priorOid === null
          ? null
          : yield* gitSync
              .treeOfCommit(nestedRoot, priorOid)
              .pipe(Effect.orElseSucceed(() => null));
      const nestedTargetTree = yield* gitSync
        .treeOfCommit(nestedRoot, outcome.snapshotOid)
        .pipe(Effect.orElseSucceed(() => null));
      if (nestedTargetTree === null) return;
      yield* walkGitlinks({
        ctx,
        root: nestedRoot,
        baseTreeOid: nestedBaseTree,
        targetTreeOid: nestedTargetTree,
        pathPrefix: fullPath,
        depth: depth + 1,
        priorState: {},
        nextState,
        warnings,
      });
    });

  /** Diff gitlinks at one level and mirror every changed path. */
  const walkGitlinks = (params: {
    readonly ctx: SubmoduleCascadeContext;
    readonly root: string;
    readonly baseTreeOid: string | null;
    readonly targetTreeOid: string;
    readonly pathPrefix: string;
    readonly depth: number;
    readonly priorState: SubmoduleState;
    readonly nextState: Record<string, { lastSyncedSnapshotOid: string }>;
    readonly warnings: Array<{ path: string; detail: string }>;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const {
        ctx,
        root,
        baseTreeOid,
        targetTreeOid,
        pathPrefix,
        depth,
        priorState,
        nextState,
        warnings,
      } = params;
      if (depth >= MIRROR_SUBMODULE_MAX_DEPTH) return;
      const diffs = yield* diffGitlinks(gitSync, root, baseTreeOid, targetTreeOid).pipe(
        Effect.orElseSucceed(() => []),
      );
      const diffedPaths = new Set<string>();
      for (const entry of diffs) {
        const fullPath = pathPrefix === "" ? entry.path : `${pathPrefix}/${entry.path}`;
        diffedPaths.add(entry.path);
        if (entry.status === "removed") {
          delete nextState[fullPath];
          continue;
        }
        const priorOid = priorState[fullPath]?.lastSyncedSnapshotOid ?? null;
        yield* processGitlink({
          ctx,
          root,
          gitlinkPath: entry.path,
          fullPath,
          priorOid,
          nextState,
          warnings,
          depth,
        });
      }
      // `diffGitlinks` only reports paths whose gitlink oid moved between the
      // two trees. A gitlink that predates submodule mirroring support (or
      // was added by an origin that didn't support it yet) can sit unchanged
      // at the same oid across every sync forever, so it would never appear
      // in `diffs` and would never get its first seed. Catch those here by
      // comparing the target tree's gitlinks directly against `priorState`.
      const targetLinks = yield* gitSync
        .listGitlinks(root, targetTreeOid)
        .pipe(Effect.orElseSucceed(() => []));
      for (const link of targetLinks) {
        if (diffedPaths.has(link.path)) continue;
        const fullPath = pathPrefix === "" ? link.path : `${pathPrefix}/${link.path}`;
        if (priorState[fullPath] !== undefined) continue;
        yield* processGitlink({
          ctx,
          root,
          gitlinkPath: link.path,
          fullPath,
          priorOid: null,
          nextState,
          warnings,
          depth,
        });
      }
    });

  /**
   * Entry point called by seedCore/ensureFreshCore right after the top-level
   * superproject checkout/apply has materialized (so gitlink paths already
   * exist as empty directories). No-ops for origins without submodule
   * support, or when the target tree cannot be resolved.
   */
  const cascadeSubmodules = Effect.fn("MirrorService.cascadeSubmodules")(function* (input: {
    readonly projectId: ProjectId;
    readonly originLabel: string | null;
    readonly reason: MirrorSyncReason;
    readonly root: string;
    readonly baseSnapshotOid: string | null;
    readonly targetSnapshotOid: string;
  }) {
    const supported = yield* submoduleCascadeSupported(input.projectId);
    if (!supported) return;
    const runtime = yield* loadRuntime(input.projectId);
    const priorState: SubmoduleState =
      runtime?.submoduleStateJson != null
        ? Option.getOrElse(decodeSubmoduleState(runtime.submoduleStateJson), () => ({}))
        : {};
    const nextState: Record<string, { lastSyncedSnapshotOid: string }> = { ...priorState };
    const warnings: Array<{ path: string; detail: string }> = [];

    const baseTree =
      input.baseSnapshotOid === null
        ? null
        : yield* gitSync
            .treeOfCommit(input.root, input.baseSnapshotOid)
            .pipe(Effect.orElseSucceed(() => null));
    const targetTree = yield* gitSync
      .treeOfCommit(input.root, input.targetSnapshotOid)
      .pipe(Effect.orElseSucceed(() => null));
    if (targetTree === null) return;

    yield* walkGitlinks({
      ctx: { projectId: input.projectId, originLabel: input.originLabel, reason: input.reason },
      root: input.root,
      baseTreeOid: baseTree,
      targetTreeOid: targetTree,
      pathPrefix: "",
      depth: 0,
      priorState,
      nextState,
      warnings,
    });

    yield* saveRuntime({
      projectId: input.projectId,
      submoduleStateJson: encodeSubmoduleState(nextState),
      submoduleWarningsJson: warnings.length > 0 ? encodeSubmoduleWarnings(warnings) : null,
    });
  });

  const seedCore = Effect.fn("MirrorService.seed")(function* (projectId: ProjectId) {
    const project = yield* resolveMirroredProject(projectId);
    if (project === null) {
      return yield* new MirrorProjectNotMirroredError({ projectId });
    }
    const runtime = yield* loadRuntime(projectId);
    if (runtime?.lastSyncedSnapshotOid != null) return;
    yield* withActivity(
      projectId,
      "seeding",
      Effect.gen(function* () {
        const syncId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const upload = yield* transfer
          .issueUrl({ projectId, syncId, direction: "upload" })
          .pipe(Effect.mapError((cause) => syncFailed(projectId, syncId, cause.message)));
        const response = yield* request({
          projectId,
          originLabel: project.origin?.label ?? null,
          syncId,
          directive: {
            type: "seed-requested",
            syncId,
            uploadUrl: upload.relativeUrl,
            expiresAt: upload.expiresAt,
          },
          timeout: SEED_TIMEOUT,
        });
        if (response.type !== "seed-uploaded") {
          return yield* syncFailed(
            projectId,
            syncId,
            `Unexpected agent response '${response.type}' to a seed request.`,
          );
        }
        const root = project.workspaceRoot;
        const gitFailed = (cause: { readonly message: string }) =>
          syncFailed(projectId, syncId, cause.message);
        const isRepo = yield* gitSync.isRepository(root).pipe(Effect.mapError(gitFailed));
        if (!isRepo) {
          yield* gitSync.initRepository(root).pipe(Effect.mapError(gitFailed));
        }
        const bundlePath = yield* transfer.stagingPath(syncId);
        yield* gitSync
          .fetchBundle({
            root,
            bundlePath,
            refspecs: [
              "+refs/heads/*:refs/heads/*",
              "+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*",
            ],
          })
          .pipe(Effect.mapError(gitFailed));
        yield* gitSync
          .checkoutSeedHead(root, response.headRef, response.snapshotOid)
          .pipe(Effect.mapError(gitFailed));
        const headCommit = yield* gitSync.headCommit(root).pipe(Effect.mapError(gitFailed));
        if (headCommit !== null && headCommit !== response.snapshotOid) {
          const localIncludePaths = yield* includePathsFor(root);
          const includePaths = withExtraIncludePaths(localIncludePaths, project);
          yield* gitSync
            .applySnapshot({
              root,
              syncId,
              baseOid: headCommit,
              targetOid: response.snapshotOid,
              includePaths,
              conflictPreference: "target",
            })
            .pipe(Effect.mapError(gitFailed));
        }
        yield* gitSync.setRemotes(root, response.remotes).pipe(Effect.mapError(gitFailed));
        // The superproject checkout above already materialized every
        // gitlink path as an empty directory; mirror each one's real
        // content now, for origins that support it.
        yield* cascadeSubmodules({
          projectId,
          originLabel: project.origin?.label ?? null,
          reason: "seed",
          root,
          baseSnapshotOid: null,
          targetSnapshotOid: response.snapshotOid,
        }).pipe(Effect.ignore);
        const branches = yield* gitSync.listBranches(root).pipe(Effect.mapError(gitFailed));
        yield* saveRuntime({
          projectId,
          lastSyncedSnapshotOid: response.snapshotOid,
          lastSyncedAt: yield* nowIso,
          lastBranchesJson: encodeStringArray(branches.map((b) => `${b.ref}@${b.oid}`)),
          conflictPathsJson: null,
        });
        yield* gitSync
          .pruneSnapshotRefs({ root, keepOids: [response.snapshotOid] })
          .pipe(Effect.ignore);
        yield* transfer.removeStaged(syncId);
        yield* hooks.afterMirrorChanged({ projectId, workspaceRoot: root });
        yield* hooks.runSeedScripts({ projectId, workspaceRoot: root });
        yield* Effect.logInfo("Mirror seed completed.", {
          projectId,
          snapshot: response.snapshotOid,
        });
      }),
    );
  });

  const syncFailed = (projectId: ProjectId, syncId: string, detail: string) =>
    new MirrorSyncFailedError({ projectId, syncId, detail });

  const ensureFreshCore = Effect.fn("MirrorService.ensureFresh")(function* (
    projectId: ProjectId,
    options?: { readonly reason?: MirrorSyncReason },
  ) {
    const project = yield* resolveMirroredProject(projectId);
    if (project === null) return;
    const runtime = yield* loadRuntime(projectId);
    if (runtime?.lastSyncedSnapshotOid == null) {
      // First contact: the seed IS the freshness guarantee.
      return yield* seedCore(projectId);
    }
    const baseOid = runtime.lastSyncedSnapshotOid;
    yield* withActivity(
      projectId,
      "syncing",
      Effect.gen(function* () {
        const syncId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const upload = yield* transfer
          .issueUrl({ projectId, syncId, direction: "upload" })
          .pipe(Effect.mapError((cause) => syncFailed(projectId, syncId, cause.message)));
        const response = yield* request({
          projectId,
          originLabel: project.origin?.label ?? null,
          syncId,
          directive: {
            type: "sync-requested",
            syncId,
            baseSnapshotOid: baseOid,
            uploadUrl: upload.relativeUrl,
            expiresAt: upload.expiresAt,
            reason: options?.reason ?? "turn-start",
          },
          timeout: SYNC_TIMEOUT,
        });
        if (response.type === "sync-no-change") {
          yield* saveRuntime({ projectId, lastSyncedAt: yield* nowIso });
          // The superproject tree didn't move, but a gitlink already present
          // at `baseOid` may still have no recorded submodule state (e.g. it
          // predates submodule mirroring support). Re-check it so a plain
          // resync can pick up submodules that were never cascaded before.
          yield* cascadeSubmodules({
            projectId,
            originLabel: project.origin?.label ?? null,
            reason: options?.reason ?? "turn-start",
            root: project.workspaceRoot,
            baseSnapshotOid: baseOid,
            targetSnapshotOid: baseOid,
          }).pipe(Effect.ignore);
          return;
        }
        if (response.type !== "sync-uploaded") {
          return yield* syncFailed(
            projectId,
            syncId,
            `Unexpected agent response '${response.type}' to a sync request.`,
          );
        }
        const root = project.workspaceRoot;
        const gitFailed = (cause: { readonly message: string }) =>
          syncFailed(projectId, syncId, cause.message);
        const bundlePath = yield* transfer.stagingPath(syncId);
        yield* gitSync
          .fetchBundle({
            root,
            bundlePath,
            refspecs: [
              "+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*",
              "+refs/heads/*:refs/t3/mirror/incoming/*",
            ],
          })
          .pipe(Effect.mapError(gitFailed));
        const localIncludePaths = yield* includePathsFor(root);
        const includePaths = withExtraIncludePaths(localIncludePaths, project);
        const apply = yield* gitSync
          .applySnapshot({
            root,
            syncId,
            baseOid,
            targetOid: response.snapshotOid,
            includePaths,
            // The origin working copy is the source of truth on the way in;
            // same-path collisions with mirror-side edits go to the origin.
            conflictPreference: "target",
          })
          .pipe(Effect.mapError(gitFailed));
        if (apply.conflictPaths.length > 0) {
          yield* Effect.logWarning("Mirror push overrode host-side edits on conflicting paths.", {
            projectId,
            conflictPaths: apply.conflictPaths,
          });
        }
        yield* ingestBranchUpdates(root).pipe(Effect.mapError(gitFailed));
        // The superproject apply above already materialized any newly
        // added gitlink paths as empty directories; mirror each changed
        // one's real content now, for origins that support it.
        yield* cascadeSubmodules({
          projectId,
          originLabel: project.origin?.label ?? null,
          reason: options?.reason ?? "turn-start",
          root,
          baseSnapshotOid: baseOid,
          targetSnapshotOid: response.snapshotOid,
        }).pipe(Effect.ignore);
        yield* saveRuntime({
          projectId,
          lastSyncedSnapshotOid: response.snapshotOid,
          lastSyncedAt: yield* nowIso,
        });
        yield* gitSync
          .pruneSnapshotRefs({ root, keepOids: [response.snapshotOid] })
          .pipe(Effect.ignore);
        yield* transfer.removeStaged(syncId);
        yield* hooks.afterMirrorChanged({ projectId, workspaceRoot: root });
        // The mirror moved under any queued apply-back; recompute it so a
        // stale snapshot can never regress the origin working copy.
        const pending = runtime.pendingApplyJson;
        if (pending != null) {
          yield* saveRuntime({ projectId, pendingApplyJson: null });
          yield* stageAndDeliverApplyBack(projectId).pipe(Effect.ignore);
        }
      }),
    );
  });

  /**
   * Snapshots the mirror's current working tree and persists it as a
   * pending apply-back, returning whether there is anything to deliver.
   * Must run to completion under the project lock *before* turn completion
   * is signaled — only the network delivery in `processPendingApplyCore`
   * is safe to detach, since it's the persisted pending-apply row (not the
   * live mirror working tree) that a concurrent `ensureFresh` would race.
   */
  const stageApplyBackCore = Effect.fn("MirrorService.stageApplyBack")(function* (
    projectId: ProjectId,
  ): Effect.fn.Return<boolean> {
    const project = yield* resolveMirroredProject(projectId);
    if (project === null) return false;
    const runtime = yield* loadRuntime(projectId);
    if (runtime?.lastSyncedSnapshotOid == null) return false;
    const root = project.workspaceRoot;
    const syncId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const rootIncludePaths = yield* includePathsFor(root);
    const snapshot = yield* gitSync
      .createSnapshot({
        root,
        syncId,
        includePaths: withExtraIncludePaths(rootIncludePaths, project),
      })
      .pipe(Effect.orDie);
    const branches = yield* gitSync.listBranches(root).pipe(Effect.orElseSucceed(() => []));
    const branchesJson = encodeStringArray(branches.map((b) => `${b.ref}@${b.oid}`));
    const baseTree = yield* gitSync
      .treeOfCommit(root, runtime.lastSyncedSnapshotOid)
      .pipe(Effect.orElseSucceed(() => null));
    // Discover submodules that changed since the last recorded sync — this
    // catches both a moved gitlink pointer and uncommitted work left inside
    // an already-materialized nested repository, which the top-level tree
    // diff alone cannot see.
    const submodulesForApplyBack: Array<{
      path: string;
      syncId: string;
      targetOid: string;
      baseOid: string | null;
    }> = [];
    if (yield* submoduleCascadeSupported(projectId)) {
      const priorSubmoduleState: SubmoduleState =
        runtime.submoduleStateJson != null
          ? Option.getOrElse(decodeSubmoduleState(runtime.submoduleStateJson), () => ({}))
          : {};
      const gitlinks = yield* discoverAllGitlinks(gitSync, root, snapshot.treeOid).pipe(
        Effect.orElseSucceed(() => []),
      );
      for (const link of gitlinks) {
        const nestedRoot = path.join(root, link.path);
        const isRepo = yield* gitSync
          .isRepository(nestedRoot)
          .pipe(Effect.orElseSucceed(() => false));
        if (!isRepo) continue;
        const nestedSyncId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const nestedIncludePaths = yield* includePathsFor(nestedRoot);
        const nestedSnapshot = yield* gitSync
          .createSnapshot({
            root: nestedRoot,
            syncId: nestedSyncId,
            includePaths: withExtraIncludePaths(nestedIncludePaths, project),
          })
          .pipe(Effect.option);
        if (Option.isNone(nestedSnapshot)) continue;
        const priorOid = priorSubmoduleState[link.path]?.lastSyncedSnapshotOid ?? null;
        const priorTree =
          priorOid === null
            ? null
            : yield* gitSync
                .treeOfCommit(nestedRoot, priorOid)
                .pipe(Effect.orElseSucceed(() => null));
        if (priorTree === nestedSnapshot.value.treeOid) continue;
        submodulesForApplyBack.push({
          path: link.path,
          syncId: nestedSyncId,
          targetOid: nestedSnapshot.value.snapshotOid,
          baseOid: priorOid,
        });
      }
    }
    if (
      snapshot.treeOid === baseTree &&
      branchesJson === runtime.lastBranchesJson &&
      submodulesForApplyBack.length === 0
    ) {
      // Nothing the origin does not already have.
      yield* gitSync
        .pruneSnapshotRefs({ root, keepOids: [runtime.lastSyncedSnapshotOid] })
        .pipe(Effect.ignore);
      return false;
    }
    yield* saveRuntime({
      projectId,
      pendingApplyJson: encodePendingApply({
        syncId,
        targetOid: snapshot.snapshotOid,
        refUpdates: branches,
        submodules: submodulesForApplyBack,
      }),
    });
    return true;
  });

  /** Stage synchronously, then deliver in the same call — used by callers already inside a lock. */
  const stageAndDeliverApplyBack = (projectId: ProjectId) =>
    stageApplyBackCore(projectId).pipe(
      Effect.andThen((staged) => (staged ? processPendingApplyCore(projectId) : Effect.void)),
    );

  const processPendingApplyCore = Effect.fn("MirrorService.processPendingApply")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* resolveMirroredProject(projectId);
    if (project === null) return;
    const runtime = yield* loadRuntime(projectId);
    if (runtime?.pendingApplyJson == null || runtime.lastSyncedSnapshotOid == null) return;
    const pendingOption = decodePendingApply(runtime.pendingApplyJson);
    if (Option.isNone(pendingOption)) {
      yield* saveRuntime({ projectId, pendingApplyJson: null });
      return;
    }
    const pending: PendingApply = pendingOption.value;
    const connected = yield* originConnected(projectId);
    if (!connected) return; // replayed on the next agent connect
    const baseOid = runtime.lastSyncedSnapshotOid;
    const root = project.workspaceRoot;
    yield* withActivity(
      projectId,
      "applying",
      Effect.gen(function* () {
        const bundlePath = yield* transfer.stagingPath(pending.syncId);
        yield* gitSync
          .createIncrementalBundle({
            root,
            bundlePath,
            baseOid,
            snapshotRef: mirrorSnapshotRef(pending.syncId),
            includeBranches: true,
          })
          .pipe(Effect.orDie);
        const download = yield* transfer
          .issueUrl({ projectId, syncId: pending.syncId, direction: "download" })
          .pipe(Effect.orDie);
        const response = yield* request({
          projectId,
          originLabel: project.origin?.label ?? null,
          syncId: pending.syncId,
          directive: {
            type: "apply-requested",
            syncId: pending.syncId,
            downloadUrl: download.relativeUrl,
            expiresAt: download.expiresAt,
            baseSnapshotOid: baseOid,
            targetSnapshotOid: pending.targetOid,
            refUpdates: pending.refUpdates,
          },
          timeout: APPLY_TIMEOUT,
        });
        if (response.type !== "apply-result") {
          return yield* syncFailed(
            projectId,
            pending.syncId,
            `Unexpected agent response '${response.type}' to an apply request.`,
          );
        }
        // Applied or conflicted, the origin now has the target snapshot in
        // its .git; it is the new shared base either way. Conflicted paths
        // stayed local on the origin and will flow back on the next push.
        yield* saveRuntime({
          projectId,
          lastSyncedSnapshotOid: pending.targetOid,
          lastSyncedAt: yield* nowIso,
          lastBranchesJson: encodeStringArray(pending.refUpdates.map((b) => `${b.ref}@${b.oid}`)),
          pendingApplyJson: null,
          conflictPathsJson:
            response.outcome === "conflicted" ? encodeStringArray(response.conflictPaths) : null,
        });
        yield* gitSync
          .pruneSnapshotRefs({ root, keepOids: [pending.targetOid] })
          .pipe(Effect.ignore);
        yield* transfer.removeStaged(pending.syncId);
        if (response.outcome === "conflicted") {
          yield* Effect.logWarning("Mirror apply-back hit conflicts on the origin.", {
            projectId,
            conflictPaths: response.conflictPaths,
          });
        }

        // The top-level apply-back landed; now push each changed
        // submodule's own snapshot back the same way. Skipped/failed
        // entries fold into warnings rather than failing the apply-back.
        const submoduleWarnings: Array<{ path: string; detail: string }> = [];
        const submoduleUpdates: Record<string, { lastSyncedSnapshotOid: string }> = {};
        for (const sub of pending.submodules ?? []) {
          if (sub.baseOid === null) {
            submoduleWarnings.push({
              path: sub.path,
              detail: "Submodule has not been seeded onto the origin yet; skipped this round.",
            });
            continue;
          }
          yield* Effect.gen(function* () {
            const nestedRoot = path.join(root, sub.path);
            const subBundlePath = yield* transfer.stagingPath(sub.syncId);
            yield* gitSync.createIncrementalBundle({
              root: nestedRoot,
              bundlePath: subBundlePath,
              baseOid: sub.baseOid ?? "",
              snapshotRef: mirrorSnapshotRef(sub.syncId),
              includeBranches: true,
            });
            // Every exit past this point (skipped, unexpected response,
            // caught error) must still clear the staged bundle — only the
            // success path below removed it, so skipped submodules leaked
            // their bundle on every sync.
            yield* Effect.addFinalizer(() => transfer.removeStaged(sub.syncId));
            const subDownload = yield* transfer.issueUrl({
              projectId,
              syncId: sub.syncId,
              direction: "download",
            });
            const subResponse = yield* request({
              projectId,
              originLabel: project.origin?.label ?? null,
              syncId: sub.syncId,
              directive: {
                type: "submodule-apply-requested",
                syncId: sub.syncId,
                path: sub.path,
                downloadUrl: subDownload.relativeUrl,
                expiresAt: subDownload.expiresAt,
                baseSnapshotOid: sub.baseOid as string,
                targetSnapshotOid: sub.targetOid,
                refUpdates: [],
              },
              timeout: APPLY_TIMEOUT,
            });
            if (subResponse.type === "submodule-skipped") {
              submoduleWarnings.push({ path: sub.path, detail: subResponse.detail });
              return;
            }
            if (subResponse.type !== "submodule-apply-result") {
              submoduleWarnings.push({
                path: sub.path,
                detail: `Unexpected agent response '${subResponse.type}' to a submodule apply request.`,
              });
              return;
            }
            // Applied or conflicted, the origin now has the target snapshot;
            // it is the new shared base either way.
            submoduleUpdates[sub.path] = { lastSyncedSnapshotOid: sub.targetOid };
            yield* gitSync
              .pruneSnapshotRefs({ root: nestedRoot, keepOids: [sub.targetOid] })
              .pipe(Effect.ignore);
            if (subResponse.outcome === "conflicted") {
              yield* Effect.logWarning("Submodule apply-back hit conflicts on the origin.", {
                projectId,
                path: sub.path,
                conflictPaths: subResponse.conflictPaths,
              });
            }
          }).pipe(
            Effect.scoped,
            Effect.catch((cause) => {
              submoduleWarnings.push({ path: sub.path, detail: cause.message });
              return Effect.void;
            }),
          );
        }
        if (Object.keys(submoduleUpdates).length > 0 || submoduleWarnings.length > 0) {
          const priorSubmoduleState: SubmoduleState =
            runtime.submoduleStateJson != null
              ? Option.getOrElse(decodeSubmoduleState(runtime.submoduleStateJson), () => ({}))
              : {};
          yield* saveRuntime({
            projectId,
            submoduleStateJson: encodeSubmoduleState({
              ...priorSubmoduleState,
              ...submoduleUpdates,
            }),
            submoduleWarningsJson:
              submoduleWarnings.length > 0 ? encodeSubmoduleWarnings(submoduleWarnings) : null,
          });
        }
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Mirror apply-back attempt failed; it stays queued.", {
          projectId,
          cause: cause.message,
        }),
      ),
    );
  });

  const ensureFresh: MirrorService["Service"]["ensureFresh"] = (projectId, options) =>
    withProjectLock(projectId, ensureFreshCore(projectId, options));

  const originConnected: MirrorService["Service"]["originConnected"] = (projectId) =>
    SynchronizedRef.get(state).pipe(Effect.map((current) => current.connections.has(projectId)));

  // Fully synchronous: stage (snapshot + persist) and deliver, both under
  // the project lock. Used where the caller wants to know delivery actually
  // happened (e.g. a manual "sync now").
  const applyBack: MirrorService["Service"]["applyBack"] = (projectId) =>
    withProjectLock(projectId, stageAndDeliverApplyBack(projectId));

  // Fire-and-forget variant for turn completion: the snapshot-and-persist
  // half runs under the project lock and is awaited by the caller (turn
  // completion must not signal quiesced until this durably records the
  // turn's edits, or a fast-following turn's ensureFresh can pull the
  // origin's state over the mirror first and lose them); only the network
  // delivery half is detached, since that's the part safe to leave for the
  // next reconnect.
  const queueApplyBack: MirrorService["Service"]["queueApplyBack"] = (projectId) =>
    withProjectLock(projectId, stageApplyBackCore(projectId)).pipe(
      Effect.andThen((staged) =>
        staged
          ? withProjectLock(projectId, processPendingApplyCore(projectId)).pipe(Effect.forkDetach)
          : Effect.void,
      ),
    );

  const requestSync: MirrorService["Service"]["requestSync"] = Effect.fn(
    "MirrorService.requestSync",
  )(function* (projectId) {
    const project = yield* resolveMirroredProject(projectId);
    if (project === null) {
      return yield* new MirrorProjectNotMirroredError({ projectId });
    }
    yield* withProjectLock(
      projectId,
      ensureFreshCore(projectId, { reason: "manual" }).pipe(
        Effect.andThen(stageAndDeliverApplyBack(projectId).pipe(Effect.ignore)),
      ),
    );
  });

  const statusStream: MirrorService["Service"]["statusStream"] = Effect.fn(
    "MirrorService.statusStream",
  )(function* (projectId) {
    const initial: MirrorProjectStatus[] = [];
    if (projectId !== undefined) {
      const status = yield* currentStatus(projectId);
      if (status !== null) initial.push(status);
    } else {
      const all = yield* projects.listAll().pipe(Effect.orElseSucceed(() => []));
      for (const project of all) {
        if (project.origin == null || project.deletedAt !== null) continue;
        const status = yield* currentStatus(project.projectId);
        if (status !== null) initial.push(status);
      }
    }
    const updates = Stream.fromPubSub(statusPubSub).pipe(
      Stream.filter((status) => projectId === undefined || status.projectId === projectId),
    );
    return Stream.concat(Stream.fromIterable(initial), updates);
  });

  const isMirroredProject: MirrorService["Service"]["isMirroredProject"] = (projectId) =>
    resolveMirroredProject(projectId).pipe(Effect.map((project) => project !== null));

  const revokeLink: MirrorService["Service"]["revokeLink"] = Effect.fn("MirrorService.revokeLink")(
    function* (projectId) {
      const current = yield* SynchronizedRef.get(state);
      const connection = current.connections.get(projectId);
      if (connection !== undefined) {
        yield* Queue.offer(connection.queue, {
          type: "directive",
          connectionId: connection.connectionId,
          directive: { type: "link-revoked" },
        });
      }
      // Drop the host-side watermark so a recreated project reseeds cleanly.
      yield* sql`
        DELETE FROM mirror_sync_runtime
        WHERE project_id = ${projectId}
      `.pipe(Effect.ignore);
    },
  );

  const projectIdForConnection = (connectionId: MirrorConnectionId) =>
    SynchronizedRef.get(state).pipe(
      Effect.map((current) => {
        for (const [projectId, connection] of current.connections) {
          if (connection.connectionId === connectionId) return projectId as ProjectId;
        }
        return null;
      }),
    );

  return MirrorService.of({
    connect,
    respond,
    projectIdForConnection,
    ensureFresh,
    applyBack,
    queueApplyBack,
    requestSync,
    originConnected,
    statusStream,
    isMirroredProject,
    revokeLink,
  });
});

export const layer = Layer.effect(MirrorService, make);

/**
 * Inert MirrorService for tests that exercise reactors without mirroring:
 * no project is ever mirrored, gates pass through, apply-backs are no-ops.
 */
export const layerTest = Layer.succeed(
  MirrorService,
  MirrorService.of({
    connect: (input) =>
      Effect.fail(new MirrorProjectNotMirroredError({ projectId: input.projectId })),
    respond: () => Effect.void,
    projectIdForConnection: () => Effect.succeed(null),
    ensureFresh: () => Effect.void,
    applyBack: () => Effect.void,
    queueApplyBack: () => Effect.void,
    requestSync: (projectId) => Effect.fail(new MirrorProjectNotMirroredError({ projectId })),
    originConnected: () => Effect.succeed(false),
    statusStream: () => Effect.succeed(Stream.empty),
    isMirroredProject: () => Effect.succeed(false),
    revokeLink: () => Effect.void,
  }),
);
