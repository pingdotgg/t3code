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
import { readMirrorIncludePaths } from "./mirrorInclude.ts";

const SEED_TIMEOUT = Duration.minutes(30);
const SYNC_TIMEOUT = Duration.minutes(10);
const APPLY_TIMEOUT = Duration.minutes(10);

const PendingApplySchema = Schema.Struct({
  syncId: Schema.String,
  targetOid: Schema.String,
  refUpdates: Schema.Array(Schema.Struct({ ref: Schema.String, oid: Schema.String })),
});
type PendingApply = typeof PendingApplySchema.Type;
const PendingApplyJson = Schema.fromJsonString(PendingApplySchema);
const decodePendingApply = Schema.decodeUnknownOption(PendingApplyJson);
const encodePendingApply = Schema.encodeSync(PendingApplyJson);

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeStringArray = Schema.decodeUnknownOption(StringArrayJson);
const encodeStringArray = Schema.encodeSync(StringArrayJson);

interface MirrorRuntimeRow {
  readonly projectId: string;
  readonly lastSyncedSnapshotOid: string | null;
  readonly lastSyncedAt: string | null;
  readonly lastBranchesJson: string | null;
  readonly pendingApplyJson: string | null;
  readonly conflictPathsJson: string | null;
}

interface AgentConnection {
  readonly projectId: ProjectId;
  readonly connectionId: string;
  readonly queue: Queue.Queue<MirrorStreamEvent>;
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
    /** Queue (and, when the agent is connected, deliver) a post-turn apply-back. */
    readonly applyBack: (projectId: ProjectId) => Effect.Effect<void>;
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
        conflict_paths_json AS "conflictPathsJson"
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
    };
    yield* sql`
      INSERT INTO mirror_sync_runtime (
        project_id,
        last_synced_snapshot_oid,
        last_synced_at,
        last_branches_json,
        pending_apply_json,
        conflict_paths_json
      )
      VALUES (
        ${input.projectId},
        ${next.lastSyncedSnapshotOid},
        ${next.lastSyncedAt},
        ${next.lastBranchesJson},
        ${next.pendingApplyJson},
        ${next.conflictPathsJson}
      )
      ON CONFLICT (project_id)
      DO UPDATE SET
        last_synced_snapshot_oid = excluded.last_synced_snapshot_oid,
        last_synced_at = excluded.last_synced_at,
        last_branches_json = excluded.last_branches_json,
        pending_apply_json = excluded.pending_apply_json,
        conflict_paths_json = excluded.conflict_paths_json
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
    return {
      projectId,
      state: stateValue,
      originConnected: connected,
      lastSyncedAt: runtime?.lastSyncedAt ?? null,
      lastSyncedSnapshotOid: runtime?.lastSyncedSnapshotOid ?? null,
      conflictPaths,
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
      }).pipe(Effect.andThen(publishStatus(projectId))),
      () => effect,
      () =>
        SynchronizedRef.update(state, (current) => {
          const next = new Map(current.activity);
          next.delete(projectId);
          return { ...current, activity: next };
        }).pipe(Effect.andThen(publishStatus(projectId))),
    );

  // --- broker --------------------------------------------------------------

  const failPending = (pending: ReadonlyArray<[string, PendingRequest]>, detail: string) =>
    Effect.forEach(
      pending,
      ([syncId, entry]) =>
        Deferred.fail(
          entry.deferred,
          new MirrorSyncFailedError({
            projectId: "" as ProjectId,
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
    yield* failPending(dropped, "The origin agent disconnected mid-sync.");
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

      const acquire = Effect.gen(function* () {
        const queue = yield* Queue.unbounded<MirrorStreamEvent>();
        const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* Queue.offer(queue, { type: "connected", connectionId, needsSeed });
        const connection: AgentConnection = {
          projectId: input.projectId,
          connectionId,
          queue,
        };
        const previous = yield* SynchronizedRef.modify(state, (current) => {
          const connections = new Map(current.connections);
          const previous = connections.get(input.projectId);
          connections.set(input.projectId, connection);
          return [previous, { ...current, connections }] as const;
        });
        if (previous !== undefined) {
          yield* disconnect(input.projectId, previous.queue).pipe(
            // The new registration already replaced it; only the queue and
            // its pending requests need tearing down.
            Effect.ignore,
          );
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
          const includePaths = yield* includePathsFor(root);
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
        const includePaths = yield* includePathsFor(root);
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
          yield* enqueueApplyBackCore(projectId).pipe(Effect.ignore);
        }
      }),
    );
  });

  const enqueueApplyBackCore = Effect.fn("MirrorService.enqueueApplyBack")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* resolveMirroredProject(projectId);
    if (project === null) return;
    const runtime = yield* loadRuntime(projectId);
    if (runtime?.lastSyncedSnapshotOid == null) return;
    const root = project.workspaceRoot;
    const syncId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const snapshot = yield* gitSync
      .createSnapshot({
        root,
        syncId,
        includePaths: yield* includePathsFor(root),
      })
      .pipe(Effect.orDie);
    const branches = yield* gitSync.listBranches(root).pipe(Effect.orElseSucceed(() => []));
    const branchesJson = encodeStringArray(branches.map((b) => `${b.ref}@${b.oid}`));
    const baseTree = yield* gitSync
      .treeOfCommit(root, runtime.lastSyncedSnapshotOid)
      .pipe(Effect.orElseSucceed(() => null));
    if (snapshot.treeOid === baseTree && branchesJson === runtime.lastBranchesJson) {
      // Nothing the origin does not already have.
      yield* gitSync
        .pruneSnapshotRefs({ root, keepOids: [runtime.lastSyncedSnapshotOid] })
        .pipe(Effect.ignore);
      return;
    }
    yield* saveRuntime({
      projectId,
      pendingApplyJson: encodePendingApply({
        syncId,
        targetOid: snapshot.snapshotOid,
        refUpdates: branches,
      }),
    });
    yield* processPendingApplyCore(projectId);
  });

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

  const applyBack: MirrorService["Service"]["applyBack"] = (projectId) =>
    withProjectLock(projectId, enqueueApplyBackCore(projectId));

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
        Effect.andThen(enqueueApplyBackCore(projectId).pipe(Effect.ignore)),
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

  return MirrorService.of({
    connect,
    respond,
    ensureFresh,
    applyBack,
    requestSync,
    originConnected,
    statusStream,
    isMirroredProject,
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
    ensureFresh: () => Effect.void,
    applyBack: () => Effect.void,
    requestSync: (projectId) => Effect.fail(new MirrorProjectNotMirroredError({ projectId })),
    originConnected: () => Effect.succeed(false),
    statusStream: () => Effect.succeed(Stream.empty),
    isMirroredProject: () => Effect.succeed(false),
  }),
);
