// @effect-diagnostics nodeBuiltinImport:off - node:sqlite needs synchronous, exact filesystem paths to enforce the physical tenant boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MarketingActorResolutionError,
  MarketingWorkspaceConflictError,
  MarketingWorkspaceCrossOrganizationError,
  MarketingWorkspaceStoreError,
  MarketingWorkspaceUnavailableError,
  isMarketingWorkspaceDomainError,
} from "./errors.ts";
import {
  MarketingT3ReferenceLifecycle,
  type ActiveT3Reference,
  type MarketingActorId,
  type MarketingIdempotencyKey,
  type MarketingOrganizationId,
  type MarketingReferenceTarget,
  type MarketingT3ReferenceBindingId,
  type MarketingWorkspaceResolutionInput,
  type MarketingWorkspaceSelection,
  type VerifiedT3ActorRef,
} from "./identity.ts";

const CONTROL_SCHEMA_VERSION = 1;
const ORGANIZATION_SCHEMA_VERSION = 1;
const CONTROL_DATABASE_FILENAME = "control.sqlite";
const ORGANIZATION_DATABASE_FILENAME = "workspace.sqlite";

type WorkspaceStoreDomainError =
  | MarketingActorResolutionError
  | MarketingWorkspaceConflictError
  | MarketingWorkspaceCrossOrganizationError
  | MarketingWorkspaceUnavailableError;

export type OrganizationWorkspaceStoreError =
  | WorkspaceStoreDomainError
  | MarketingWorkspaceStoreError;

export interface OrganizationWorkspaceStoreConfig {
  /** Dedicated Auldric root. It must not point at T3's state.sqlite file. */
  readonly stateRoot: string;
}

export interface ProvisionOrganizationWorkspaceInput {
  readonly actor: VerifiedT3ActorRef;
  readonly marketingActorId: MarketingActorId;
  readonly selection: MarketingWorkspaceSelection;
  readonly idempotencyKey: MarketingIdempotencyKey;
}

export type BackfillOrganizationWorkspaceInput = ProvisionOrganizationWorkspaceInput;

export interface OrganizationWorkspaceBinding {
  readonly marketingActorId: MarketingActorId;
  readonly selection: MarketingWorkspaceSelection;
  readonly databaseKey: string;
  readonly state: "active";
  readonly origin: "managed" | "backfilled";
}

export interface ResolvedOrganizationWorkspaceDatabase {
  readonly marketingActorId: MarketingActorId;
  readonly selection: MarketingWorkspaceSelection;
  readonly databaseKey: string;
  readonly databasePath: string;
  readonly database: NodeSqlite.DatabaseSync;
}

export interface OrganizationWorkspaceStore {
  readonly initialize: () => Effect.Effect<void, MarketingWorkspaceStoreError>;
  readonly provision: (
    input: ProvisionOrganizationWorkspaceInput,
  ) => Effect.Effect<OrganizationWorkspaceBinding, OrganizationWorkspaceStoreError>;
  readonly backfill: (
    input: BackfillOrganizationWorkspaceInput,
  ) => Effect.Effect<OrganizationWorkspaceBinding, OrganizationWorkspaceStoreError>;
  readonly resolve: <A, E, R>(
    input: MarketingWorkspaceResolutionInput,
    use: (workspace: ResolvedOrganizationWorkspaceDatabase) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OrganizationWorkspaceStoreError, R>;
  /** Control-plane lifecycle operation. Request authorization belongs to the shared T3 seam. */
  readonly revokeMembership: (input: {
    readonly organizationId: MarketingOrganizationId;
    readonly marketingActorId: MarketingActorId;
  }) => Effect.Effect<boolean, MarketingWorkspaceStoreError>;
  /** Recovery-only operation for provisioning that never reached active state. */
  readonly rollbackProvisioning: (
    selection: MarketingWorkspaceSelection,
  ) => Effect.Effect<boolean, OrganizationWorkspaceStoreError>;
  /** Control-plane lifecycle operation. Request authorization belongs to the shared T3 seam. */
  readonly deleteOrganizationWorkspace: (
    selection: MarketingWorkspaceSelection,
  ) => Effect.Effect<boolean, OrganizationWorkspaceStoreError>;
  readonly linkT3Reference: (input: {
    readonly actor: VerifiedT3ActorRef | null;
    readonly selection: MarketingWorkspaceSelection;
    readonly bindingId: MarketingT3ReferenceBindingId;
    readonly target: MarketingReferenceTarget;
    readonly reference: ActiveT3Reference;
    readonly expiresAt?: DateTime.Utc;
  }) => Effect.Effect<MarketingT3ReferenceLifecycle, OrganizationWorkspaceStoreError>;
  readonly markT3ReferenceStale: (input: {
    readonly actor: VerifiedT3ActorRef | null;
    readonly selection: MarketingWorkspaceSelection;
    readonly bindingId: MarketingT3ReferenceBindingId;
  }) => Effect.Effect<MarketingT3ReferenceLifecycle, OrganizationWorkspaceStoreError>;
  readonly deleteT3Reference: (input: {
    readonly actor: VerifiedT3ActorRef | null;
    readonly selection: MarketingWorkspaceSelection;
    readonly bindingId: MarketingT3ReferenceBindingId;
  }) => Effect.Effect<MarketingT3ReferenceLifecycle, OrganizationWorkspaceStoreError>;
}

interface ActorRow {
  readonly id: string;
  readonly status: "active" | "revoked";
}

interface MembershipRow {
  readonly status: "active" | "revoked";
}

interface WorkspaceRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly databaseKey: string;
  readonly state:
    | "provisioning"
    | "active"
    | "unavailable"
    | "deleting"
    | "deleted"
    | "rolled_back";
  readonly origin: "managed" | "backfilled";
}

interface OperationRow {
  readonly payloadHash: string;
  readonly state: "pending" | "completed" | "failed";
}

interface OrganizationIdentityRow {
  readonly organizationId: string;
  readonly databaseKey: string;
}

interface WorkspaceRegistryRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

