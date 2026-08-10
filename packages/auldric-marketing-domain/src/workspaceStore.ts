// @effect-diagnostics nodeBuiltinImport:off - node:sqlite needs synchronous, exact filesystem paths to enforce the physical tenant boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

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
  type MarketingWorkspaceSelection,
  T3ActorIssuer,
  type T3ActorIssuer as T3ActorIssuerType,
  T3ActorSubject,
  type T3ActorSubject as T3ActorSubjectType,
} from "./identity.ts";

const CONTROL_SCHEMA_VERSION = 1;
const ORGANIZATION_SCHEMA_VERSION = 2;
const CONTROL_DATABASE_FILENAME = "control.sqlite";
const ORGANIZATION_DATABASE_FILENAME = "workspace.sqlite";
const decodeT3ActorIssuer = Schema.decodeUnknownSync(T3ActorIssuer);
const decodeT3ActorSubject = Schema.decodeUnknownSync(T3ActorSubject);

type WorkspaceStoreDomainError =
  | MarketingActorResolutionError
  | MarketingWorkspaceConflictError
  | MarketingWorkspaceCrossOrganizationError
  | MarketingWorkspaceUnavailableError;

export type OrganizationWorkspaceStoreError =
  | WorkspaceStoreDomainError
  | MarketingWorkspaceStoreError;

export const MarketingWorkspacePermission = Schema.Literals([
  "bootstrap-new-organization",
  "join-existing-organization",
  "resolve-workspace",
  "revoke-membership",
  "delete-workspace",
  "link-t3-reference",
  "mark-t3-reference-stale",
  "delete-t3-reference",
  "backfill-workspace",
  "rollback-provisioning",
]);
export type MarketingWorkspacePermission = typeof MarketingWorkspacePermission.Type;

export interface MarketingWorkspaceAuthorizationRequirement {
  readonly permission: MarketingWorkspacePermission;
  readonly selection: MarketingWorkspaceSelection;
  readonly targetMarketingActorId?: MarketingActorId;
  readonly bindingId?: MarketingT3ReferenceBindingId;
}

/**
 * Canonical identity returned only by the server composition adapter after it accepts a
 * request-scoped T3 principal or invitation capability. This is intentionally not a Schema and is
 * never accepted from a wire payload.
 */
export interface MarketingAuthorizedActorIdentity {
  readonly issuer: T3ActorIssuerType;
  readonly subject: T3ActorSubjectType;
}

export interface OrganizationWorkspaceStoreConfig<RequestAuthority> {
  /** Dedicated Auldric root. It must not point at T3's state.sqlite file. */
  readonly stateRoot: string;
  /**
   * The T3 server composition root must inject a fail-closed resolver over its opaque,
   * request-scoped principal type. Marketing has no decoder, issuer, or fallback for that type.
   */
  readonly authorize: (
    requestAuthority: RequestAuthority,
    requirement: MarketingWorkspaceAuthorizationRequirement,
  ) => Effect.Effect<MarketingAuthorizedActorIdentity, MarketingActorResolutionError>;
}

export interface BootstrapOrganizationWorkspaceInput<RequestAuthority> {
  readonly requestAuthority: RequestAuthority;
  readonly selection: MarketingWorkspaceSelection;
  readonly idempotencyKey: MarketingIdempotencyKey;
}

export type BackfillOrganizationWorkspaceInput<RequestAuthority> =
  BootstrapOrganizationWorkspaceInput<RequestAuthority>;

export interface JoinOrganizationWorkspaceInput<RequestAuthority> {
  readonly requestAuthority: RequestAuthority;
  readonly selection: MarketingWorkspaceSelection;
}

export interface MarketingWorkspaceResolutionInput<RequestAuthority> {
  readonly requestAuthority: RequestAuthority;
  readonly selection: MarketingWorkspaceSelection;
}

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

export interface OrganizationWorkspaceStore<RequestAuthority> {
  readonly initialize: () => Effect.Effect<void, MarketingWorkspaceStoreError>;
  readonly bootstrap: (
    input: BootstrapOrganizationWorkspaceInput<RequestAuthority>,
  ) => Effect.Effect<OrganizationWorkspaceBinding, OrganizationWorkspaceStoreError>;
  readonly backfill: (
    input: BackfillOrganizationWorkspaceInput<RequestAuthority>,
  ) => Effect.Effect<OrganizationWorkspaceBinding, OrganizationWorkspaceStoreError>;
  readonly join: (
    input: JoinOrganizationWorkspaceInput<RequestAuthority>,
  ) => Effect.Effect<OrganizationWorkspaceBinding, OrganizationWorkspaceStoreError>;
  readonly resolve: <A, E, R>(
    input: MarketingWorkspaceResolutionInput<RequestAuthority>,
    use: (workspace: ResolvedOrganizationWorkspaceDatabase) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OrganizationWorkspaceStoreError, R>;
  readonly revokeMembership: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly targetMarketingActorId: MarketingActorId;
  }) => Effect.Effect<boolean, OrganizationWorkspaceStoreError>;
  /** Recovery-only operation for provisioning that never reached active state. */
  readonly rollbackProvisioning: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
  }) => Effect.Effect<boolean, OrganizationWorkspaceStoreError>;
  readonly deleteOrganizationWorkspace: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
  }) => Effect.Effect<boolean, OrganizationWorkspaceStoreError>;
  readonly linkT3Reference: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly bindingId: MarketingT3ReferenceBindingId;
    readonly target: MarketingReferenceTarget;
    readonly reference: ActiveT3Reference;
    readonly expiresAt?: DateTime.Utc;
  }) => Effect.Effect<MarketingT3ReferenceLifecycle, OrganizationWorkspaceStoreError>;
  readonly markT3ReferenceStale: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly bindingId: MarketingT3ReferenceBindingId;
  }) => Effect.Effect<MarketingT3ReferenceLifecycle, OrganizationWorkspaceStoreError>;
  readonly deleteT3Reference: (input: {
    readonly requestAuthority: RequestAuthority;
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

function userTableNames(database: NodeSqlite.DatabaseSync): ReadonlyArray<string> {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: string }>
  ).map((row) => row.name);
}

function userTriggerNames(database: NodeSqlite.DatabaseSync): ReadonlyArray<string> {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: string }>
  ).map((row) => row.name);
}

function tableColumns(database: NodeSqlite.DatabaseSync, table: string): ReadonlySet<string> {
  return new Set(
    (
      database.prepare(`PRAGMA table_info(${table})`).all() as unknown as ReadonlyArray<{
        readonly name: string;
      }>
    ).map((row) => row.name),
  );
}

function hasExactRequiredColumns(
  database: NodeSqlite.DatabaseSync,
  table: string,
  columns: ReadonlyArray<string>,
): boolean {
  const actual = tableColumns(database, table);
  return actual.size === columns.length && columns.every((column) => actual.has(column));
}

