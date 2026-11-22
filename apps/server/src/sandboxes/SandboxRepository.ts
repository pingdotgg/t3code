import { CloudSandboxRecord, SandboxId, type SandboxState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class SandboxRepositoryError extends Schema.TaggedError<SandboxRepositoryError>()(
  "SandboxRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sandbox persistence operation '${this.operation}' failed.`;
  }
}

export interface SandboxUpdatePatch {
  readonly state?: SandboxState | undefined;
  readonly providerSandboxId?: string | undefined;
  readonly snapshotId?: string | null | undefined;
  readonly baseSnapshotId?: string | null | undefined;
  readonly connectionUrl?: string | null | undefined;
  readonly environmentId?: CloudSandboxRecord["environmentId"] | undefined;
  readonly startedAt?: string | null | undefined;
  readonly lastActivityAt?: string | undefined;
  readonly pausedAt?: string | null | undefined;
  readonly vercelWarnedAt?: string | null | undefined;
  readonly lastError?: string | null | undefined;
  readonly updatedAt: string;
}

export class SandboxRepository extends Context.Service<
  SandboxRepository,
  {
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<CloudSandboxRecord>,
      SandboxRepositoryError
    >;
    readonly findById: (
      id: SandboxId,
    ) => Effect.Effect<Option.Option<CloudSandboxRecord>, SandboxRepositoryError>;
    readonly listByState: (
      state: SandboxState,
    ) => Effect.Effect<ReadonlyArray<CloudSandboxRecord>, SandboxRepositoryError>;
    readonly insert: (record: CloudSandboxRecord) => Effect.Effect<void, SandboxRepositoryError>;
    readonly update: (
      id: SandboxId,
      patch: SandboxUpdatePatch,
    ) => Effect.Effect<Option.Option<CloudSandboxRecord>, SandboxRepositoryError>;
    readonly deleteById: (id: SandboxId) => Effect.Effect<void, SandboxRepositoryError>;
  }
>()("t3/sandboxes/SandboxRepository") {}