interface SchemaVersionRow {
  readonly version: number;
}

interface T3ReferenceRow {
  readonly bindingId: string;
  readonly organizationId: string;
  readonly targetKind: MarketingReferenceTarget["kind"];
  readonly targetId: string;
  readonly referenceKind: ActiveT3Reference["kind"] | null;
  readonly referenceValue: string | null;
  readonly state: "active" | "stale" | "deleted";
  readonly linkedAt: string;
  readonly expiresAt: string | null;
  readonly staleAt: string | null;
  readonly deletedAt: string | null;
}

function mapStoreCause(operation: string, cause: unknown): OrganizationWorkspaceStoreError {
  if (isMarketingWorkspaceDomainError(cause)) {
    return cause;
  }
  return new MarketingWorkspaceStoreError({ operation, cause });
}

function configureDatabase(database: NodeSqlite.DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");
}

function runTransaction<A>(database: NodeSqlite.DatabaseSync, operation: () => A): A {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    database.exec("COMMIT;");
    return result;
  } catch (cause) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the original failure. A closed or failed database cannot be made authoritative.
    }
    throw cause;
  }
}

function closeDatabase(database: NodeSqlite.DatabaseSync): Effect.Effect<void> {
  return Effect.sync(() => database.close()).pipe(Effect.orDie);
}

function withDatabase<A, E, R>(
  databasePath: string,
  operation: string,
  use: (database: NodeSqlite.DatabaseSync) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MarketingWorkspaceStoreError, R> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(databasePath);
        configureDatabase(database);
        return database;
      },
      catch: (cause) => new MarketingWorkspaceStoreError({ operation, cause }),
    }),
    use,
    closeDatabase,
  );
}

function migrateControlDatabase(database: NodeSqlite.DatabaseSync): void {
  runTransaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS auldric_control_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS marketing_actors (
        id TEXT PRIMARY KEY,
        t3_actor_issuer TEXT NOT NULL,
        t3_actor_subject TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE (t3_actor_issuer, t3_actor_subject)
      );

      CREATE TABLE IF NOT EXISTS marketing_organizations (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('active', 'deleting', 'deleted')),
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS marketing_projects (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES marketing_organizations(id),
        state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE (organization_id, id)
      );

      CREATE TABLE IF NOT EXISTS marketing_organization_memberships (
        organization_id TEXT NOT NULL REFERENCES marketing_organizations(id),
        marketing_actor_id TEXT NOT NULL REFERENCES marketing_actors(id),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        bound_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (organization_id, marketing_actor_id)
      );

      CREATE TABLE IF NOT EXISTS marketing_workspaces (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL UNIQUE REFERENCES marketing_organizations(id),
        project_id TEXT NOT NULL REFERENCES marketing_projects(id),
        database_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (
          state IN ('provisioning', 'active', 'unavailable', 'deleting', 'deleted', 'rolled_back')
        ),
        origin TEXT NOT NULL CHECK (origin IN ('managed', 'backfilled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE (organization_id, id)
      );

      CREATE TABLE IF NOT EXISTS marketing_identity_operations (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
        organization_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS marketing_t3_reference_bindings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES marketing_organizations(id),
        target_kind TEXT NOT NULL CHECK (
          target_kind IN ('source', 'workflow', 'artifact', 'plan', 'review')
        ),
        target_id TEXT NOT NULL,
        reference_kind TEXT CHECK (
          reference_kind IS NULL OR reference_kind IN (
            'environment', 'thread', 'auth-session', 'runtime-session', 'device'
          )
        ),
        reference_value TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'stale', 'deleted')),
        linked_at TEXT NOT NULL,
        expires_at TEXT,
        stale_at TEXT,
        deleted_at TEXT,
        CHECK (
          (state = 'deleted' AND reference_kind IS NULL AND reference_value IS NULL)
          OR
          (state <> 'deleted' AND reference_kind IS NOT NULL AND reference_value IS NOT NULL)
        )
      );
    `);
    database
      .prepare(
        "INSERT OR IGNORE INTO auldric_control_schema_migrations(version, applied_at) VALUES (?, ?)",
      )
      .run(CONTROL_SCHEMA_VERSION, "schema-v1");
  });
}

function readT3ReferenceRow(
  database: NodeSqlite.DatabaseSync,
  organizationId: MarketingOrganizationId,
  bindingId: MarketingT3ReferenceBindingId,
): T3ReferenceRow | undefined {
  return database
    .prepare(
      `SELECT id AS bindingId, organization_id AS organizationId,
              target_kind AS targetKind, target_id AS targetId,
              reference_kind AS referenceKind, reference_value AS referenceValue,
              state, linked_at AS linkedAt, expires_at AS expiresAt,
              stale_at AS staleAt, deleted_at AS deletedAt
       FROM marketing_t3_reference_bindings
       WHERE id = ? AND organization_id = ?`,
    )
    .get(bindingId, organizationId) as unknown as T3ReferenceRow | undefined;
}

function referenceTargetFromRow(row: T3ReferenceRow): MarketingReferenceTarget {
  return { kind: row.targetKind, id: row.targetId } as MarketingReferenceTarget;
}

function activeReferenceFromRow(row: T3ReferenceRow): ActiveT3Reference {
  if (row.referenceKind === null || row.referenceValue === null) {
    throw new MarketingWorkspaceConflictError({ reason: "t3_reference_value_missing" });
  }
  return { kind: row.referenceKind, value: row.referenceValue } as ActiveT3Reference;
}

const decodeT3ReferenceLifecycle = Schema.decodeUnknownSync(MarketingT3ReferenceLifecycle);

function t3ReferenceLifecycleFromRow(row: T3ReferenceRow): MarketingT3ReferenceLifecycle {
  const common = {
    bindingId: row.bindingId,
    organizationId: row.organizationId,
    target: referenceTargetFromRow(row),
    linkedAt: DateTime.makeUnsafe(row.linkedAt),
  };
  if (row.state === "deleted") {
    if (row.deletedAt === null) {
      throw new MarketingWorkspaceConflictError({ reason: "t3_reference_deletion_stale" });
    }
    return decodeT3ReferenceLifecycle({
      ...common,
      state: "deleted",
      reference: null,
      deletedAt: DateTime.makeUnsafe(row.deletedAt),
    });
  }
  if (row.state === "stale") {
    if (row.staleAt === null) {
      throw new MarketingWorkspaceConflictError({ reason: "t3_reference_stale_at_missing" });
    }
    return decodeT3ReferenceLifecycle({
      ...common,
      state: "stale",
      reference: activeReferenceFromRow(row),
      staleAt: DateTime.makeUnsafe(row.staleAt),
    });
  }
  return decodeT3ReferenceLifecycle({
    ...common,
    state: "active",
    reference: activeReferenceFromRow(row),
    ...(row.expiresAt === null ? {} : { expiresAt: DateTime.makeUnsafe(row.expiresAt) }),
  });
}

function migrateManagedOrganizationDatabase(
  database: NodeSqlite.DatabaseSync,
  input: { readonly selection: MarketingWorkspaceSelection; readonly databaseKey: string },
): void {
  runTransaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS auldric_organization_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auldric_organization_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        organization_id TEXT NOT NULL,
        database_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auldric_marketing_workspace_registry (
        workspace_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const identity = database
      .prepare(
        `SELECT organization_id AS organizationId, database_key AS databaseKey
         FROM auldric_organization_identity WHERE singleton = 1`,
      )
      .get() as unknown as OrganizationIdentityRow | undefined;
    if (
      identity !== undefined &&
      (identity.organizationId !== input.selection.organizationId ||
        identity.databaseKey !== input.databaseKey)
    ) {
      throw new MarketingWorkspaceCrossOrganizationError({});
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO auldric_organization_identity(
           singleton, organization_id, database_key, created_at
         ) VALUES (1, ?, ?, ?)`,
      )
      .run(input.selection.organizationId, input.databaseKey, "schema-v1");

    const workspace = database
      .prepare(
        `SELECT workspace_id AS workspaceId, organization_id AS organizationId,
                project_id AS projectId
         FROM auldric_marketing_workspace_registry WHERE workspace_id = ?`,
      )
      .get(input.selection.workspaceId) as unknown as WorkspaceRegistryRow | undefined;
    if (
      workspace !== undefined &&
      (workspace.organizationId !== input.selection.organizationId ||
        workspace.projectId !== input.selection.projectId)
    ) {
      throw new MarketingWorkspaceConflictError({ reason: "workspace_registry_conflict" });
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO auldric_marketing_workspace_registry(
           workspace_id, organization_id, project_id, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.selection.workspaceId,
        input.selection.organizationId,
        input.selection.projectId,
        "schema-v1",
      );
    database
      .prepare(
        "INSERT OR IGNORE INTO auldric_organization_schema_migrations(version, applied_at) VALUES (?, ?)",
      )
      .run(ORGANIZATION_SCHEMA_VERSION, "schema-v1");
  });
}