const controlSchemaV1Columns = {
  auldric_control_schema_migrations: ["version", "applied_at"],
  marketing_actors: [
    "id",
    "t3_actor_issuer",
    "t3_actor_subject",
    "status",
    "created_at",
    "revoked_at",
  ],
  marketing_organizations: ["id", "state", "created_at", "deleted_at"],
  marketing_projects: ["id", "organization_id", "state", "created_at", "deleted_at"],
  marketing_organization_memberships: [
    "organization_id",
    "marketing_actor_id",
    "status",
    "bound_at",
    "revoked_at",
  ],
  marketing_workspaces: [
    "id",
    "organization_id",
    "project_id",
    "database_key",
    "state",
    "origin",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  marketing_identity_operations: [
    "idempotency_key",
    "payload_hash",
    "state",
    "organization_id",
    "workspace_id",
    "created_at",
    "updated_at",
  ],
  marketing_t3_reference_bindings: [
    "id",
    "organization_id",
    "target_kind",
    "target_id",
    "reference_kind",
    "reference_value",
    "state",
    "linked_at",
    "expires_at",
    "stale_at",
    "deleted_at",
  ],
} as const;

function verifyControlSchemaV1(database: NodeSqlite.DatabaseSync): void {
  const expectedTables = Object.keys(controlSchemaV1Columns).sort();
  const actualTables = userTableNames(database);
  if (expectedTables.some((table) => !actualTables.includes(table))) {
    throw new Error("control database has a partial or unidentified schema");
  }
  for (const [table, columns] of Object.entries(controlSchemaV1Columns)) {
    if (!hasExactRequiredColumns(database, table, columns)) {
      throw new Error(`control database table ${table} does not match schema v1`);
    }
  }
  const versions = database
    .prepare("SELECT version FROM auldric_control_schema_migrations ORDER BY version")
    .all() as unknown as ReadonlyArray<SchemaVersionRow>;
  if (versions.length !== 1 || versions[0]?.version !== CONTROL_SCHEMA_VERSION) {
    throw new Error("control database migration history is not exactly schema v1");
  }
}

function createControlSchemaV1(database: NodeSqlite.DatabaseSync): void {
  runTransaction(database, () => {
    database.exec(`
      CREATE TABLE auldric_control_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE marketing_actors (
        id TEXT PRIMARY KEY,
        t3_actor_issuer TEXT NOT NULL,
        t3_actor_subject TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE (t3_actor_issuer, t3_actor_subject)
      );

      CREATE TABLE marketing_organizations (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('active', 'deleting', 'deleted')),
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE marketing_projects (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES marketing_organizations(id),
        state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE (organization_id, id)
      );

      CREATE TABLE marketing_organization_memberships (
        organization_id TEXT NOT NULL REFERENCES marketing_organizations(id),
        marketing_actor_id TEXT NOT NULL REFERENCES marketing_actors(id),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        bound_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (organization_id, marketing_actor_id)
      );

      CREATE TABLE marketing_workspaces (
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

      CREATE TABLE marketing_identity_operations (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
        organization_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE marketing_t3_reference_bindings (
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
      .prepare("INSERT INTO auldric_control_schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(CONTROL_SCHEMA_VERSION, "schema-v1");
    verifyControlSchemaV1(database);
  });
}

function migrateControlDatabase(database: NodeSqlite.DatabaseSync): void {
  if (userTableNames(database).length === 0) {
    createControlSchemaV1(database);
    return;
  }
  verifyControlSchemaV1(database);
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

const organizationSchemaV1Columns = {
  auldric_organization_schema_migrations: ["version", "applied_at"],
  auldric_organization_identity: ["singleton", "organization_id", "database_key", "created_at"],
  auldric_marketing_workspace_registry: [
    "workspace_id",
    "organization_id",
    "project_id",
    "created_at",
  ],
} as const;

function verifyOrganizationSchemaV1(database: NodeSqlite.DatabaseSync): void {
  const expectedTables = Object.keys(organizationSchemaV1Columns).sort();
  const actualTables = userTableNames(database);
  if (expectedTables.some((table) => !actualTables.includes(table))) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_schema_stale",
    });
  }
  for (const [table, columns] of Object.entries(organizationSchemaV1Columns)) {
    if (!hasExactRequiredColumns(database, table, columns)) {
      throw new MarketingWorkspaceUnavailableError({
        reason: "workspace_database_schema_stale",
      });
    }
  }
  const versions = database
    .prepare("SELECT version FROM auldric_organization_schema_migrations ORDER BY version")
    .all() as unknown as ReadonlyArray<SchemaVersionRow>;
  if (versions.length !== 1 || versions[0]?.version !== 1) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_schema_stale",
    });
  }
}

function createManagedOrganizationSchemaV1(
  database: NodeSqlite.DatabaseSync,
  input: { readonly selection: MarketingWorkspaceSelection; readonly databaseKey: string },
): void {
  runTransaction(database, () => {
    database.exec(`
      CREATE TABLE auldric_organization_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE auldric_organization_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        organization_id TEXT NOT NULL,
        database_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE auldric_marketing_workspace_registry (
        workspace_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    database
      .prepare(
        `INSERT INTO auldric_organization_identity(
           singleton, organization_id, database_key, created_at
         ) VALUES (1, ?, ?, ?)`,
      )
      .run(input.selection.organizationId, input.databaseKey, "schema-v1");
    database
      .prepare(
        `INSERT INTO auldric_marketing_workspace_registry(
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
        "INSERT INTO auldric_organization_schema_migrations(version, applied_at) VALUES (?, ?)",
      )
      .run(1, "schema-v1");
    verifyOrganizationSchemaV1(database);
  });
}

const organizationSchemaV2Columns = {
  ...organizationSchemaV1Columns,
  auldric_canonical_objects: [
    "object_id",
    "object_kind",
    "organization_id",
    "project_id",
    "workspace_id",
    "canonical_key",
    "current_version",
    "head_revision_id",
    "created_at",
    "updated_at",
  ],
  auldric_canonical_revisions: [
    "revision_id",
    "object_id",
    "object_kind",
    "version",
    "environment_id",
    "schema_key",
    "schema_version",
    "definition_key",
    "definition_version",
    "workflow_instance_id",
    "workflow_revision_id",
    "workflow_revision_version",
    "stage_key",
    "step_key",
    "renderer_key",
    "renderer_version",
    "projection_source_object_id",
    "projection_source_revision_id",
    "projection_source_version",
    "payload_json",
    "payload_sha256",
    "actor_id",
    "idempotency_key",
    "created_at",
  ],
  auldric_canonical_revision_references: [
    "revision_id",
    "reference_kind",
    "ordinal",
    "target_object_id",
    "target_revision_id",
    "target_version",
  ],
  auldric_canonical_projection_facts: ["revision_id", "fact_key", "value_json", "value_sha256"],
  auldric_canonical_idempotency: [
    "idempotency_key",
    "operation",
    "payload_hash",
    "object_id",
    "revision_id",
    "result_version",
    "created_at",
  ],
} as const;

const organizationSchemaV2Triggers = [
  "auldric_canonical_idempotency_immutable_delete",
  "auldric_canonical_idempotency_immutable_update",
  "auldric_canonical_projection_facts_immutable_delete",
  "auldric_canonical_projection_facts_immutable_update",
  "auldric_canonical_references_immutable_delete",
  "auldric_canonical_references_immutable_update",
  "auldric_canonical_revisions_immutable_delete",
  "auldric_canonical_revisions_immutable_update",
] as const;

interface SqliteSchemaDefinitionRow {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

function canonicalSchemaDefinitions(
  database: NodeSqlite.DatabaseSync,
): ReadonlyArray<SqliteSchemaDefinitionRow> {
  return (
    database
      .prepare(
        `SELECT type, name, tbl_name AS tableName, sql
         FROM sqlite_master
         WHERE sql IS NOT NULL
           AND (name GLOB 'auldric_canonical_*' OR tbl_name GLOB 'auldric_canonical_*')
         ORDER BY type, name`,
      )
      .all() as unknown as ReadonlyArray<SqliteSchemaDefinitionRow>
  ).map((row) => ({ ...row, sql: normalizeSchemaSql(row.sql) }));
}

let expectedCanonicalSchemaDefinitions: ReadonlyArray<SqliteSchemaDefinitionRow> | undefined;

function getExpectedCanonicalSchemaDefinitions(): ReadonlyArray<SqliteSchemaDefinitionRow> {
  if (expectedCanonicalSchemaDefinitions !== undefined) {
    return expectedCanonicalSchemaDefinitions;
  }
  const database = new NodeSqlite.DatabaseSync(":memory:");
  try {
    createOrganizationSchemaV2Objects(database);
    expectedCanonicalSchemaDefinitions = canonicalSchemaDefinitions(database);
    return expectedCanonicalSchemaDefinitions;
  } finally {
    database.close();
  }
}

function verifyOrganizationSchemaV2(database: NodeSqlite.DatabaseSync): void {
  const actualTables = userTableNames(database);
  const expectedTables = Object.keys(organizationSchemaV2Columns).sort();
  if (
    actualTables.length !== expectedTables.length ||
    expectedTables.some((table, index) => actualTables[index] !== table)
  ) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_schema_stale",
    });
  }
  for (const [table, columns] of Object.entries(organizationSchemaV2Columns)) {
    if (!actualTables.includes(table) || !hasExactRequiredColumns(database, table, columns)) {
      throw new MarketingWorkspaceUnavailableError({
        reason: "workspace_database_schema_stale",
      });
    }
  }
  const actualTriggers = userTriggerNames(database);
  if (organizationSchemaV2Triggers.some((trigger) => !actualTriggers.includes(trigger))) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_schema_stale",
    });
  }
  const actualDefinitions = canonicalSchemaDefinitions(database);
  const expectedDefinitions = getExpectedCanonicalSchemaDefinitions();
  if (
    actualDefinitions.length !== expectedDefinitions.length ||
    actualDefinitions.some((definition, index) => {
      const expected = expectedDefinitions[index];
      return (
        expected === undefined ||
        definition.type !== expected.type ||
        definition.name !== expected.name ||
        definition.tableName !== expected.tableName ||
        definition.sql !== expected.sql
      );
    })
  ) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_schema_stale",
    });
  }
  const versions = database
    .prepare("SELECT version FROM auldric_organization_schema_migrations ORDER BY version")
    .all() as unknown as ReadonlyArray<SchemaVersionRow>;
  if (
    versions.length !== ORGANIZATION_SCHEMA_VERSION ||
    versions.some((row, index) => row.version !== index + 1)
  ) {
    throw new MarketingWorkspaceUnavailableError({
      reason: "workspace_database_schema_stale",
    });
  }
}

function createOrganizationSchemaV2Objects(database: NodeSqlite.DatabaseSync): void {
  database.exec(`
      CREATE TABLE auldric_canonical_objects (
        object_id TEXT PRIMARY KEY,
        object_kind TEXT NOT NULL CHECK (
          object_kind IN (
            'source', 'workflow-instance', 'plan', 'artifact',
            'saved-output', 'review', 'decision', 'next-action'
          )
        ),
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK (current_version > 0),
        head_revision_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, object_kind, canonical_key),
        FOREIGN KEY (object_id, head_revision_id, current_version)
          REFERENCES auldric_canonical_revisions(object_id, revision_id, version)
          DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE auldric_canonical_revisions (
        revision_id TEXT PRIMARY KEY,
        object_id TEXT NOT NULL REFERENCES auldric_canonical_objects(object_id),
        object_kind TEXT NOT NULL CHECK (
          object_kind IN (
            'source', 'workflow-instance', 'plan', 'artifact',
            'saved-output', 'review', 'decision', 'next-action'
          )
        ),
        version INTEGER NOT NULL CHECK (version > 0),
        environment_id TEXT,
        schema_key TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        definition_key TEXT,
        definition_version INTEGER CHECK (definition_version > 0),
        workflow_instance_id TEXT,
        workflow_revision_id TEXT,
        workflow_revision_version INTEGER CHECK (workflow_revision_version > 0),
        stage_key TEXT,
        step_key TEXT,
        renderer_key TEXT,
        renderer_version INTEGER CHECK (renderer_version > 0),
        projection_source_object_id TEXT,
        projection_source_revision_id TEXT,
        projection_source_version INTEGER CHECK (projection_source_version > 0),
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        UNIQUE (object_id, version),
        UNIQUE (object_id, revision_id, version),
        CHECK (
          (definition_key IS NULL AND definition_version IS NULL)
          OR (definition_key IS NOT NULL AND definition_version IS NOT NULL)
        ),
        CHECK (
          (stage_key IS NULL AND step_key IS NULL)
          OR workflow_instance_id IS NOT NULL
        ),
        CHECK (
          (workflow_instance_id IS NULL
            AND workflow_revision_id IS NULL
            AND workflow_revision_version IS NULL)
          OR
          (workflow_instance_id IS NOT NULL
            AND workflow_revision_id IS NOT NULL
            AND workflow_revision_version IS NOT NULL)
        ),
        CHECK (
          (object_kind = 'saved-output'
            AND renderer_key IS NOT NULL
            AND renderer_version IS NOT NULL
            AND projection_source_object_id IS NOT NULL
            AND projection_source_revision_id IS NOT NULL
            AND projection_source_version IS NOT NULL)
          OR
          (object_kind <> 'saved-output'
            AND renderer_key IS NULL
            AND renderer_version IS NULL
            AND projection_source_object_id IS NULL
            AND projection_source_revision_id IS NULL
            AND projection_source_version IS NULL)
        ),
        FOREIGN KEY (
          workflow_instance_id,
          workflow_revision_id,
          workflow_revision_version
        ) REFERENCES auldric_canonical_revisions(object_id, revision_id, version),
        FOREIGN KEY (
          projection_source_object_id,
          projection_source_revision_id,
          projection_source_version
        ) REFERENCES auldric_canonical_revisions(object_id, revision_id, version)
      );

      CREATE TABLE auldric_canonical_revision_references (
        revision_id TEXT NOT NULL REFERENCES auldric_canonical_revisions(revision_id),
        reference_kind TEXT NOT NULL CHECK (reference_kind IN ('source', 'review', 'decision')),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        target_object_id TEXT NOT NULL,
        target_revision_id TEXT NOT NULL,
        target_version INTEGER NOT NULL CHECK (target_version > 0),
        PRIMARY KEY (revision_id, reference_kind, ordinal),
        UNIQUE (revision_id, reference_kind, target_revision_id),
        FOREIGN KEY (target_object_id, target_revision_id, target_version)
          REFERENCES auldric_canonical_revisions(object_id, revision_id, version)
      );

      CREATE TABLE auldric_canonical_projection_facts (
        revision_id TEXT NOT NULL REFERENCES auldric_canonical_revisions(revision_id),
        fact_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        value_sha256 TEXT NOT NULL,
        PRIMARY KEY (revision_id, fact_key)
      );

      CREATE TABLE auldric_canonical_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        object_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        result_version INTEGER NOT NULL CHECK (result_version > 0),
        created_at TEXT NOT NULL,
        FOREIGN KEY (object_id, revision_id, result_version)
          REFERENCES auldric_canonical_revisions(object_id, revision_id, version)
      );

      CREATE INDEX auldric_canonical_objects_inventory
        ON auldric_canonical_objects(workspace_id, object_kind, canonical_key);
      CREATE INDEX auldric_canonical_revision_actor
        ON auldric_canonical_revisions(actor_id, created_at);
      CREATE INDEX auldric_canonical_revision_workflow
        ON auldric_canonical_revisions(
          workflow_instance_id, workflow_revision_version, stage_key, step_key
        );
      CREATE INDEX auldric_canonical_reference_target
        ON auldric_canonical_revision_references(
          reference_kind, target_object_id, target_version
        );
      CREATE INDEX auldric_canonical_projection_fact_query
        ON auldric_canonical_projection_facts(fact_key, revision_id);

      CREATE TRIGGER auldric_canonical_revisions_immutable_update
      BEFORE UPDATE ON auldric_canonical_revisions
      BEGIN
        SELECT RAISE(ABORT, 'canonical revisions are immutable');
      END;

      CREATE TRIGGER auldric_canonical_revisions_immutable_delete
      BEFORE DELETE ON auldric_canonical_revisions
      BEGIN
        SELECT RAISE(ABORT, 'canonical revisions are immutable');
      END;

      CREATE TRIGGER auldric_canonical_references_immutable_update
      BEFORE UPDATE ON auldric_canonical_revision_references
      BEGIN
        SELECT RAISE(ABORT, 'canonical revision references are immutable');
      END;

      CREATE TRIGGER auldric_canonical_references_immutable_delete
      BEFORE DELETE ON auldric_canonical_revision_references
      BEGIN
        SELECT RAISE(ABORT, 'canonical revision references are immutable');
      END;

      CREATE TRIGGER auldric_canonical_projection_facts_immutable_update
      BEFORE UPDATE ON auldric_canonical_projection_facts
      BEGIN
        SELECT RAISE(ABORT, 'canonical projection facts are immutable');
      END;

      CREATE TRIGGER auldric_canonical_projection_facts_immutable_delete
      BEFORE DELETE ON auldric_canonical_projection_facts
      BEGIN
        SELECT RAISE(ABORT, 'canonical projection facts are immutable');
      END;

      CREATE TRIGGER auldric_canonical_idempotency_immutable_update
      BEFORE UPDATE ON auldric_canonical_idempotency
      BEGIN
        SELECT RAISE(ABORT, 'canonical idempotency receipts are immutable');
      END;

      CREATE TRIGGER auldric_canonical_idempotency_immutable_delete
      BEFORE DELETE ON auldric_canonical_idempotency
      BEGIN
        SELECT RAISE(ABORT, 'canonical idempotency receipts are immutable');
      END;
  `);
}

function migrateOrganizationSchemaV1ToV2(database: NodeSqlite.DatabaseSync): void {
  runTransaction(database, () => {
    verifyOrganizationSchemaV1(database);
    createOrganizationSchemaV2Objects(database);
    database
      .prepare(
        "INSERT INTO auldric_organization_schema_migrations(version, applied_at) VALUES (?, ?)",
      )
      .run(ORGANIZATION_SCHEMA_VERSION, "schema-v2-canonical-content");
    verifyOrganizationSchemaV2(database);
  });
}

function migrateManagedOrganizationDatabase(
  database: NodeSqlite.DatabaseSync,
  input: { readonly selection: MarketingWorkspaceSelection; readonly databaseKey: string },
): void {
  if (userTableNames(database).length === 0) {
    createManagedOrganizationSchemaV1(database, input);
  }
  const versions = database
    .prepare("SELECT version FROM auldric_organization_schema_migrations ORDER BY version")
    .all() as unknown as ReadonlyArray<SchemaVersionRow>;
  if (versions.length === 1 && versions[0]?.version === 1) {
    migrateOrganizationSchemaV1ToV2(database);
  } else {
    verifyOrganizationSchemaV2(database);
  }
  verifyOrganizationDatabaseIdentity(database, input);
}

function verifyOrganizationDatabaseIdentity(
  database: NodeSqlite.DatabaseSync,
  input: { readonly selection: MarketingWorkspaceSelection; readonly databaseKey: string },
): void {
  const identityCount = database
    .prepare("SELECT COUNT(*) AS count FROM auldric_organization_identity")
    .get() as unknown as { readonly count: number };
  const identity = database
    .prepare(
      `SELECT organization_id AS organizationId, database_key AS databaseKey
       FROM auldric_organization_identity WHERE singleton = 1`,
    )
    .get() as unknown as OrganizationIdentityRow | undefined;
  if (identityCount.count !== 1 || identity === undefined) {
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
  const workspace = database
    .prepare(
      `SELECT workspace_id AS workspaceId, organization_id AS organizationId,
              project_id AS projectId
       FROM auldric_marketing_workspace_registry WHERE workspace_id = ?`,
    )
    .get(input.selection.workspaceId) as unknown as WorkspaceRegistryRow | undefined;
  const workspaceCount = database
    .prepare("SELECT COUNT(*) AS count FROM auldric_marketing_workspace_registry")
    .get() as unknown as { readonly count: number };
  if (
    workspaceCount.count !== 1 ||
    workspace === undefined ||
    workspace.organizationId !== input.selection.organizationId ||
    workspace.projectId !== input.selection.projectId
  ) {
    throw new MarketingWorkspaceUnavailableError({ reason: "workspace_registry_stale" });
  }
}

function decodeAuthorizedActor(
  actor: MarketingAuthorizedActorIdentity,
): MarketingAuthorizedActorIdentity {
  try {
    return {
      issuer: decodeT3ActorIssuer(actor.issuer),
      subject: decodeT3ActorSubject(actor.subject),
    };
  } catch {
    throw new MarketingActorResolutionError({ reason: "request_authority_rejected" });
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

interface AuthorizedProvisionOrganizationWorkspaceInput {
  readonly actor: MarketingAuthorizedActorIdentity;
  readonly selection: MarketingWorkspaceSelection;
  readonly idempotencyKey: MarketingIdempotencyKey;
}

function operationPayloadHash(
  input: AuthorizedProvisionOrganizationWorkspaceInput,
  origin: WorkspaceRow["origin"],
): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        origin,
        input.actor.issuer,
        input.actor.subject,
        input.selection.organizationId,
        input.selection.projectId,
        input.selection.workspaceId,
      ]),
    )
    .digest("hex");
}

function makeMarketingActorId(): MarketingActorId {
  return `mact_${NodeCrypto.randomUUID()}` as MarketingActorId;
}

function removeDatabaseFiles(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (NodeFS.existsSync(path)) {
      NodeFS.unlinkSync(path);
    }
  }
}

interface WorkspaceLeaseEntry {
  active: number;
  deleting: boolean;
  drain: Deferred.Deferred<void> | undefined;
}

interface StateRootCoordinator {
  readonly workspaceLeases: Map<string, WorkspaceLeaseEntry>;
  readonly deletionLocks: Map<string, Semaphore.Semaphore>;
  readonly initializationLock: Semaphore.Semaphore;
}

/**
 * Store factories are cheap composition adapters, so one server can create more than one for the
 * same state root. Their handle and deletion lifecycle must still be one process-local critical
 * section. The deployment boundary remains one live server process per state root; SQLite files
 * are not protected from a second process. Coordinators intentionally live for the process
 * lifetime: a live server has a bounded set of configured roots, and eviction without a scoped
 * factory lifetime could split a later factory from an older one that is still in use.
 */
const stateRootCoordinators = new Map<string, StateRootCoordinator>();

function stateRootCoordinator(stateRoot: string): StateRootCoordinator {
  const existing = stateRootCoordinators.get(stateRoot);
  if (existing !== undefined) return existing;
  const coordinator: StateRootCoordinator = {
    workspaceLeases: new Map(),
    deletionLocks: new Map(),
    initializationLock: Semaphore.makeUnsafe(1),
  };
  stateRootCoordinators.set(stateRoot, coordinator);
  return coordinator;
}

export function makeOrganizationWorkspaceStore<RequestAuthority>(
  config: OrganizationWorkspaceStoreConfig<RequestAuthority>,
): OrganizationWorkspaceStore<RequestAuthority> {
  const stateRoot = NodePath.resolve(config.stateRoot);
  const controlDatabasePath = NodePath.join(stateRoot, CONTROL_DATABASE_FILENAME);
  const { workspaceLeases, deletionLocks, initializationLock } = stateRootCoordinator(stateRoot);

  const authorize = (
    requestAuthority: RequestAuthority,
    requirement: MarketingWorkspaceAuthorizationRequirement,
  ) =>
    config.authorize(requestAuthority, requirement).pipe(
      Effect.flatMap((actor) =>
        Effect.try({
          try: () => decodeAuthorizedActor(actor),
          catch: () => new MarketingActorResolutionError({ reason: "request_authority_rejected" }),
        }),
      ),
    );

  const acquireWorkspaceLease = (databaseKey: string) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const entry = workspaceLeases.get(databaseKey) ?? {
            active: 0,
            deleting: false,
            drain: undefined,
          };
          if (entry.deleting) {
            throw new MarketingWorkspaceUnavailableError({ reason: "workspace_unavailable" });
          }
          entry.active += 1;
          workspaceLeases.set(databaseKey, entry);
        },
        catch: (cause) => mapStoreCause("acquire_workspace_lease", cause),
      }),
      () =>
        Effect.suspend(() => {
          const entry = workspaceLeases.get(databaseKey);
          if (entry === undefined || entry.active === 0) return Effect.void;
          entry.active -= 1;
          if (entry.active === 0 && !entry.deleting) {
            workspaceLeases.delete(databaseKey);
            return Effect.void;
          }
          if (entry.active === 0 && entry.drain !== undefined) {
            return Deferred.succeed(entry.drain, undefined).pipe(Effect.asVoid);
          }
          return Effect.void;
        }).pipe(Effect.orDie),
    );

  const beginExclusiveDeletion = (databaseKey: string) =>
    Effect.gen(function* () {
      const requestedDrain = yield* Deferred.make<void>();
      const gate = yield* Effect.try({
        try: () => {
          const entry = workspaceLeases.get(databaseKey) ?? {
            active: 0,
            deleting: false,
            drain: undefined,
          };
          if (!entry.deleting) {
            entry.deleting = true;
            entry.drain = requestedDrain;
          }
          workspaceLeases.set(databaseKey, entry);
          return {
            active: entry.active,
            drain: entry.drain ?? requestedDrain,
          };
        },
        catch: (cause) => mapStoreCause("begin_workspace_lease_drain", cause),
      });
      if (gate.active === 0) {
        yield* Deferred.succeed(gate.drain, undefined);
      }
      return gate;
    });

  const getDeletionLock = (databaseKey: string) =>
    Effect.sync(() => {
      const lock = deletionLocks.get(databaseKey) ?? Semaphore.makeUnsafe(1);
      deletionLocks.set(databaseKey, lock);
      return lock;
    });

  const abortExclusiveDeletion = (databaseKey: string) =>
    Effect.sync(() => {
      const entry = workspaceLeases.get(databaseKey);
      if (entry === undefined) return;
      if (entry.active === 0) {
        workspaceLeases.delete(databaseKey);
        return;
      }
      entry.deleting = false;
      entry.drain = undefined;
    });

  const finishExclusiveDeletion = (databaseKey: string) =>
    Effect.try({
      try: () => {
        const entry = workspaceLeases.get(databaseKey);
        if (entry !== undefined && entry.active !== 0) {
          throw new Error("cannot finish deletion while workspace leases remain active");
        }
        workspaceLeases.delete(databaseKey);
      },
      catch: (cause) =>
        new MarketingWorkspaceStoreError({ operation: "finish_lease_drain", cause }),
    });

  const initialize = Effect.fn("OrganizationWorkspaceStore.initialize")(function* () {
    yield* initializationLock.withPermits(1)(
      Effect.gen(function* () {
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
      }),
    );
  });

  const prepareControlProvision = Effect.fn("OrganizationWorkspaceStore.prepareControlProvision")(
    function* (
      input: AuthorizedProvisionOrganizationWorkspaceInput,
      origin: WorkspaceRow["origin"],
      nowIso: string,
    ) {
      const databaseKey = organizationDatabaseKey(input.selection.organizationId);
      const payloadHash = operationPayloadHash(input, origin);
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
                const completedActor = database
                  .prepare(
                    `SELECT id, status FROM marketing_actors
                     WHERE t3_actor_issuer = ? AND t3_actor_subject = ?`,
                  )
                  .get(input.actor.issuer, input.actor.subject) as unknown as ActorRow | undefined;
                if (completedActor?.status !== "active") {
                  throw new MarketingActorResolutionError({ reason: "actor_binding_missing" });
                }
                const completedMembership = database
                  .prepare(
                    `SELECT status FROM marketing_organization_memberships
                     WHERE organization_id = ? AND marketing_actor_id = ?`,
                  )
                  .get(input.selection.organizationId, completedActor.id) as unknown as
                  | MembershipRow
                  | undefined;
                if (completedMembership === undefined) {
                  throw new MarketingActorResolutionError({ reason: "membership_missing" });
                }
                if (completedMembership.status !== "active") {
                  throw new MarketingActorResolutionError({ reason: "membership_revoked" });
                }
                return {
                  databaseKey,
                  marketingActorId: completedActor.id as MarketingActorId,
                  alreadyCompleted: true,
                };
              }

              const organization = database
                .prepare("SELECT state FROM marketing_organizations WHERE id = ?")
                .get(input.selection.organizationId) as unknown as
                | { readonly state: "active" | "deleting" | "deleted" }
                | undefined;
              if (organization !== undefined && operation === undefined) {
                throw new MarketingWorkspaceConflictError({
                  reason: "organization_already_exists",
                });
              }
              if (organization !== undefined && organization.state !== "active") {
                throw new MarketingWorkspaceConflictError({ reason: "organization_not_active" });
              }

              const actorByUpstream = database
                .prepare(
                  `SELECT id, status FROM marketing_actors
                   WHERE t3_actor_issuer = ? AND t3_actor_subject = ?`,
                )
                .get(input.actor.issuer, input.actor.subject) as unknown as ActorRow | undefined;
              if (actorByUpstream?.status === "revoked") {
                throw new MarketingActorResolutionError({ reason: "actor_binding_revoked" });
              }
              const marketingActorId =
                actorByUpstream === undefined
                  ? makeMarketingActorId()
                  : (actorByUpstream.id as MarketingActorId);
              database
                .prepare(
                  `INSERT OR IGNORE INTO marketing_actors(
                     id, t3_actor_issuer, t3_actor_subject, status, created_at
                   ) VALUES (?, ?, ?, 'active', ?)`,
                )
                .run(marketingActorId, input.actor.issuer, input.actor.subject, nowIso);

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
                .get(input.selection.organizationId, marketingActorId) as unknown as
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
                .run(input.selection.organizationId, marketingActorId, nowIso);

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

              return { databaseKey, marketingActorId, alreadyCompleted: false };
            }),
          catch: (cause) => mapStoreCause("prepare_provision", cause),
        }),
      );
    },
  );

  const finishControlProvision = Effect.fn("OrganizationWorkspaceStore.finishControlProvision")(
    function* (input: AuthorizedProvisionOrganizationWorkspaceInput, nowIso: string) {
      yield* withDatabase(controlDatabasePath, "finish_provision", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              const workspace = database
                .prepare(
                  `UPDATE marketing_workspaces SET state = 'active', updated_at = ?
                   WHERE id = ? AND organization_id = ? AND state = 'provisioning'`,
                )
                .run(nowIso, input.selection.workspaceId, input.selection.organizationId);
              if (workspace.changes !== 1) {
                throw new MarketingWorkspaceUnavailableError({
                  reason: "workspace_unavailable",
                });
              }
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
    function* (input: AuthorizedProvisionOrganizationWorkspaceInput, nowIso: string) {
      yield* withDatabase(controlDatabasePath, "fail_provision", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              database
                .prepare(
                  `UPDATE marketing_workspaces SET state = 'unavailable', updated_at = ?
                   WHERE id = ? AND state = 'provisioning'`,
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
      input: BootstrapOrganizationWorkspaceInput<RequestAuthority>,
      origin: WorkspaceRow["origin"],
      permission: "bootstrap-new-organization" | "backfill-workspace",
    ): Effect.fn.Return<OrganizationWorkspaceBinding, OrganizationWorkspaceStoreError> {
      const actor = yield* authorize(input.requestAuthority, {
        permission,
        selection: input.selection,
      });
      yield* initialize();
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const authorizedInput: AuthorizedProvisionOrganizationWorkspaceInput = {
        actor,
        selection: input.selection,
        idempotencyKey: input.idempotencyKey,
      };
      const databaseKey = organizationDatabaseKey(input.selection.organizationId);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireWorkspaceLease(databaseKey);
          const prepared = yield* prepareControlProvision(authorizedInput, origin, nowIso);
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
                  migrateManagedOrganizationDatabase(database, {
                    selection: input.selection,
                    databaseKey: prepared.databaseKey,
                  }),
                catch: (cause) => mapStoreCause("verify_completed_provision", cause),
              }),
            );
            return {
              marketingActorId: prepared.marketingActorId,
              selection: input.selection,
              databaseKey: prepared.databaseKey,
              state: "active" as const,
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
                ? withDatabase(databasePath, "migrate_backfill_database", (database) =>
                    Effect.try({
                      try: () =>
                        migrateManagedOrganizationDatabase(database, {
                          selection: input.selection,
                          databaseKey: prepared.databaseKey,
                        }),
                      catch: (cause) => mapStoreCause("migrate_backfill_database", cause),
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
                  new MarketingWorkspaceStoreError({
                    operation: "rollback_workspace_files",
                    cause,
                  }),
              }).pipe(Effect.ignore);
            }
            yield* failControlProvision(authorizedInput, nowIso);
            return yield* result.failure;
          }

          yield* finishControlProvision(authorizedInput, nowIso);
          return {
            marketingActorId: prepared.marketingActorId,
            selection: input.selection,
            databaseKey: prepared.databaseKey,
            state: "active" as const,
            origin,
          };
        }),
      );
    },
  );

  const bootstrap: OrganizationWorkspaceStore<RequestAuthority>["bootstrap"] = (input) =>
    provisionWithOrigin(input, "managed", "bootstrap-new-organization");

  const backfill: OrganizationWorkspaceStore<RequestAuthority>["backfill"] = (input) =>
    provisionWithOrigin(input, "backfilled", "backfill-workspace");

  const join: OrganizationWorkspaceStore<RequestAuthority>["join"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const actor = yield* authorize(input.requestAuthority, {
          permission: "join-existing-organization",
          selection: input.selection,
        });
        yield* initialize();
        const databaseKey = organizationDatabaseKey(input.selection.organizationId);
        yield* acquireWorkspaceLease(databaseKey);

        const assertActiveBinding = (database: NodeSqlite.DatabaseSync): WorkspaceRow => {
          const organization = database
            .prepare("SELECT state FROM marketing_organizations WHERE id = ?")
            .get(input.selection.organizationId) as unknown as
            | { readonly state: "active" | "deleting" | "deleted" }
            | undefined;
          if (organization?.state !== "active") {
            throw new MarketingWorkspaceUnavailableError({ reason: "organization_unavailable" });
          }
          const project = database
            .prepare(
              "SELECT organization_id AS organizationId, state FROM marketing_projects WHERE id = ?",
            )
            .get(input.selection.projectId) as unknown as
            | { readonly organizationId: string; readonly state: "active" | "deleted" }
            | undefined;
          if (project?.state !== "active") {
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
          if (workspace?.state !== "active") {
            throw new MarketingWorkspaceUnavailableError({ reason: "workspace_unavailable" });
          }
          if (
            workspace.organizationId !== input.selection.organizationId ||
            workspace.projectId !== input.selection.projectId
          ) {
            throw new MarketingWorkspaceCrossOrganizationError({});
          }
          if (workspace.databaseKey !== databaseKey) {
            throw new MarketingWorkspaceUnavailableError({
              reason: "workspace_database_identity_mismatch",
            });
          }
          return workspace;
        };

        yield* withDatabase(controlDatabasePath, "read_join_workspace", (database) =>
          Effect.try({
            try: () => assertActiveBinding(database),
            catch: (cause) => mapStoreCause("read_join_workspace", cause),
          }),
        );
        const databasePath = organizationWorkspaceDatabasePath(
          stateRoot,
          input.selection.organizationId,
        );
        if (!NodeFS.existsSync(databasePath)) {
          return yield* new MarketingWorkspaceUnavailableError({
            reason: "workspace_database_missing",
          });
        }
        yield* withDatabase(databasePath, "verify_join_workspace", (database) =>
          Effect.try({
            try: () =>
              migrateManagedOrganizationDatabase(database, {
                selection: input.selection,
                databaseKey,
              }),
            catch: (cause) => mapStoreCause("verify_join_workspace", cause),
          }),
        );

        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const marketingActorId = yield* withDatabase(
          controlDatabasePath,
          "join_organization",
          (database) =>
            Effect.try({
              try: () =>
                runTransaction(database, () => {
                  const workspace = assertActiveBinding(database);
                  const existingActor = database
                    .prepare(
                      `SELECT id, status FROM marketing_actors
                       WHERE t3_actor_issuer = ? AND t3_actor_subject = ?`,
                    )
                    .get(actor.issuer, actor.subject) as unknown as ActorRow | undefined;
                  if (existingActor?.status === "revoked") {
                    throw new MarketingActorResolutionError({ reason: "actor_binding_revoked" });
                  }
                  const actorId =
                    existingActor === undefined
                      ? makeMarketingActorId()
                      : (existingActor.id as MarketingActorId);
                  database
                    .prepare(
                      `INSERT OR IGNORE INTO marketing_actors(
                         id, t3_actor_issuer, t3_actor_subject, status, created_at
                       ) VALUES (?, ?, ?, 'active', ?)`,
                    )
                    .run(actorId, actor.issuer, actor.subject, nowIso);
                  const membership = database
                    .prepare(
                      `SELECT status FROM marketing_organization_memberships
                       WHERE organization_id = ? AND marketing_actor_id = ?`,
                    )
                    .get(input.selection.organizationId, actorId) as unknown as
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
                    .run(input.selection.organizationId, actorId, nowIso);
                  return { actorId, workspace };
                }),
              catch: (cause) => mapStoreCause("join_organization", cause),
            }),
        );
        return {
          marketingActorId: marketingActorId.actorId,
          selection: input.selection,
          databaseKey: marketingActorId.workspace.databaseKey,
          state: "active",
          origin: marketingActorId.workspace.origin,
        };
      }),
    );

  const resolveWithPermission = <A, E, R>(
    input: MarketingWorkspaceResolutionInput<RequestAuthority>,
    requirement: MarketingWorkspaceAuthorizationRequirement,
    use: (workspace: ResolvedOrganizationWorkspaceDatabase) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | OrganizationWorkspaceStoreError, R> =>
    Effect.scoped(
      Effect.gen(function* () {
        const actor = yield* authorize(input.requestAuthority, requirement);
        yield* initialize();
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

        yield* acquireWorkspaceLease(resolved.databaseKey);

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
              migrateManagedOrganizationDatabase(database, {
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
      }),
    );

  const resolve: OrganizationWorkspaceStore<RequestAuthority>["resolve"] = (input, use) =>
    resolveWithPermission(
      input,
      { permission: "resolve-workspace", selection: input.selection },
      use,
    );

  const revokeMembership: OrganizationWorkspaceStore<RequestAuthority>["revokeMembership"] = (
    input,
  ) =>
    Effect.gen(function* () {
      yield* authorize(input.requestAuthority, {
        permission: "revoke-membership",
        selection: input.selection,
        targetMarketingActorId: input.targetMarketingActorId,
      });
      yield* initialize();
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      return yield* withDatabase(controlDatabasePath, "revoke_membership", (database) =>
        Effect.try({
          try: () =>
            runTransaction(database, () => {
              const workspace = database
                .prepare(
                  `SELECT organization_id AS organizationId, project_id AS projectId,
                          id AS workspaceId, database_key AS databaseKey, state, origin
                   FROM marketing_workspaces WHERE id = ?`,
                )
                .get(input.selection.workspaceId) as unknown as WorkspaceRow | undefined;
              if (workspace?.state !== "active") {
                throw new MarketingWorkspaceUnavailableError({ reason: "workspace_unavailable" });
              }
              if (
                workspace.organizationId !== input.selection.organizationId ||
                workspace.projectId !== input.selection.projectId
              ) {
                throw new MarketingWorkspaceCrossOrganizationError({});
              }
              const result = database
                .prepare(
                  `UPDATE marketing_organization_memberships
                   SET status = 'revoked', revoked_at = ?
                   WHERE organization_id = ? AND marketing_actor_id = ? AND status = 'active'`,
                )
                .run(nowIso, input.selection.organizationId, input.targetMarketingActorId);
              return result.changes > 0;
            }),
          catch: (cause) => mapStoreCause("revoke_membership", cause),
        }),
      );
    });

  const rollbackProvisioning: OrganizationWorkspaceStore<RequestAuthority>["rollbackProvisioning"] =
    (input) =>
      Effect.gen(function* () {
        yield* authorize(input.requestAuthority, {
          permission: "rollback-provisioning",
          selection: input.selection,
        });
        yield* initialize();
        const databaseKey = organizationDatabaseKey(input.selection.organizationId);
        const databasePath = organizationWorkspaceDatabasePath(
          stateRoot,
          input.selection.organizationId,
        );
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const deletionLock = yield* getDeletionLock(databaseKey);
        return yield* deletionLock.withPermits(1)(
          Effect.gen(function* () {
            let controlMarked = false;
            const attempt = Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const gate = yield* beginExclusiveDeletion(databaseKey);
                const rollback = yield* withDatabase(
                  controlDatabasePath,
                  "begin_provisioning_rollback",
                  (database) =>
                    Effect.try({
                      try: () =>
                        runTransaction(database, () => {
                          const workspace = database
                            .prepare(
                              `SELECT organization_id AS organizationId,
                                      project_id AS projectId,
                                      id AS workspaceId,
                                      database_key AS databaseKey,
                                      state,
                                      origin
                               FROM marketing_workspaces WHERE id = ?`,
                            )
                            .get(input.selection.workspaceId) as unknown as
                            | WorkspaceRow
                            | undefined;
                          if (workspace === undefined || workspace.state === "deleted") {
                            return { kind: "complete" as const };
                          }
                          if (
                            workspace.organizationId !== input.selection.organizationId ||
                            workspace.projectId !== input.selection.projectId
                          ) {
                            throw new MarketingWorkspaceCrossOrganizationError({});
                          }
                          if (workspace.databaseKey !== databaseKey) {
                            throw new MarketingWorkspaceUnavailableError({
                              reason: "workspace_database_identity_mismatch",
                            });
                          }
                          const organization = database
                            .prepare("SELECT state FROM marketing_organizations WHERE id = ?")
                            .get(input.selection.organizationId) as unknown as
                            | { readonly state: "active" | "deleting" | "deleted" }
                            | undefined;
                          if (
                            workspace.state === "rolled_back" &&
                            organization?.state === "deleted"
                          ) {
                            return { kind: "complete" as const };
                          }
                          if (workspace.state === "active") {
                            throw new MarketingWorkspaceConflictError({
                              reason: "active_workspace_cannot_be_rolled_back",
                            });
                          }
                          if (workspace.state === "deleting") {
                            throw new MarketingWorkspaceConflictError({
                              reason: "workspace_deletion_in_progress",
                            });
                          }
                          if (organization === undefined || organization.state === "deleted") {
                            throw new MarketingWorkspaceConflictError({
                              reason: "organization_rollback_state_stale",
                            });
                          }

                          database
                            .prepare(
                              `UPDATE marketing_workspaces
                               SET state = 'rolled_back', updated_at = ?
                               WHERE id = ?`,
                            )
                            .run(nowIso, input.selection.workspaceId);
                          database
                            .prepare(
                              `UPDATE marketing_organizations
                               SET state = 'deleting'
                               WHERE id = ? AND state <> 'deleting'`,
                            )
                            .run(input.selection.organizationId);
                          database
                            .prepare(
                              `UPDATE marketing_identity_operations
                               SET state = 'failed', updated_at = ?
                               WHERE organization_id = ? AND workspace_id = ?`,
                            )
                            .run(
                              nowIso,
                              input.selection.organizationId,
                              input.selection.workspaceId,
                            );
                          return { kind: "rollback" as const, origin: workspace.origin };
                        }),
                      catch: (cause) => mapStoreCause("begin_provisioning_rollback", cause),
                    }),
                );
                if (rollback.kind === "complete") {
                  yield* restore(Deferred.await(gate.drain));
                  yield* finishExclusiveDeletion(databaseKey);
                  return false;
                }
                controlMarked = true;

                yield* restore(Deferred.await(gate.drain));

                if (rollback.origin === "managed") {
                  yield* Effect.try({
                    try: () => removeDatabaseFiles(databasePath),
                    catch: (cause) =>
                      new MarketingWorkspaceStoreError({
                        operation: "rollback_workspace_files",
                        cause,
                      }),
                  });
                }
                yield* withDatabase(
                  controlDatabasePath,
                  "finish_provisioning_rollback",
                  (database) =>
                    Effect.try({
                      try: () =>
                        runTransaction(database, () => {
                          database
                            .prepare(
                              `UPDATE marketing_organization_memberships
                             SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
                             WHERE organization_id = ?`,
                            )
                            .run(nowIso, input.selection.organizationId);
                          database
                            .prepare(
                              `UPDATE marketing_t3_reference_bindings
                             SET state = 'deleted', reference_kind = NULL, reference_value = NULL,
                                 expires_at = NULL, deleted_at = COALESCE(deleted_at, ?)
                             WHERE organization_id = ?`,
                            )
                            .run(nowIso, input.selection.organizationId);
                          database
                            .prepare(
                              `UPDATE marketing_identity_operations
                             SET state = 'failed', updated_at = ?
                             WHERE organization_id = ? AND workspace_id = ?`,
                            )
                            .run(
                              nowIso,
                              input.selection.organizationId,
                              input.selection.workspaceId,
                            );
                          database
                            .prepare(
                              `UPDATE marketing_workspaces
                             SET state = 'rolled_back', updated_at = ?, deleted_at = ?
                             WHERE id = ?`,
                            )
                            .run(nowIso, nowIso, input.selection.workspaceId);
                          database
                            .prepare(
                              `UPDATE marketing_projects
                             SET state = 'deleted', deleted_at = COALESCE(deleted_at, ?)
                             WHERE id = ?`,
                            )
                            .run(nowIso, input.selection.projectId);
                          database
                            .prepare(
                              `UPDATE marketing_organizations
                             SET state = 'deleted', deleted_at = COALESCE(deleted_at, ?)
                             WHERE id = ?`,
                            )
                            .run(nowIso, input.selection.organizationId);
                        }),
                      catch: (cause) => mapStoreCause("finish_provisioning_rollback", cause),
                    }),
                );
                yield* finishExclusiveDeletion(databaseKey);
                return true;
              }),
            );
            return yield* attempt.pipe(
              Effect.onExit(() =>
                controlMarked ? Effect.void : abortExclusiveDeletion(databaseKey),
              ),
            );
          }),
        );
      });

  const deleteOrganizationWorkspace: OrganizationWorkspaceStore<RequestAuthority>["deleteOrganizationWorkspace"] =
    (input) =>
      Effect.gen(function* () {
        yield* authorize(input.requestAuthority, {
          permission: "delete-workspace",
          selection: input.selection,
        });
        yield* initialize();
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const databaseKey = organizationDatabaseKey(input.selection.organizationId);
        const databasePath = organizationWorkspaceDatabasePath(
          stateRoot,
          input.selection.organizationId,
        );
        const deletionLock = yield* getDeletionLock(databaseKey);
        return yield* deletionLock.withPermits(1)(
          Effect.gen(function* () {
            let controlMarked = false;
            const attempt = Effect.gen(function* () {
              const gate = yield* beginExclusiveDeletion(databaseKey);
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
                          .get(input.selection.workspaceId) as unknown as WorkspaceRow | undefined;
                        if (
                          workspace === undefined ||
                          workspace.state === "deleted" ||
                          workspace.state === "rolled_back"
                        ) {
                          return false;
                        }
                        if (
                          workspace.organizationId !== input.selection.organizationId ||
                          workspace.projectId !== input.selection.projectId
                        ) {
                          throw new MarketingWorkspaceCrossOrganizationError({});
                        }
                        if (workspace.databaseKey !== databaseKey) {
                          throw new MarketingWorkspaceUnavailableError({
                            reason: "workspace_database_identity_mismatch",
                          });
                        }
                        if (
                          workspace.state === "provisioning" ||
                          workspace.state === "unavailable"
                        ) {
                          throw new MarketingWorkspaceConflictError({
                            reason: "workspace_requires_provisioning_rollback",
                          });
                        }
                        database
                          .prepare(
                            `UPDATE marketing_workspaces
                       SET state = 'deleting', updated_at = ?
                       WHERE id = ? AND state <> 'deleting'`,
                          )
                          .run(nowIso, input.selection.workspaceId);
                        database
                          .prepare(
                            `UPDATE marketing_organizations SET state = 'deleting'
                       WHERE id = ? AND state <> 'deleting'`,
                          )
                          .run(input.selection.organizationId);
                        return true;
                      }),
                    catch: (cause) => mapStoreCause("begin_workspace_deletion", cause),
                  }),
              );
              if (!changed) {
                yield* Deferred.await(gate.drain);
                yield* finishExclusiveDeletion(databaseKey);
                return false;
              }
              controlMarked = true;

              yield* Deferred.await(gate.drain);

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
                          `UPDATE marketing_organization_memberships
                     SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
                     WHERE organization_id = ?`,
                        )
                        .run(nowIso, input.selection.organizationId);
                      database
                        .prepare(
                          `UPDATE marketing_t3_reference_bindings
                     SET state = 'deleted', reference_kind = NULL, reference_value = NULL,
                         expires_at = NULL, deleted_at = COALESCE(deleted_at, ?)
                     WHERE organization_id = ?`,
                        )
                        .run(nowIso, input.selection.organizationId);
                      database
                        .prepare(
                          `UPDATE marketing_workspaces
                     SET state = 'deleted', updated_at = ?, deleted_at = ? WHERE id = ?`,
                        )
                        .run(nowIso, nowIso, input.selection.workspaceId);
                      database
                        .prepare(
                          `UPDATE marketing_projects SET state = 'deleted', deleted_at = ? WHERE id = ?`,
                        )
                        .run(nowIso, input.selection.projectId);
                      database
                        .prepare(
                          `UPDATE marketing_organizations SET state = 'deleted', deleted_at = ? WHERE id = ?`,
                        )
                        .run(nowIso, input.selection.organizationId);
                    }),
                  catch: (cause) => mapStoreCause("finish_workspace_deletion", cause),
                }),
              );
              yield* finishExclusiveDeletion(databaseKey);
              return true;
            });
            return yield* attempt.pipe(
              Effect.onExit(() =>
                controlMarked ? Effect.void : abortExclusiveDeletion(databaseKey),
              ),
            );
          }),
        );
      });

  const linkT3Reference: OrganizationWorkspaceStore<RequestAuthority>["linkT3Reference"] = (
    input,
  ) =>
    resolveWithPermission(
      { requestAuthority: input.requestAuthority, selection: input.selection },
      {
        permission: "link-t3-reference",
        selection: input.selection,
        bindingId: input.bindingId,
      },
      () =>
        Effect.gen(function* () {
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
          const expiresAtIso =
            input.expiresAt === undefined ? null : DateTime.formatIso(input.expiresAt);
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
                      existingById.expiresAt !== expiresAtIso ||
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
                      expiresAtIso,
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
        }),
    );

  const markT3ReferenceStale: OrganizationWorkspaceStore<RequestAuthority>["markT3ReferenceStale"] =
    (input) =>
      resolveWithPermission(
        { requestAuthority: input.requestAuthority, selection: input.selection },
        {
          permission: "mark-t3-reference-stale",
          selection: input.selection,
          bindingId: input.bindingId,
        },
        () =>
          Effect.gen(function* () {
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
          }),
      );

  const deleteT3Reference: OrganizationWorkspaceStore<RequestAuthority>["deleteT3Reference"] = (
    input,
  ) =>
    resolveWithPermission(
      { requestAuthority: input.requestAuthority, selection: input.selection },
      {
        permission: "delete-t3-reference",
        selection: input.selection,
        bindingId: input.bindingId,
      },
      () =>
        Effect.gen(function* () {
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
        }),
    );

  return {
    initialize,
    bootstrap,
    backfill,
    join,
    resolve,
    revokeMembership,
    rollbackProvisioning,
    deleteOrganizationWorkspace,
    linkT3Reference,
    markT3ReferenceStale,
    deleteT3Reference,
  };
}