function toRepoError(operation: string) {
  return (cause: unknown) => new SandboxRepositoryError({ operation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Idempotent DDL keeps cloud_sandboxes isolated from upstream sequential SQLite migrations.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cloud_sandboxes (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_sandbox_id TEXT NOT NULL,
      name TEXT NOT NULL,
      snapshot_id TEXT,
      base_snapshot_id TEXT,
      repo_url TEXT,
      branch TEXT,
      agent_harness TEXT,
      connection_url TEXT,
      environment_id TEXT,
      state TEXT NOT NULL,
      idle_timeout_minutes INTEGER NOT NULL DEFAULT 8,
      started_at TEXT,
      last_activity_at TEXT NOT NULL,
      paused_at TEXT,
      vercel_warned_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.pipe(Effect.mapError(toRepoError("initSchema")));

  yield* sql`
    CREATE INDEX IF NOT EXISTS cloud_sandboxes_state_activity_idx
    ON cloud_sandboxes(state, last_activity_at)
  `.pipe(Effect.mapError(toRepoError("initSchema")));

  yield* sql`
    CREATE INDEX IF NOT EXISTS cloud_sandboxes_provider_id_idx
    ON cloud_sandboxes(provider, provider_sandbox_id)
  `.pipe(Effect.mapError(toRepoError("initSchema")));

  const selectColumns = sql`
    SELECT
      id AS "id",
      provider AS "provider",
      provider_sandbox_id AS "providerSandboxId",
      name AS "name",
      snapshot_id AS "snapshotId",
      base_snapshot_id AS "baseSnapshotId",
      repo_url AS "repoUrl",
      branch AS "branch",
      agent_harness AS "agentHarness",
      connection_url AS "connectionUrl",
      environment_id AS "environmentId",
      state AS "state",
      idle_timeout_minutes AS "idleTimeoutMinutes",
      started_at AS "startedAt",
      last_activity_at AS "lastActivityAt",
      paused_at AS "pausedAt",
      vercel_warned_at AS "vercelWarnedAt",
      last_error AS "lastError",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM cloud_sandboxes
  `;

  const listAllQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CloudSandboxRecord,
    execute: () => sql`${selectColumns} ORDER BY created_at DESC`,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: SandboxId,
    Result: CloudSandboxRecord,
    execute: (id) => sql`${selectColumns} WHERE id = ${id}`,
  });

  const listByStateQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: CloudSandboxRecord,
    execute: (state) => sql`${selectColumns} WHERE state = ${state} ORDER BY created_at DESC`,
  });

  const findById = Effect.fn("SandboxRepository.findById")((id: SandboxId) =>
    findByIdQuery(id).pipe(Effect.mapError(toRepoError("findById"))),
  );

  return SandboxRepository.of({
    listAll: Effect.fn("SandboxRepository.listAll")(() =>
      listAllQuery(undefined).pipe(Effect.mapError(toRepoError("listAll"))),
    ),

    findById,

    listByState: Effect.fn("SandboxRepository.listByState")((state: SandboxState) =>
      listByStateQuery(state).pipe(Effect.mapError(toRepoError("listByState"))),
    ),

    insert: Effect.fn("SandboxRepository.insert")(function* (record) {
      yield* sql`
        INSERT INTO cloud_sandboxes (
          id, provider, provider_sandbox_id, name, snapshot_id, base_snapshot_id,
          repo_url, branch, agent_harness, connection_url, environment_id, state,
          idle_timeout_minutes, started_at, last_activity_at, paused_at,
          vercel_warned_at, last_error, created_at, updated_at
        ) VALUES (
          ${record.id}, ${record.provider}, ${record.providerSandboxId}, ${record.name},
          ${record.snapshotId}, ${record.baseSnapshotId}, ${record.repoUrl}, ${record.branch},
          ${record.agentHarness}, ${record.connectionUrl}, ${record.environmentId}, ${record.state},
          ${record.idleTimeoutMinutes}, ${record.startedAt}, ${record.lastActivityAt},
          ${record.pausedAt}, ${record.vercelWarnedAt}, ${record.lastError},
          ${record.createdAt}, ${record.updatedAt}
        )
      `.pipe(Effect.mapError(toRepoError("insert")));
    }),

    update: Effect.fn("SandboxRepository.update")(function* (id, patch) {
      const existing = yield* findById(id);
      if (Option.isNone(existing)) return Option.none();
      const current = existing.value;
      const next: CloudSandboxRecord = {
        ...current,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.providerSandboxId !== undefined
          ? { providerSandboxId: patch.providerSandboxId }
          : {}),
        ...(patch.snapshotId !== undefined ? { snapshotId: patch.snapshotId } : {}),
        ...(patch.baseSnapshotId !== undefined ? { baseSnapshotId: patch.baseSnapshotId } : {}),
        ...(patch.connectionUrl !== undefined ? { connectionUrl: patch.connectionUrl } : {}),
        ...(patch.environmentId !== undefined ? { environmentId: patch.environmentId } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.lastActivityAt !== undefined ? { lastActivityAt: patch.lastActivityAt } : {}),
        ...(patch.pausedAt !== undefined ? { pausedAt: patch.pausedAt } : {}),
        ...(patch.vercelWarnedAt !== undefined ? { vercelWarnedAt: patch.vercelWarnedAt } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        updatedAt: patch.updatedAt,
      };
      yield* sql`
        UPDATE cloud_sandboxes
        SET
          provider_sandbox_id = ${next.providerSandboxId},
          snapshot_id = ${next.snapshotId},
          base_snapshot_id = ${next.baseSnapshotId},
          connection_url = ${next.connectionUrl},
          environment_id = ${next.environmentId},
          state = ${next.state},
          started_at = ${next.startedAt},
          last_activity_at = ${next.lastActivityAt},
          paused_at = ${next.pausedAt},
          vercel_warned_at = ${next.vercelWarnedAt},
          last_error = ${next.lastError},
          updated_at = ${next.updatedAt}
        WHERE id = ${id}
      `.pipe(Effect.mapError(toRepoError("update")));
      return Option.some(next);
    }),

    deleteById: Effect.fn("SandboxRepository.deleteById")(function* (id) {
      yield* sql`DELETE FROM cloud_sandboxes WHERE id = ${id}`.pipe(
        Effect.mapError(toRepoError("deleteById")),
      );
    }),
  });
});

export const layer = Layer.effect(SandboxRepository, make);