function verifyOrganizationDatabase(
  database: NodeSqlite.DatabaseSync,
  input: { readonly selection: MarketingWorkspaceSelection; readonly databaseKey: string },
): void {
  let identity: OrganizationIdentityRow | undefined;
  let workspace: WorkspaceRegistryRow | undefined;
  try {
    identity = database
      .prepare(
        `SELECT organization_id AS organizationId, database_key AS databaseKey
         FROM auldric_organization_identity WHERE singleton = 1`,
      )
      .get() as unknown as OrganizationIdentityRow | undefined;
    workspace = database
      .prepare(
        `SELECT workspace_id AS workspaceId, organization_id AS organizationId,
                project_id AS projectId
         FROM auldric_marketing_workspace_registry WHERE workspace_id = ?`,
      )
      .get(input.selection.workspaceId) as unknown as WorkspaceRegistryRow | undefined;
  } catch {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_identity_missing",
    });
  }

  if (identity === undefined) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_identity_missing",
    });
  }
  if (
    identity.organizationId !== input.selection.organizationId ||
    identity.databaseKey !== input.databaseKey
  ) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_identity_mismatch",
    });
  }
  if (
    workspace === undefined ||
    workspace.organizationId !== input.selection.organizationId ||
    workspace.projectId !== input.selection.projectId
  ) {
    throw new MarketingWorkspaceUnavailableError({ reason: "workspace_registry_stale" });
  }
  let migration: SchemaVersionRow | undefined;
  try {
    migration = database
      .prepare(
        `SELECT MAX(version) AS version
         FROM auldric_organization_schema_migrations`,
      )
      .get() as unknown as SchemaVersionRow | undefined;
  } catch {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_schema_stale",
    });
  }
  if (migration?.version !== ORGANIZATION_SCHEMA_VERSION) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_schema_stale",
    });
  }
}

function organizationDatabaseKey(organizationId: MarketingOrganizationId): string {
  return NodeCrypto.createHash("sha256").update(organizationId).digest("hex");
}

export function organizationWorkspaceDatabasePath(
  stateRoot: string,
  organizationId: MarketingOrganizationId,
): string {
  const root = NodePath.resolve(stateRoot);
  const databaseKey = organizationDatabaseKey(organizationId);
  const databasePath = NodePath.resolve(
    root,
    "organizations",
    databaseKey,
    ORGANIZATION_DATABASE_FILENAME,
  );
  if (!databasePath.startsWith(`${root}${NodePath.sep}`)) {
    throw new MarketingWorkspaceConflictError({ reason: "unsafe_database_path" });
  }
  return databasePath;
}

function operationPayloadHash(input: ProvisionOrganizationWorkspaceInput): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        input.actor.issuer,
        input.actor.subject,
        input.marketingActorId,
        input.selection.organizationId,
        input.selection.projectId,
        input.selection.workspaceId,
      ]),
    )
    .digest("hex");
}

function assertFreshVerifiedActor(
  actor: VerifiedT3ActorRef | null,
  now: DateTime.Utc,
): Effect.Effect<VerifiedT3ActorRef, MarketingActorResolutionError> {
  if (actor === null) {
    return Effect.fail(new MarketingActorResolutionError({ reason: "missing_verified_actor" }));
  }
  if (actor.verifiedAt.epochMilliseconds > now.epochMilliseconds) {
    return Effect.fail(new MarketingActorResolutionError({ reason: "verification_not_yet_valid" }));
  }
  if (actor.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
    return Effect.fail(new MarketingActorResolutionError({ reason: "verification_expired" }));
  }
  return Effect.succeed(actor);
}

function removeDatabaseFiles(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (NodeFS.existsSync(path)) {
      NodeFS.unlinkSync(path);
    }
  }
}

export function makeOrganizationWorkspaceStore(
  config: OrganizationWorkspaceStoreConfig,
): OrganizationWorkspaceStore {
  const stateRoot = NodePath.resolve(config.stateRoot);
  const controlDatabasePath = NodePath.join(stateRoot, CONTROL_DATABASE_FILENAME);

  const initialize = Effect.fn("OrganizationWorkspaceStore.initialize")(function* () {
    yield* Effect.try({
      try: () => NodeFS.mkdirSync(stateRoot, { recursive: true }),
      catch: (cause) => new MarketingWorkspaceStoreError({ operation: "initialize", cause }),
    });
    yield* withDatabase(controlDatabasePath, "initialize", (database) =>
      Effect.try({
        try: () => migrateControlDatabase(database),
        catch: (cause) => new MarketingWorkspaceStoreError({ operation: "initialize", cause }),
      }),
    );
  });

  const prepareControlProvision = Effect.fn("OrganizationWorkspaceStore.prepareControlProvision")(
    function* (
      input: ProvisionOrganizationWorkspaceInput,
      origin: WorkspaceRow["origin"],
      nowIso: string,
    ) {
      const databaseKey = organizationDatabaseKey(input.selection.organizationId);
      const payloadHash = operationPayloadHash(input);
      return yield* withDatabase(controlDatabasePath, "prepare_provision", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              const operation = database
                .prepare(
                  `SELECT payload_hash AS payloadHash, state
                   FROM marketing_identity_operations WHERE idempotency_key = ?`,
                )
                .get(input.idempotencyKey) as unknown as OperationRow | undefined;
              if (operation !== undefined && operation.payloadHash !== payloadHash) {
                throw new MarketingWorkspaceConflictError({ reason: "idempotency_key_reused" });
              }
              if (operation?.state === "completed") {
                const completedWorkspace = database
                  .prepare(
                    `SELECT organization_id AS organizationId, project_id AS projectId,
                            id AS workspaceId, database_key AS databaseKey, state, origin
                     FROM marketing_workspaces WHERE id = ?`,
                  )
                  .get(input.selection.workspaceId) as unknown as WorkspaceRow | undefined;
                if (
                  completedWorkspace === undefined ||
                  completedWorkspace.organizationId !== input.selection.organizationId ||
                  completedWorkspace.projectId !== input.selection.projectId ||
                  completedWorkspace.workspaceId !== input.selection.workspaceId ||
                  completedWorkspace.databaseKey !== databaseKey ||
                  completedWorkspace.origin !== origin ||
                  completedWorkspace.state !== "active"
                ) {
                  throw new MarketingWorkspaceConflictError({
                    reason: "completed_operation_binding_stale",
                  });
                }
                return { databaseKey, alreadyCompleted: true };
              }

              const actorByUpstream = database
                .prepare(
                  `SELECT id, status FROM marketing_actors
                   WHERE t3_actor_issuer = ? AND t3_actor_subject = ?`,
                )
                .get(input.actor.issuer, input.actor.subject) as unknown as ActorRow | undefined;
              if (actorByUpstream !== undefined && actorByUpstream.id !== input.marketingActorId) {
                throw new MarketingWorkspaceConflictError({ reason: "actor_already_mapped" });
              }
              const actorById = database
                .prepare("SELECT id, status FROM marketing_actors WHERE id = ?")
                .get(input.marketingActorId) as unknown as ActorRow | undefined;
              if (actorById !== undefined && actorByUpstream === undefined) {
                throw new MarketingWorkspaceConflictError({ reason: "actor_id_already_bound" });
              }
              if (actorByUpstream?.status === "revoked") {
                throw new MarketingActorResolutionError({ reason: "actor_binding_revoked" });
              }
              database
                .prepare(
                  `INSERT OR IGNORE INTO marketing_actors(
                     id, t3_actor_issuer, t3_actor_subject, status, created_at
                   ) VALUES (?, ?, ?, 'active', ?)`,
                )
                .run(input.marketingActorId, input.actor.issuer, input.actor.subject, nowIso);

              const organization = database
                .prepare("SELECT state FROM marketing_organizations WHERE id = ?")
                .get(input.selection.organizationId) as unknown as
                | { readonly state: "active" | "deleting" | "deleted" }
                | undefined;
              if (organization !== undefined && organization.state !== "active") {
                throw new MarketingWorkspaceConflictError({ reason: "organization_not_active" });
              }
              database
                .prepare(
                  `INSERT OR IGNORE INTO marketing_organizations(id, state, created_at)
                   VALUES (?, 'active', ?)`,
                )
                .run(input.selection.organizationId, nowIso);

              const project = database
                .prepare(
                  "SELECT organization_id AS organizationId, state FROM marketing_projects WHERE id = ?",
                )
                .get(input.selection.projectId) as unknown as
                | { readonly organizationId: string; readonly state: "active" | "deleted" }
                | undefined;
              if (
                project !== undefined &&
                (project.organizationId !== input.selection.organizationId ||
                  project.state !== "active")
              ) {
                throw new MarketingWorkspaceCrossOrganizationError({});
              }
              database
                .prepare(
                  `INSERT OR IGNORE INTO marketing_projects(
                     id, organization_id, state, created_at
                   ) VALUES (?, ?, 'active', ?)`,
                )
                .run(input.selection.projectId, input.selection.organizationId, nowIso);

              const membership = database
                .prepare(
                  `SELECT status FROM marketing_organization_memberships
                   WHERE organization_id = ? AND marketing_actor_id = ?`,
                )
                .get(input.selection.organizationId, input.marketingActorId) as unknown as
                | MembershipRow
                | undefined;
              if (membership?.status === "revoked") {
                throw new MarketingActorResolutionError({ reason: "membership_revoked" });
              }
              database
                .prepare(
                  `INSERT OR IGNORE INTO marketing_organization_memberships(
                     organization_id, marketing_actor_id, status, bound_at
                   ) VALUES (?, ?, 'active', ?)`,
                )
                .run(input.selection.organizationId, input.marketingActorId, nowIso);

              const workspace = database
                .prepare(
                  `SELECT organization_id AS organizationId, project_id AS projectId,
                          id AS workspaceId, database_key AS databaseKey, state, origin
                   FROM marketing_workspaces
                   WHERE id = ? OR organization_id = ?`,
                )
                .get(input.selection.workspaceId, input.selection.organizationId) as unknown as
                | WorkspaceRow
                | undefined;
              if (
                workspace !== undefined &&
                (workspace.organizationId !== input.selection.organizationId ||
                  workspace.projectId !== input.selection.projectId ||
                  workspace.workspaceId !== input.selection.workspaceId ||
                  workspace.databaseKey !== databaseKey ||
                  workspace.origin !== origin ||
                  workspace.state === "deleted" ||
                  workspace.state === "rolled_back")
              ) {
                throw new MarketingWorkspaceConflictError({ reason: "workspace_binding_conflict" });
              }
              database
                .prepare(
                  `INSERT OR IGNORE INTO marketing_workspaces(
                     id, organization_id, project_id, database_key, state, origin,
                     created_at, updated_at
                   ) VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?)`,
                )
                .run(
                  input.selection.workspaceId,
                  input.selection.organizationId,
                  input.selection.projectId,
                  databaseKey,
                  origin,
                  nowIso,
                  nowIso,
                );
              if (workspace?.state === "unavailable" || operation?.state === "failed") {
                database
                  .prepare(
                    `UPDATE marketing_workspaces SET state = 'provisioning', updated_at = ?
                     WHERE id = ?`,
                  )
                  .run(nowIso, input.selection.workspaceId);
              }

              database
                .prepare(
                  `INSERT INTO marketing_identity_operations(
                     idempotency_key, payload_hash, state, organization_id, workspace_id,
                     created_at, updated_at
                   ) VALUES (?, ?, 'pending', ?, ?, ?, ?)
                   ON CONFLICT(idempotency_key) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at`,
                )
                .run(
                  input.idempotencyKey,
                  payloadHash,
                  input.selection.organizationId,
                  input.selection.workspaceId,
                  nowIso,
                  nowIso,
                );

              return { databaseKey, alreadyCompleted: false };
            }),
          catch: (cause) => mapStoreCause("prepare_provision", cause),
        }),
      );
    },
  );

  const finishControlProvision = Effect.fn("OrganizationWorkspaceStore.finishControlProvision")(
    function* (input: ProvisionOrganizationWorkspaceInput, nowIso: string) {
      yield* withDatabase(controlDatabasePath, "finish_provision", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              database
                .prepare(
                  `UPDATE marketing_workspaces SET state = 'active', updated_at = ?
                   WHERE id = ? AND organization_id = ?`,
                )
                .run(nowIso, input.selection.workspaceId, input.selection.organizationId);
              database
                .prepare(
                  `UPDATE marketing_identity_operations SET state = 'completed', updated_at = ?
                   WHERE idempotency_key = ?`,
                )
                .run(nowIso, input.idempotencyKey);
            }),
          catch: (cause) =>
            new MarketingWorkspaceStoreError({ operation: "finish_provision", cause }),
        }),
      );
    },
  );

  const failControlProvision = Effect.fn("OrganizationWorkspaceStore.failControlProvision")(
    function* (input: ProvisionOrganizationWorkspaceInput, nowIso: string) {
      yield* withDatabase(controlDatabasePath, "fail_provision", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              database
                .prepare(
                  `UPDATE marketing_workspaces SET state = 'unavailable', updated_at = ?
                   WHERE id = ? AND state <> 'active'`,
                )
                .run(nowIso, input.selection.workspaceId);
              database
                .prepare(
                  `UPDATE marketing_identity_operations SET state = 'failed', updated_at = ?
                   WHERE idempotency_key = ?`,
                )
                .run(nowIso, input.idempotencyKey);
            }),
          catch: (cause) =>
            new MarketingWorkspaceStoreError({ operation: "fail_provision", cause }),
        }),
      );
    },
  );

  const provisionWithOrigin = Effect.fn("OrganizationWorkspaceStore.provisionWithOrigin")(
    function* (
      input: ProvisionOrganizationWorkspaceInput,
      origin: WorkspaceRow["origin"],
    ): Effect.fn.Return<OrganizationWorkspaceBinding, OrganizationWorkspaceStoreError> {
      yield* initialize();
      const now = yield* DateTime.now;
      yield* assertFreshVerifiedActor(input.actor, now);
      const nowIso = DateTime.formatIso(now);
      const prepared = yield* prepareControlProvision(input, origin, nowIso);
      const databasePath = organizationWorkspaceDatabasePath(
        stateRoot,
        input.selection.organizationId,
      );

      if (prepared.alreadyCompleted) {
        const exists = yield* Effect.sync(() => NodeFS.existsSync(databasePath));
        if (!exists) {
          return yield* new MarketingWorkspaceUnavailableError({
            reason: "workspace_database_missing",
          });
        }
        yield* withDatabase(databasePath, "verify_completed_provision", (database) =>
          Effect.try({
            try: () =>
              verifyOrganizationDatabase(database, {
                selection: input.selection,
                databaseKey: prepared.databaseKey,
              }),
            catch: (cause) => mapStoreCause("verify_completed_provision", cause),
          }),
        );
        return {
          marketingActorId: input.marketingActorId,
          selection: input.selection,
          databaseKey: prepared.databaseKey,
          state: "active",
          origin,
        };
      }

      const existedBefore = NodeFS.existsSync(databasePath);
      const provisionDatabase =
        origin === "managed"
          ? Effect.try({
              try: () => NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true }),
              catch: (cause) =>
                new MarketingWorkspaceStoreError({
                  operation: "create_workspace_directory",
                  cause,
                }),
            }).pipe(
              Effect.andThen(
                withDatabase(databasePath, "migrate_workspace_database", (database) =>
                  Effect.try({
                    try: () =>
                      migrateManagedOrganizationDatabase(database, {
                        selection: input.selection,
                        databaseKey: prepared.databaseKey,
                      }),
                    catch: (cause) => mapStoreCause("migrate_workspace_database", cause),
                  }),
                ),
              ),
            )
          : existedBefore
            ? withDatabase(databasePath, "verify_backfill_database", (database) =>
                Effect.try({
                  try: () =>
                    verifyOrganizationDatabase(database, {
                      selection: input.selection,
                      databaseKey: prepared.databaseKey,
                    }),
                  catch: (cause) => mapStoreCause("verify_backfill_database", cause),
                }),
              )
            : Effect.fail(
                new MarketingWorkspaceUnavailableError({
                  reason: "workspace_database_missing",
                }),
              );

      const result = yield* Effect.result(provisionDatabase);
      if (result._tag === "Failure") {
        if (origin === "managed" && !existedBefore) {
          yield* Effect.try({
            try: () => removeDatabaseFiles(databasePath),
            catch: (cause) =>
              new MarketingWorkspaceStoreError({ operation: "rollback_workspace_files", cause }),
          }).pipe(Effect.ignore);
        }
        yield* failControlProvision(input, nowIso);
        return yield* result.failure;
      }

      yield* finishControlProvision(input, nowIso);
      return {
        marketingActorId: input.marketingActorId,
        selection: input.selection,
        databaseKey: prepared.databaseKey,
        state: "active",
        origin,
      };
    },
  );

  const provision: OrganizationWorkspaceStore["provision"] = (input) =>
    provisionWithOrigin(input, "managed");

  const backfill: OrganizationWorkspaceStore["backfill"] = (input) =>
    provisionWithOrigin(input, "backfilled");

  const resolve: OrganizationWorkspaceStore["resolve"] = (input, use) =>
    Effect.gen(function* () {
      yield* initialize();
      const now = yield* DateTime.now;
      const actor = yield* assertFreshVerifiedActor(input.actor, now);
      const resolved = yield* withDatabase(controlDatabasePath, "resolve_workspace", (database) =>
        Effect.try({
          try: () => {
            const actorRow = database
              .prepare(
                `SELECT id, status FROM marketing_actors
                 WHERE t3_actor_issuer = ? AND t3_actor_subject = ?`,
              )
              .get(actor.issuer, actor.subject) as unknown as ActorRow | undefined;
            if (actorRow === undefined) {
              throw new MarketingActorResolutionError({ reason: "actor_binding_missing" });
            }
            if (actorRow.status !== "active") {
              throw new MarketingActorResolutionError({ reason: "actor_binding_revoked" });
            }

            const membership = database
              .prepare(
                `SELECT status FROM marketing_organization_memberships
                 WHERE organization_id = ? AND marketing_actor_id = ?`,
              )
              .get(input.selection.organizationId, actorRow.id) as unknown as
              | MembershipRow
              | undefined;
            if (membership === undefined) {
              throw new MarketingActorResolutionError({ reason: "membership_missing" });
            }
            if (membership.status !== "active") {
              throw new MarketingActorResolutionError({ reason: "membership_revoked" });
            }

            const organization = database
              .prepare("SELECT state FROM marketing_organizations WHERE id = ?")
              .get(input.selection.organizationId) as unknown as
              | { readonly state: "active" | "deleting" | "deleted" }
              | undefined;
            if (organization?.state !== "active") {
              throw new MarketingWorkspaceUnavailableError({
                reason: "organization_unavailable",
              });
            }

            const project = database
              .prepare(
                "SELECT organization_id AS organizationId, state FROM marketing_projects WHERE id = ?",
              )
              .get(input.selection.projectId) as unknown as
              | { readonly organizationId: string; readonly state: "active" | "deleted" }
              | undefined;
            if (project === undefined || project.state !== "active") {
              throw new MarketingWorkspaceUnavailableError({ reason: "project_unavailable" });
            }
            if (project.organizationId !== input.selection.organizationId) {
              throw new MarketingWorkspaceCrossOrganizationError({});
            }

            const workspace = database
              .prepare(
                `SELECT organization_id AS organizationId, project_id AS projectId,
                        id AS workspaceId, database_key AS databaseKey, state, origin
                 FROM marketing_workspaces WHERE id = ?`,
              )
              .get(input.selection.workspaceId) as unknown as WorkspaceRow | undefined;
            if (workspace === undefined || workspace.state !== "active") {
              throw new MarketingWorkspaceUnavailableError({ reason: "workspace_unavailable" });
            }
            if (
              workspace.organizationId !== input.selection.organizationId ||
              workspace.projectId !== input.selection.projectId
            ) {
              throw new MarketingWorkspaceCrossOrganizationError({});
            }
            const expectedKey = organizationDatabaseKey(input.selection.organizationId);
            if (workspace.databaseKey !== expectedKey) {
              throw new MarketingWorkspaceUnavailableError({
                reason: "workspace_database_identity_mismatch",
              });
            }
            return {
              marketingActorId: actorRow.id as MarketingActorId,
              databaseKey: workspace.databaseKey,
            };
          },
          catch: (cause) => mapStoreCause("resolve_workspace", cause),
        }),
      );

      const databasePath = organizationWorkspaceDatabasePath(
        stateRoot,
        input.selection.organizationId,
      );
      const exists = yield* Effect.sync(() => NodeFS.existsSync(databasePath));
      if (!exists) {
        return yield* new MarketingWorkspaceUnavailableError({
          reason: "workspace_database_missing",
        });
      }

      return yield* withDatabase(databasePath, "open_workspace_database", (database) =>
        Effect.try({
          try: () =>
            verifyOrganizationDatabase(database, {
              selection: input.selection,
              databaseKey: resolved.databaseKey,
            }),
          catch: (cause) => mapStoreCause("verify_workspace_database", cause),
        }).pipe(
          Effect.andThen(
            use({
              marketingActorId: resolved.marketingActorId,
              selection: input.selection,
              databaseKey: resolved.databaseKey,
              databasePath,
              database,
            }),
          ),
        ),
      );
    });

  const revokeMembership: OrganizationWorkspaceStore["revokeMembership"] = (input) =>
    initialize().pipe(
      Effect.andThen(
        DateTime.now.pipe(
          Effect.map(DateTime.formatIso),
          Effect.flatMap((nowIso) =>
            withDatabase(controlDatabasePath, "revoke_membership", (database) =>
              Effect.try({
                try: () => {
                  const result = database
                    .prepare(
                      `UPDATE marketing_organization_memberships
                       SET status = 'revoked', revoked_at = ?
                       WHERE organization_id = ? AND marketing_actor_id = ? AND status = 'active'`,
                    )
                    .run(nowIso, input.organizationId, input.marketingActorId);
                  return result.changes > 0;
                },
                catch: (cause) =>
                  new MarketingWorkspaceStoreError({ operation: "revoke_membership", cause }),
              }),
            ),
          ),
        ),
      ),
    );

  const rollbackProvisioning: OrganizationWorkspaceStore["rollbackProvisioning"] = (selection) =>
    Effect.gen(function* () {
      yield* initialize();
      const databasePath = organizationWorkspaceDatabasePath(stateRoot, selection.organizationId);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const workspace = yield* withDatabase(
        controlDatabasePath,
        "read_rollback_workspace",
        (database) =>
          Effect.try({
            try: () =>
              database
                .prepare(
                  `SELECT organization_id AS organizationId, project_id AS projectId,
                        id AS workspaceId, database_key AS databaseKey, state, origin
                 FROM marketing_workspaces WHERE id = ?`,
                )
                .get(selection.workspaceId) as unknown as WorkspaceRow | undefined,
            catch: (cause) =>
              new MarketingWorkspaceStoreError({ operation: "read_rollback_workspace", cause }),
          }),
      );
      if (workspace === undefined || workspace.state === "rolled_back") {
        return false;
      }
      if (
        workspace.organizationId !== selection.organizationId ||
        workspace.projectId !== selection.projectId
      ) {
        return yield* new MarketingWorkspaceCrossOrganizationError({});
      }
      if (workspace.state === "active" || workspace.state === "deleting") {
        return yield* new MarketingWorkspaceConflictError({
          reason: "active_workspace_cannot_be_rolled_back",
        });
      }
      if (workspace.origin === "managed") {
        yield* Effect.try({
          try: () => removeDatabaseFiles(databasePath),
          catch: (cause) =>
            new MarketingWorkspaceStoreError({ operation: "rollback_workspace_files", cause }),
        });
      }
      yield* withDatabase(controlDatabasePath, "finish_rollback", (database) =>
        Effect.try({
          try: () =>
            database
              .prepare(
                `UPDATE marketing_workspaces SET state = 'rolled_back', updated_at = ?
                 WHERE id = ?`,
              )
              .run(nowIso, selection.workspaceId),
          catch: (cause) =>
            new MarketingWorkspaceStoreError({ operation: "finish_rollback", cause }),
        }),
      );
      return true;
    });

  const deleteOrganizationWorkspace: OrganizationWorkspaceStore["deleteOrganizationWorkspace"] = (
    selection,
  ) =>
    Effect.gen(function* () {
      yield* initialize();
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const databasePath = organizationWorkspaceDatabasePath(stateRoot, selection.organizationId);
      const changed = yield* withDatabase(
        controlDatabasePath,
        "begin_workspace_deletion",
        (database) =>
          Effect.try({
            try: () =>
              runTransaction(database, () => {
                const workspace = database
                  .prepare(
                    `SELECT organization_id AS organizationId, project_id AS projectId,
                            id AS workspaceId, database_key AS databaseKey, state, origin
                     FROM marketing_workspaces WHERE id = ?`,
                  )
                  .get(selection.workspaceId) as unknown as WorkspaceRow | undefined;
                if (workspace === undefined || workspace.state === "deleted") {
                  return false;
                }
                if (
                  workspace.organizationId !== selection.organizationId ||
                  workspace.projectId !== selection.projectId
                ) {
                  throw new MarketingWorkspaceCrossOrganizationError({});
                }
                database
                  .prepare(
                    `UPDATE marketing_workspaces SET state = 'deleting', updated_at = ? WHERE id = ?`,
                  )
                  .run(nowIso, selection.workspaceId);
                database
                  .prepare(`UPDATE marketing_organizations SET state = 'deleting' WHERE id = ?`)
                  .run(selection.organizationId);
                return true;
              }),
            catch: (cause) => mapStoreCause("begin_workspace_deletion", cause),
          }),
      );
      if (!changed) return false;

      yield* Effect.try({
        try: () => removeDatabaseFiles(databasePath),
        catch: (cause) =>
          new MarketingWorkspaceStoreError({ operation: "delete_workspace_files", cause }),
      });
      yield* withDatabase(controlDatabasePath, "finish_workspace_deletion", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              database
                .prepare(
                  `UPDATE marketing_workspaces
                     SET state = 'deleted', updated_at = ?, deleted_at = ? WHERE id = ?`,
                )
                .run(nowIso, nowIso, selection.workspaceId);
              database
                .prepare(
                  `UPDATE marketing_projects SET state = 'deleted', deleted_at = ? WHERE id = ?`,
                )
                .run(nowIso, selection.projectId);
              database
                .prepare(
                  `UPDATE marketing_organizations SET state = 'deleted', deleted_at = ? WHERE id = ?`,
                )
                .run(nowIso, selection.organizationId);
            }),
          catch: (cause) =>
            new MarketingWorkspaceStoreError({ operation: "finish_workspace_deletion", cause }),
        }),
      );
      return true;
    });

  const linkT3Reference: OrganizationWorkspaceStore["linkT3Reference"] = (input) =>
    Effect.gen(function* () {
      yield* resolve({ actor: input.actor, selection: input.selection }, () => Effect.void);
      const now = yield* DateTime.now;
      if (
        input.expiresAt !== undefined &&
        input.expiresAt.epochMilliseconds <= now.epochMilliseconds
      ) {
        return yield* new MarketingWorkspaceConflictError({
          reason: "t3_reference_already_expired",
        });
      }
      const nowIso = DateTime.formatIso(now);
      return yield* withDatabase(controlDatabasePath, "link_t3_reference", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              const existingById = database
                .prepare(
                  `SELECT id AS bindingId, organization_id AS organizationId,
                          target_kind AS targetKind, target_id AS targetId,
                          reference_kind AS referenceKind, reference_value AS referenceValue,
                          state, linked_at AS linkedAt, expires_at AS expiresAt,
                          stale_at AS staleAt, deleted_at AS deletedAt
                   FROM marketing_t3_reference_bindings WHERE id = ?`,
                )
                .get(input.bindingId) as unknown as T3ReferenceRow | undefined;
              if (existingById !== undefined) {
                if (existingById.organizationId !== input.selection.organizationId) {
                  throw new MarketingWorkspaceCrossOrganizationError({});
                }
                if (
                  existingById.targetKind !== input.target.kind ||
                  existingById.targetId !== input.target.id ||
                  existingById.referenceKind !== input.reference.kind ||
                  existingById.referenceValue !== input.reference.value ||
                  existingById.state !== "active"
                ) {
                  throw new MarketingWorkspaceConflictError({
                    reason: "t3_reference_binding_conflict",
                  });
                }
                return t3ReferenceLifecycleFromRow(existingById);
              }

              database
                .prepare(
                  `INSERT INTO marketing_t3_reference_bindings(
                     id, organization_id, target_kind, target_id,
                     reference_kind, reference_value, state, linked_at, expires_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
                )
                .run(
                  input.bindingId,
                  input.selection.organizationId,
                  input.target.kind,
                  input.target.id,
                  input.reference.kind,
                  input.reference.value,
                  nowIso,
                  input.expiresAt === undefined ? null : DateTime.formatIso(input.expiresAt),
                );
              const row = readT3ReferenceRow(
                database,
                input.selection.organizationId,
                input.bindingId,
              );
              if (row === undefined) {
                throw new MarketingWorkspaceConflictError({
                  reason: "t3_reference_write_not_visible",
                });
              }
              return t3ReferenceLifecycleFromRow(row);
            }),
          catch: (cause) => mapStoreCause("link_t3_reference", cause),
        }),
      );
    });

  const markT3ReferenceStale: OrganizationWorkspaceStore["markT3ReferenceStale"] = (input) =>
    Effect.gen(function* () {
      yield* resolve({ actor: input.actor, selection: input.selection }, () => Effect.void);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      return yield* withDatabase(controlDatabasePath, "mark_t3_reference_stale", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              const existing = readT3ReferenceRow(
                database,
                input.selection.organizationId,
                input.bindingId,
              );
              if (existing === undefined) {
                throw new MarketingWorkspaceConflictError({
                  reason: "t3_reference_binding_missing",
                });
              }
              if (existing.state === "deleted") {
                throw new MarketingWorkspaceConflictError({
                  reason: "deleted_t3_reference_cannot_transition",
                });
              }
              if (existing.state === "active") {
                database
                  .prepare(
                    `UPDATE marketing_t3_reference_bindings
                     SET state = 'stale', stale_at = ?
                     WHERE id = ? AND organization_id = ?`,
                  )
                  .run(nowIso, input.bindingId, input.selection.organizationId);
              }
              const row = readT3ReferenceRow(
                database,
                input.selection.organizationId,
                input.bindingId,
              );
              if (row === undefined) {
                throw new MarketingWorkspaceConflictError({
                  reason: "t3_reference_write_not_visible",
                });
              }
              return t3ReferenceLifecycleFromRow(row);
            }),
          catch: (cause) => mapStoreCause("mark_t3_reference_stale", cause),
        }),
      );
    });

  const deleteT3Reference: OrganizationWorkspaceStore["deleteT3Reference"] = (input) =>
    Effect.gen(function* () {
      yield* resolve({ actor: input.actor, selection: input.selection }, () => Effect.void);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      return yield* withDatabase(controlDatabasePath, "delete_t3_reference", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              const existing = readT3ReferenceRow(
                database,
                input.selection.organizationId,
                input.bindingId,
              );
              if (existing === undefined) {
                throw new MarketingWorkspaceConflictError({
                  reason: "t3_reference_binding_missing",
                });
              }
              if (existing.state !== "deleted") {
                database
                  .prepare(
                    `UPDATE marketing_t3_reference_bindings
                     SET state = 'deleted', reference_kind = NULL, reference_value = NULL,
                         expires_at = NULL, deleted_at = ?
                     WHERE id = ? AND organization_id = ?`,
                  )
                  .run(nowIso, input.bindingId, input.selection.organizationId);
              }
              const row = readT3ReferenceRow(
                database,
                input.selection.organizationId,
                input.bindingId,
              );
              if (row === undefined) {
                throw new MarketingWorkspaceConflictError({
                  reason: "t3_reference_write_not_visible",
                });
              }
              return t3ReferenceLifecycleFromRow(row);
            }),
          catch: (cause) => mapStoreCause("delete_t3_reference", cause),
        }),
      );
    });

  return {
    initialize,
    provision,
    backfill,
    resolve,
    revokeMembership,
    rollbackProvisioning,
    deleteOrganizationWorkspace,
    linkT3Reference,
    markT3ReferenceStale,
    deleteT3Reference,
  };
}
