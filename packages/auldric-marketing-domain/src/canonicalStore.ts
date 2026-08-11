// @effect-diagnostics nodeBuiltinImport:off - canonical records stay inside the already-resolved physical SQLite organization boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MarketingCanonicalContentOperation,
  type MarketingCanonicalDefinitionReference,
  MarketingCanonicalDefinitionReference as MarketingCanonicalDefinitionReferenceSchema,
  type MarketingCanonicalFactKey,
  MarketingCanonicalFactKey as MarketingCanonicalFactKeySchema,
  type MarketingCanonicalFactRecord,
  type MarketingCanonicalInventoryItem,
  type MarketingCanonicalJson,
  type MarketingCanonicalKey,
  MarketingCanonicalKey as MarketingCanonicalKeySchema,
  type MarketingCanonicalObjectIdentity,
  MarketingCanonicalObjectIdentity as MarketingCanonicalObjectIdentitySchema,
  type MarketingCanonicalProjectionFact,
  MarketingCanonicalProjectionFact as MarketingCanonicalProjectionFactSchema,
  type MarketingCanonicalProjectionReference,
  type MarketingCanonicalRecord,
  type MarketingCanonicalRevisionReference,
  MarketingCanonicalRevisionReference as MarketingCanonicalRevisionReferenceSchema,
  type MarketingCanonicalSchemaReference,
  MarketingCanonicalSchemaReference as MarketingCanonicalSchemaReferenceSchema,
  type MarketingCanonicalScope,
  MarketingCanonicalScope as MarketingCanonicalScopeSchema,
  MarketingCanonicalVersion as MarketingCanonicalVersionSchema,
  type MarketingCanonicalWorkflowContext,
  type MarketingCanonicalWritableObjectIdentity,
  MarketingCanonicalWritableObjectIdentity as MarketingCanonicalWritableObjectIdentitySchema,
  type MarketingDecisionRevisionReference,
  MarketingDecisionRevisionReference as MarketingDecisionRevisionReferenceSchema,
  type MarketingExpectedVersion,
  MarketingExpectedVersion as MarketingExpectedVersionSchema,
  MarketingRegisteredRendererReference as MarketingRegisteredRendererReferenceSchema,
  type MarketingReviewRevisionReference,
  MarketingReviewRevisionReference as MarketingReviewRevisionReferenceSchema,
  type MarketingSavedOutputIdentity,
  MarketingSavedOutputIdentity as MarketingSavedOutputIdentitySchema,
  type MarketingSourceLineageReference,
  MarketingSourceLineageReference as MarketingSourceLineageReferenceSchema,
} from "./canonical.ts";
import {
  canonicalRevisionChildrenSha256,
  type CanonicalSealFact,
  type CanonicalSealReference,
  compareCanonicalText,
} from "./canonicalSeal.ts";
import { getCanonicalWorkspaceResolver } from "./canonicalWorkspaceAccess.ts";
import {
  MarketingCanonicalAuthorizationError,
  MarketingCanonicalConflictError,
  type MarketingCanonicalDomainError,
  MarketingCanonicalNotFoundError,
  MarketingCanonicalStoreError,
  MarketingCanonicalValidationError,
  isMarketingCanonicalDomainError,
} from "./canonicalErrors.ts";
import {
  MarketingCanonicalRevisionId,
  MarketingIdempotencyKey,
  MarketingActorId,
  type MarketingCanonicalRevisionId as MarketingCanonicalRevisionIdType,
  type MarketingIdempotencyKey as MarketingIdempotencyKeyType,
  type MarketingWorkspaceSelection,
} from "./identity.ts";
import {
  type OrganizationWorkspaceStore,
  type OrganizationWorkspaceStoreError,
} from "./workspaceStore.ts";

export interface MarketingCanonicalAuthorizationRequirement {
  readonly operation: MarketingCanonicalContentOperation;
  readonly selection: MarketingWorkspaceSelection;
  readonly resolvedMarketingActorId: MarketingActorId;
  readonly object?: MarketingCanonicalObjectIdentity;
  readonly canonicalKey?: MarketingCanonicalKey;
  readonly factKey?: MarketingCanonicalFactKey;
}

/**
 * Issue #19 supplies this registry. The content store never treats a caller-provided key as a
 * schema, workflow definition, or renderer merely because it is well formed.
 */
export interface MarketingCanonicalRegistryWriteContext {
  readonly object: MarketingCanonicalObjectIdentity;
  readonly canonicalKey: MarketingCanonicalKey;
  readonly schema: MarketingCanonicalSchemaReference;
  readonly definition?: MarketingCanonicalDefinitionReference;
  readonly scope: MarketingCanonicalScope;
  readonly sourceLineage: ReadonlyArray<MarketingSourceLineageReference>;
  readonly reviewReferences: ReadonlyArray<MarketingReviewRevisionReference>;
  readonly decisionReferences: ReadonlyArray<MarketingDecisionRevisionReference>;
  readonly projection?: MarketingCanonicalProjectionReference;
}

export interface MarketingCanonicalRegistryDefinitionContext extends MarketingCanonicalRegistryWriteContext {
  readonly definition: MarketingCanonicalDefinitionReference;
}

export interface MarketingCanonicalRegistryRendererContext extends MarketingCanonicalRegistryWriteContext {
  readonly object: MarketingSavedOutputIdentity;
  readonly projection: MarketingCanonicalProjectionReference;
  readonly source: MarketingCanonicalRecord;
  readonly payload: MarketingCanonicalJson;
  readonly facts: ReadonlyArray<MarketingCanonicalProjectionFact>;
}

export interface MarketingCanonicalRegistry {
  readonly validatePayload: (
    context: MarketingCanonicalRegistryWriteContext,
    payload: MarketingCanonicalJson,
  ) => Effect.Effect<MarketingCanonicalJson, MarketingCanonicalValidationError>;
  /** Facts are registry-derived after validation; write callers cannot submit them. */
  readonly projectFacts: (
    context: MarketingCanonicalRegistryWriteContext,
    payload: MarketingCanonicalJson,
  ) => Effect.Effect<
    ReadonlyArray<MarketingCanonicalProjectionFact>,
    MarketingCanonicalValidationError
  >;
  readonly validateDefinition: (
    context: MarketingCanonicalRegistryDefinitionContext,
  ) => Effect.Effect<void, MarketingCanonicalValidationError>;
  readonly validateRenderer: (
    context: MarketingCanonicalRegistryRendererContext,
  ) => Effect.Effect<void, MarketingCanonicalValidationError>;
}

export interface MarketingCanonicalStoreConfig<RequestAuthority> {
  readonly workspaceStore: OrganizationWorkspaceStore<RequestAuthority>;
  readonly registry: MarketingCanonicalRegistry;
  /** #6 composes its role policy here over the opaque request authority. */
  readonly authorize: (
    requestAuthority: RequestAuthority,
    requirement: MarketingCanonicalAuthorizationRequirement,
  ) => Effect.Effect<void, MarketingCanonicalAuthorizationError>;
}

interface CanonicalWriteFields<RequestAuthority> {
  readonly requestAuthority: RequestAuthority;
  readonly selection: MarketingWorkspaceSelection;
  readonly canonicalKey: MarketingCanonicalKey;
  readonly expectedVersion: MarketingExpectedVersion;
  readonly idempotencyKey: MarketingIdempotencyKeyType;
  readonly schema: MarketingCanonicalSchemaReference;
  readonly definition?: MarketingCanonicalDefinitionReference;
  readonly scope?: MarketingCanonicalScope;
  readonly payload: unknown;
  readonly sourceLineage?: ReadonlyArray<MarketingSourceLineageReference>;
  readonly reviewReferences?: ReadonlyArray<MarketingReviewRevisionReference>;
  readonly decisionReferences?: ReadonlyArray<MarketingDecisionRevisionReference>;
}

export interface WriteMarketingCanonicalObjectInput<
  RequestAuthority,
> extends CanonicalWriteFields<RequestAuthority> {
  readonly object: MarketingCanonicalWritableObjectIdentity;
}

export interface SaveMarketingRegisteredOutputInput<
  RequestAuthority,
> extends CanonicalWriteFields<RequestAuthority> {
  readonly object: MarketingSavedOutputIdentity;
  readonly projection: MarketingCanonicalProjectionReference;
}

export type MarketingCanonicalStoreErrorType =
  | OrganizationWorkspaceStoreError
  | MarketingCanonicalDomainError
  | MarketingCanonicalStoreError;

export interface MarketingCanonicalStore<RequestAuthority> {
  readonly listInventory: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
  }) => Effect.Effect<
    ReadonlyArray<MarketingCanonicalInventoryItem>,
    MarketingCanonicalStoreErrorType
  >;
  readonly read: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly object: MarketingCanonicalObjectIdentity;
  }) => Effect.Effect<MarketingCanonicalRecord, MarketingCanonicalStoreErrorType>;
  readonly findByCanonicalKey: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly canonicalKey: MarketingCanonicalKey;
  }) => Effect.Effect<MarketingCanonicalRecord | undefined, MarketingCanonicalStoreErrorType>;
  readonly readRevision: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly object: MarketingCanonicalObjectIdentity;
    readonly revision: MarketingCanonicalRevisionReference;
  }) => Effect.Effect<MarketingCanonicalRecord, MarketingCanonicalStoreErrorType>;
  readonly listRevisions: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly object: MarketingCanonicalObjectIdentity;
  }) => Effect.Effect<ReadonlyArray<MarketingCanonicalRecord>, MarketingCanonicalStoreErrorType>;
  readonly queryFacts: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly key?: MarketingCanonicalFactKey;
  }) => Effect.Effect<
    ReadonlyArray<MarketingCanonicalFactRecord>,
    MarketingCanonicalStoreErrorType
  >;
  readonly write: (
    input: WriteMarketingCanonicalObjectInput<RequestAuthority>,
  ) => Effect.Effect<MarketingCanonicalRecord, MarketingCanonicalStoreErrorType>;
  readonly saveRegisteredOutput: (
    input: SaveMarketingRegisteredOutputInput<RequestAuthority>,
  ) => Effect.Effect<MarketingCanonicalRecord, MarketingCanonicalStoreErrorType>;
}

interface CanonicalHeadRow {
  readonly objectId: string;
  readonly objectKind: MarketingCanonicalObjectIdentity["kind"];
  readonly organizationId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly canonicalKey: string;
  readonly currentVersion: number;
  readonly headRevisionId: string;
  readonly objectCreatedAt: string;
  readonly objectUpdatedAt: string;
}

interface CanonicalRevisionRow extends CanonicalHeadRow {
  readonly revisionId: string;
  readonly revisionObjectId: string;
  readonly revisionObjectKind: MarketingCanonicalObjectIdentity["kind"];
  readonly revisionVersion: number;
  readonly environmentId: string | null;
  readonly schemaKey: string;
  readonly schemaVersion: number;
  readonly definitionKey: string | null;
  readonly definitionVersion: number | null;
  readonly workflowInstanceId: string | null;
  readonly workflowRevisionId: string | null;
  readonly workflowRevisionVersion: number | null;
  readonly stageKey: string | null;
  readonly stepKey: string | null;
  readonly rendererKey: string | null;
  readonly rendererVersion: number | null;
  readonly projectionSourceObjectId: string | null;
  readonly projectionSourceRevisionId: string | null;
  readonly projectionSourceVersion: number | null;
  readonly payloadJson: string;
  readonly payloadSha256: string;
  readonly actorId: string;
  readonly revisionCreatedAt: string;
  readonly childrenSha256: string | null;
  readonly sealedAt: string | null;
}

interface CanonicalReferenceRow {
  readonly referenceKind: "source" | "review" | "decision";
  readonly ordinal: number;
  readonly targetObjectId: string;
  readonly targetRevisionId: string;
  readonly targetVersion: number;
  readonly targetObjectKind: MarketingCanonicalObjectIdentity["kind"];
}

interface CanonicalFactRow {
  readonly factKey: string;
  readonly valueJson: string;
  readonly valueSha256: string;
}

interface CanonicalFactQueryRow extends CanonicalFactRow {
  readonly objectId: string;
  readonly objectKind: MarketingCanonicalObjectIdentity["kind"];
  readonly revisionId: string;
  readonly revisionVersion: number;
  readonly childrenSha256: string | null;
  readonly sealedAt: string | null;
}

interface CanonicalIdempotencyRow {
  readonly operation: string;
  readonly payloadHash: string;
  readonly objectId: string;
  readonly revisionId: string;
  readonly resultVersion: number;
}

const decodeCanonicalObjectIdentity = Schema.decodeUnknownSync(
  MarketingCanonicalObjectIdentitySchema,
);
const decodeWritableObjectIdentity = Schema.decodeUnknownSync(
  MarketingCanonicalWritableObjectIdentitySchema,
);
const decodeSavedOutputIdentity = Schema.decodeUnknownSync(MarketingSavedOutputIdentitySchema);
const decodeCanonicalKey = Schema.decodeUnknownSync(MarketingCanonicalKeySchema);
const decodeFactKey = Schema.decodeUnknownSync(MarketingCanonicalFactKeySchema);
const decodeProjectionFacts = Schema.decodeUnknownSync(
  Schema.Array(MarketingCanonicalProjectionFactSchema),
);
const decodeProjectionFact = Schema.decodeUnknownSync(MarketingCanonicalProjectionFactSchema);
const decodeExpectedVersion = Schema.decodeUnknownSync(MarketingExpectedVersionSchema);
const decodeCanonicalVersion = Schema.decodeUnknownSync(MarketingCanonicalVersionSchema);
const decodeSchemaReference = Schema.decodeUnknownSync(MarketingCanonicalSchemaReferenceSchema);
const decodeDefinitionReference = Schema.decodeUnknownSync(
  MarketingCanonicalDefinitionReferenceSchema,
);
const decodeRendererReference = Schema.decodeUnknownSync(
  MarketingRegisteredRendererReferenceSchema,
);
const decodeCanonicalScope = Schema.decodeUnknownSync(MarketingCanonicalScopeSchema);
const decodeRevisionReference = Schema.decodeUnknownSync(MarketingCanonicalRevisionReferenceSchema);
const decodeSourceReferences = Schema.decodeUnknownSync(
  Schema.Array(MarketingSourceLineageReferenceSchema),
);
const decodeSourceReference = Schema.decodeUnknownSync(MarketingSourceLineageReferenceSchema);
const decodeReviewReferences = Schema.decodeUnknownSync(
  Schema.Array(MarketingReviewRevisionReferenceSchema),
);
const decodeReviewReference = Schema.decodeUnknownSync(MarketingReviewRevisionReferenceSchema);
const decodeDecisionReferences = Schema.decodeUnknownSync(
  Schema.Array(MarketingDecisionRevisionReferenceSchema),
);
const decodeDecisionReference = Schema.decodeUnknownSync(MarketingDecisionRevisionReferenceSchema);
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const decodeIdempotencyKey = Schema.decodeUnknownSync(MarketingIdempotencyKey);
const decodeRevisionId = Schema.decodeUnknownSync(MarketingCanonicalRevisionId);
const decodeActorId = Schema.decodeUnknownSync(MarketingActorId);

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function normalizeJson(value: MarketingCanonicalJson): MarketingCanonicalJson {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  );
}

function jsonText(value: MarketingCanonicalJson): string {
  return JSON.stringify(normalizeJson(value));
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
      // The original error is the authoritative failure.
    }
    throw cause;
  }
}

function mapCanonicalCause(operation: string, cause: unknown): MarketingCanonicalStoreErrorType {
  if (isMarketingCanonicalDomainError(cause)) return cause;
  return new MarketingCanonicalStoreError({ operation, cause });
}

function validationFailure(
  reason: MarketingCanonicalValidationError["reason"],
  reference?: string,
): MarketingCanonicalValidationError {
  return new MarketingCanonicalValidationError({
    reason,
    ...(reference === undefined ? {} : { reference }),
  });
}

function decodeInput<A>(
  operation: string,
  decode: () => A,
): Effect.Effect<A, MarketingCanonicalValidationError> {
  return Effect.try({
    try: decode,
    catch: () => validationFailure("invalid_canonical_input", operation),
  });
}

function referenceText(reference: { readonly key: string; readonly version: number }): string {
  return `${reference.key}@${reference.version}`;
}

function makeRevisionId(): MarketingCanonicalRevisionIdType {
  return MarketingCanonicalRevisionId.make(`mcrv_${NodeCrypto.randomUUID()}`);
}

function operationFor(
  object: MarketingCanonicalObjectIdentity,
  expectedVersion: MarketingExpectedVersion,
): MarketingCanonicalContentOperation {
  const create = expectedVersion === 0;
  switch (object.kind) {
    case "source":
      return create ? "create-source" : "edit-source";
    case "workflow-instance":
      return create ? "create-workflow-instance" : "edit-workflow-instance";
    case "plan":
      return create ? "create-plan" : "edit-plan";
    case "artifact":
      return create ? "create-artifact" : "save-artifact-revision";
    case "review":
      return create ? "create-review" : "record-review-revision";
    case "decision":
      return create ? "create-decision" : "record-decision-revision";
    case "next-action":
      return create ? "create-next-action" : "edit-next-action";
    case "saved-output":
      return create ? "save-registered-output" : "save-registered-output-revision";
  }
}

function headSelect(where: string): string {
  return `SELECT
    o.object_id AS objectId,
    o.object_kind AS objectKind,
    o.organization_id AS organizationId,
    o.project_id AS projectId,
    o.workspace_id AS workspaceId,
    o.canonical_key AS canonicalKey,
    o.current_version AS currentVersion,
    o.head_revision_id AS headRevisionId,
    o.created_at AS objectCreatedAt,
    o.updated_at AS objectUpdatedAt
  FROM auldric_canonical_objects o
  ${where}`;
}

function revisionSelect(where: string): string {
  return `SELECT
    o.object_id AS objectId,
    o.object_kind AS objectKind,
    o.organization_id AS organizationId,
    o.project_id AS projectId,
    o.workspace_id AS workspaceId,
    o.canonical_key AS canonicalKey,
    o.current_version AS currentVersion,
    o.head_revision_id AS headRevisionId,
    o.created_at AS objectCreatedAt,
    o.updated_at AS objectUpdatedAt,
    r.revision_id AS revisionId,
    r.object_id AS revisionObjectId,
    r.object_kind AS revisionObjectKind,
    r.version AS revisionVersion,
    r.environment_id AS environmentId,
    r.schema_key AS schemaKey,
    r.schema_version AS schemaVersion,
    r.definition_key AS definitionKey,
    r.definition_version AS definitionVersion,
    r.workflow_instance_id AS workflowInstanceId,
    r.workflow_revision_id AS workflowRevisionId,
    r.workflow_revision_version AS workflowRevisionVersion,
    r.stage_key AS stageKey,
    r.step_key AS stepKey,
    r.renderer_key AS rendererKey,
    r.renderer_version AS rendererVersion,
    r.projection_source_object_id AS projectionSourceObjectId,
    r.projection_source_revision_id AS projectionSourceRevisionId,
    r.projection_source_version AS projectionSourceVersion,
    r.payload_json AS payloadJson,
    r.payload_sha256 AS payloadSha256,
    r.actor_id AS actorId,
    r.created_at AS revisionCreatedAt,
    s.children_sha256 AS childrenSha256,
    s.sealed_at AS sealedAt
  FROM auldric_canonical_objects o
  JOIN auldric_canonical_revisions r ON r.object_id = o.object_id
  LEFT JOIN auldric_canonical_revision_seals s ON s.revision_id = r.revision_id
  ${where}`;
}

function assertSelection(row: CanonicalHeadRow, selection: MarketingWorkspaceSelection): void {
  if (
    row.organizationId !== selection.organizationId ||
    row.projectId !== selection.projectId ||
    row.workspaceId !== selection.workspaceId
  ) {
    throw new MarketingCanonicalNotFoundError({
      object: decodeCanonicalObjectIdentity({ kind: row.objectKind, id: row.objectId }),
    });
  }
}

function readHeadById(
  database: NodeSqlite.DatabaseSync,
  objectId: string,
): CanonicalHeadRow | undefined {
  return database.prepare(headSelect("WHERE o.object_id = ?")).get(objectId) as unknown as
    | CanonicalHeadRow
    | undefined;
}

function readHeadByClaim(
  database: NodeSqlite.DatabaseSync,
  workspaceId: string,
  canonicalKey: string,
): CanonicalHeadRow | undefined {
  return database
    .prepare(headSelect("WHERE o.workspace_id = ? AND o.canonical_key = ?"))
    .get(workspaceId, canonicalKey) as unknown as CanonicalHeadRow | undefined;
}

function readReferences(
  database: NodeSqlite.DatabaseSync,
  revisionId: string,
): ReadonlyArray<CanonicalReferenceRow> {
  return database
    .prepare(
      `SELECT rr.reference_kind AS referenceKind,
              rr.ordinal,
              rr.target_object_id AS targetObjectId,
              rr.target_revision_id AS targetRevisionId,
              rr.target_version AS targetVersion,
              target.object_kind AS targetObjectKind
       FROM auldric_canonical_revision_references rr
       JOIN auldric_canonical_objects target ON target.object_id = rr.target_object_id
       WHERE rr.revision_id = ?
       ORDER BY rr.reference_kind, rr.ordinal`,
    )
    .all(revisionId) as unknown as ReadonlyArray<CanonicalReferenceRow>;
}

function readSealReferences(
  database: NodeSqlite.DatabaseSync,
  revisionId: string,
): ReadonlyArray<CanonicalSealReference> {
  return database
    .prepare(
      `SELECT reference_kind AS referenceKind, ordinal,
              target_object_id AS targetObjectId,
              target_revision_id AS targetRevisionId,
              target_version AS targetVersion
       FROM auldric_canonical_revision_references
       WHERE revision_id = ?`,
    )
    .all(revisionId) as unknown as ReadonlyArray<CanonicalSealReference>;
}

function readSealFacts(
  database: NodeSqlite.DatabaseSync,
  revisionId: string,
): ReadonlyArray<CanonicalSealFact> {
  return database
    .prepare(
      `SELECT fact_key AS factKey, value_json AS valueJson, value_sha256 AS valueSha256
       FROM auldric_canonical_projection_facts
       WHERE revision_id = ?`,
    )
    .all(revisionId) as unknown as ReadonlyArray<CanonicalSealFact>;
}

function assertRevisionSeal(
  database: NodeSqlite.DatabaseSync,
  row: Pick<CanonicalRevisionRow, "revisionId" | "childrenSha256" | "sealedAt">,
): void {
  if (row.childrenSha256 === null || row.sealedAt === null) {
    throw validationFailure("invalid_stored_payload", row.revisionId);
  }
  if (
    canonicalRevisionChildrenSha256(
      readSealReferences(database, row.revisionId),
      readSealFacts(database, row.revisionId),
    ) !== row.childrenSha256
  ) {
    throw validationFailure("invalid_stored_payload", row.revisionId);
  }
}

function insertRevisionSeal(
  database: NodeSqlite.DatabaseSync,
  revisionId: string,
  sealedAt: string,
): void {
  const childrenSha256 = canonicalRevisionChildrenSha256(
    readSealReferences(database, revisionId),
    readSealFacts(database, revisionId),
  );
  database
    .prepare(
      `INSERT INTO auldric_canonical_revision_seals(
         revision_id, children_sha256, sealed_at
       ) VALUES (?, ?, ?)`,
    )
    .run(revisionId, childrenSha256, sealedAt);
}

function readFacts(
  database: NodeSqlite.DatabaseSync,
  revisionId: string,
): ReadonlyArray<MarketingCanonicalProjectionFact> {
  const rows = database
    .prepare(
      `SELECT fact_key AS factKey, value_json AS valueJson, value_sha256 AS valueSha256
       FROM auldric_canonical_projection_facts
       WHERE revision_id = ?
       ORDER BY fact_key`,
    )
    .all(revisionId) as unknown as ReadonlyArray<CanonicalFactRow>;
  return rows.map((row) => factFromRow(row, revisionId));
}

function factFromRow(row: CanonicalFactRow, revisionId: string): MarketingCanonicalProjectionFact {
  if (sha256(row.valueJson) !== row.valueSha256) {
    throw validationFailure("invalid_stored_payload", revisionId);
  }
  try {
    return decodeProjectionFact({ key: row.factKey, value: JSON.parse(row.valueJson) });
  } catch {
    throw validationFailure("invalid_stored_payload", revisionId);
  }
}

function parseStoredJson(row: CanonicalRevisionRow): MarketingCanonicalJson {
  if (sha256(row.payloadJson) !== row.payloadSha256) {
    throw validationFailure("invalid_stored_payload", row.revisionId);
  }
  try {
    return decodeJson(JSON.parse(row.payloadJson));
  } catch {
    throw validationFailure("invalid_stored_payload", row.revisionId);
  }
}

function scopeFromRow(row: CanonicalRevisionRow): MarketingCanonicalScope {
  if (
    (row.workflowInstanceId === null) !== (row.workflowRevisionId === null) ||
    (row.workflowInstanceId === null) !== (row.workflowRevisionVersion === null)
  ) {
    throw validationFailure("invalid_stored_payload", row.revisionId);
  }
  const workflow: MarketingCanonicalWorkflowContext | undefined =
    row.workflowInstanceId === null
      ? undefined
      : {
          workflowInstanceId:
            row.workflowInstanceId as MarketingCanonicalWorkflowContext["workflowInstanceId"],
          revision: decodeRevisionReference({
            revisionId: row.workflowRevisionId,
            version: row.workflowRevisionVersion,
          }),
          ...(row.stageKey === null
            ? {}
            : {
                stageKey: row.stageKey as NonNullable<
                  MarketingCanonicalWorkflowContext["stageKey"]
                >,
              }),
          ...(row.stepKey === null
            ? {}
            : {
                stepKey: row.stepKey as NonNullable<MarketingCanonicalWorkflowContext["stepKey"]>,
              }),
        };
  return decodeCanonicalScope({
    ...(row.environmentId === null ? {} : { environmentId: row.environmentId }),
    ...(workflow === undefined ? {} : { workflow }),
  });
}

function projectionFromRow(
  database: NodeSqlite.DatabaseSync,
  row: CanonicalRevisionRow,
): MarketingCanonicalProjectionReference | undefined {
  if (row.objectKind !== "saved-output") return undefined;
  if (
    row.projectionSourceObjectId === null ||
    row.projectionSourceRevisionId === null ||
    row.projectionSourceVersion === null ||
    row.rendererKey === null ||
    row.rendererVersion === null
  ) {
    throw validationFailure("invalid_stored_payload", row.revisionId);
  }
  const sourceHead = readHeadById(database, row.projectionSourceObjectId);
  if (sourceHead === undefined) {
    throw validationFailure("invalid_stored_payload", row.revisionId);
  }
  return {
    source: decodeCanonicalObjectIdentity({
      kind: sourceHead.objectKind,
      id: sourceHead.objectId,
    }),
    revision: decodeRevisionReference({
      revisionId: row.projectionSourceRevisionId,
      version: row.projectionSourceVersion,
    }),
    renderer: decodeRendererReference({
      key: row.rendererKey,
      version: row.rendererVersion,
    }),
  };
}

function inventoryFromRow(
  database: NodeSqlite.DatabaseSync,
  selection: MarketingWorkspaceSelection,
  row: CanonicalRevisionRow,
): MarketingCanonicalInventoryItem {
  assertRevisionSeal(database, row);
  assertSelection(row, selection);
  if (
    row.objectId !== row.revisionObjectId ||
    row.objectKind !== row.revisionObjectKind ||
    row.revisionVersion > row.currentVersion
  ) {
    throw validationFailure("invalid_stored_payload", row.revisionId);
  }
  const object = decodeCanonicalObjectIdentity({ kind: row.objectKind, id: row.objectId });
  const definition =
    row.definitionKey === null || row.definitionVersion === null
      ? undefined
      : decodeDefinitionReference({
          key: row.definitionKey,
          version: row.definitionVersion,
        });
  return {
    object,
    canonicalKey: decodeCanonicalKey(row.canonicalKey),
    version: decodeCanonicalVersion(row.revisionVersion),
    revisionId: decodeRevisionId(row.revisionId),
    schema: decodeSchemaReference({ key: row.schemaKey, version: row.schemaVersion }),
    ...(definition === undefined ? {} : { definition }),
    scope: scopeFromRow(row),
    actorId: decodeActorId(row.actorId),
    createdAt: DateTime.makeUnsafe(row.objectCreatedAt),
    updatedAt: DateTime.makeUnsafe(row.revisionCreatedAt),
  };
}

function recordFromRow(
  database: NodeSqlite.DatabaseSync,
  selection: MarketingWorkspaceSelection,
  row: CanonicalRevisionRow,
): MarketingCanonicalRecord {
  const inventory = inventoryFromRow(database, selection, row);
  const references = readReferences(database, row.revisionId);
  const sourceLineage = references
    .filter((reference) => reference.referenceKind === "source")
    .map((reference) => {
      if (reference.targetObjectKind !== "source") {
        throw validationFailure("invalid_stored_payload", row.revisionId);
      }
      return decodeSourceReference({
        sourceId: reference.targetObjectId,
        revision: {
          revisionId: reference.targetRevisionId,
          version: reference.targetVersion,
        },
      });
    });
  const reviewReferences = references
    .filter((reference) => reference.referenceKind === "review")
    .map((reference) => {
      if (reference.targetObjectKind !== "review") {
        throw validationFailure("invalid_stored_payload", row.revisionId);
      }
      return decodeReviewReference({
        reviewId: reference.targetObjectId,
        revision: {
          revisionId: reference.targetRevisionId,
          version: reference.targetVersion,
        },
      });
    });
  const decisionReferences = references
    .filter((reference) => reference.referenceKind === "decision")
    .map((reference) => {
      if (reference.targetObjectKind !== "decision") {
        throw validationFailure("invalid_stored_payload", row.revisionId);
      }
      return decodeDecisionReference({
        decisionId: reference.targetObjectId,
        revision: {
          revisionId: reference.targetRevisionId,
          version: reference.targetVersion,
        },
      });
    });
  const projection = projectionFromRow(database, row);
  return {
    ...inventory,
    payload: parseStoredJson(row),
    facts: readFacts(database, row.revisionId),
    sourceLineage,
    reviewReferences,
    decisionReferences,
    ...(projection === undefined ? {} : { projection }),
  };
}

function readRecordRevision(
  database: NodeSqlite.DatabaseSync,
  selection: MarketingWorkspaceSelection,
  objectId: string,
  revisionId: string,
  version: number,
): MarketingCanonicalRecord {
  const row = database
    .prepare(
      revisionSelect(
        `WHERE o.object_id = ?
           AND r.revision_id = ?
           AND r.version = ?`,
      ),
    )
    .get(objectId, revisionId, version) as unknown as CanonicalRevisionRow | undefined;
  if (row === undefined) {
    throw new MarketingCanonicalConflictError({ reason: "idempotency_result_stale" });
  }
  return recordFromRow(database, selection, row);
}

function readHeadRecord(
  database: NodeSqlite.DatabaseSync,
  selection: MarketingWorkspaceSelection,
  object: MarketingCanonicalObjectIdentity,
): MarketingCanonicalRecord {
  const row = database
    .prepare(
      revisionSelect(
        `WHERE o.object_id = ?
           AND o.object_kind = ?
           AND o.head_revision_id = r.revision_id
           AND o.current_version = r.version`,
      ),
    )
    .get(object.id, object.kind) as unknown as CanonicalRevisionRow | undefined;
  if (row === undefined) throw new MarketingCanonicalNotFoundError({ object });
  return recordFromRow(database, selection, row);
}

function insertReference(
  database: NodeSqlite.DatabaseSync,
  revisionId: MarketingCanonicalRevisionIdType,
  referenceKind: CanonicalReferenceRow["referenceKind"],
  ordinal: number,
  target: { readonly id: string; readonly revision: MarketingCanonicalRevisionReference },
): void {
  database
    .prepare(
      `INSERT INTO auldric_canonical_revision_references(
         revision_id, reference_kind, ordinal,
         target_object_id, target_revision_id, target_version
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revisionId,
      referenceKind,
      ordinal,
      target.id,
      target.revision.revisionId,
      target.revision.version,
    );
}

function assertRevisionTarget(
  database: NodeSqlite.DatabaseSync,
  selection: MarketingWorkspaceSelection,
  expectedKind: MarketingCanonicalObjectIdentity["kind"],
  target: { readonly id: string; readonly revision: MarketingCanonicalRevisionReference },
): void {
  const head = readHeadById(database, target.id);
  if (head === undefined) {
    throw new MarketingCanonicalConflictError({ reason: "referenced_object_missing" });
  }
  assertSelection(head, selection);
  if (head.objectKind !== expectedKind) {
    throw new MarketingCanonicalConflictError({ reason: "referenced_object_kind_mismatch" });
  }
  const revision = database
    .prepare(
      `SELECT 1 AS found FROM auldric_canonical_revisions
       WHERE object_id = ? AND revision_id = ? AND version = ?`,
    )
    .get(target.id, target.revision.revisionId, target.revision.version) as unknown as
    | { readonly found: 1 }
    | undefined;
  if (revision === undefined) {
    throw new MarketingCanonicalConflictError({ reason: "referenced_revision_missing" });
  }
  readRecordRevision(
    database,
    selection,
    target.id,
    target.revision.revisionId,
    target.revision.version,
  );
}

function assertReference(
  database: NodeSqlite.DatabaseSync,
  selection: MarketingWorkspaceSelection,
  expectedKind: "source" | "review" | "decision",
  target: { readonly id: string; readonly revision: MarketingCanonicalRevisionReference },
): void {
  assertRevisionTarget(database, selection, expectedKind, target);
}

function readProjectionSource(
  database: NodeSqlite.DatabaseSync,
  selection: MarketingWorkspaceSelection,
  projection: MarketingCanonicalProjectionReference,
): MarketingCanonicalRecord {
  const sourceHead = readHeadById(database, projection.source.id);
  if (sourceHead === undefined) {
    throw new MarketingCanonicalConflictError({
      reason: "referenced_object_missing",
      object: projection.source,
    });
  }
  assertSelection(sourceHead, selection);
  if (sourceHead.objectKind !== projection.source.kind) {
    throw new MarketingCanonicalConflictError({
      reason: "referenced_object_kind_mismatch",
      object: projection.source,
    });
  }
  const exactRevision = database
    .prepare(
      `SELECT 1 AS found FROM auldric_canonical_revisions
       WHERE object_id = ? AND revision_id = ? AND version = ?`,
    )
    .get(
      projection.source.id,
      projection.revision.revisionId,
      projection.revision.version,
    ) as unknown as { readonly found: 1 } | undefined;
  if (exactRevision === undefined) {
    throw new MarketingCanonicalConflictError({
      reason: "referenced_revision_missing",
      object: projection.source,
    });
  }
  return readRecordRevision(
    database,
    selection,
    projection.source.id,
    projection.revision.revisionId,
    projection.revision.version,
  );
}

function assertNoDuplicateReferences(
  references: ReadonlyArray<{ readonly revision: MarketingCanonicalRevisionReference }>,
): void {
  const ids = new Set(references.map((reference) => reference.revision.revisionId));
  if (ids.size !== references.length) {
    throw new MarketingCanonicalConflictError({ reason: "duplicate_revision_reference" });
  }
}

interface DecodedWrite {
  readonly object: MarketingCanonicalObjectIdentity;
  readonly canonicalKey: MarketingCanonicalKey;
  readonly expectedVersion: MarketingExpectedVersion;
  readonly idempotencyKey: MarketingIdempotencyKeyType;
  readonly schema: MarketingCanonicalSchemaReference;
  readonly definition?: MarketingCanonicalDefinitionReference;
  readonly scope: MarketingCanonicalScope;
  readonly payload: MarketingCanonicalJson;
  readonly facts: ReadonlyArray<MarketingCanonicalProjectionFact>;
  readonly sourceLineage: ReadonlyArray<MarketingSourceLineageReference>;
  readonly reviewReferences: ReadonlyArray<MarketingReviewRevisionReference>;
  readonly decisionReferences: ReadonlyArray<MarketingDecisionRevisionReference>;
  readonly projection?: MarketingCanonicalProjectionReference;
}

function encodeWriteHash(
  operation: MarketingCanonicalContentOperation,
  selection: MarketingWorkspaceSelection,
  actorId: MarketingActorId,
  input: DecodedWrite,
  payloadJson: string,
): string {
  return sha256(
    jsonText(
      decodeJson({
        operation,
        organizationId: selection.organizationId,
        projectId: selection.projectId,
        workspaceId: selection.workspaceId,
        actorId,
        object: input.object,
        canonicalKey: input.canonicalKey,
        expectedVersion: input.expectedVersion,
        schema: input.schema,
        definition: input.definition ?? null,
        scope: input.scope,
        sourceLineage: input.sourceLineage,
        reviewReferences: input.reviewReferences,
        decisionReferences: input.decisionReferences,
        facts: input.facts,
        projection: input.projection ?? null,
        payload: JSON.parse(payloadJson),
      }),
    ),
  );
}

export function makeMarketingCanonicalStore<RequestAuthority>(
  config: MarketingCanonicalStoreConfig<RequestAuthority>,
): MarketingCanonicalStore<RequestAuthority> {
  const resolveWorkspace = getCanonicalWorkspaceResolver<
    RequestAuthority,
    OrganizationWorkspaceStoreError
  >(config.workspaceStore);
  const authorize = (
    requestAuthority: RequestAuthority,
    requirement: MarketingCanonicalAuthorizationRequirement,
  ) => config.authorize(requestAuthority, requirement);

  const decodeWrite = Effect.fn("MarketingCanonicalStore.decodeWrite")(function* (
    input:
      | WriteMarketingCanonicalObjectInput<RequestAuthority>
      | SaveMarketingRegisteredOutputInput<RequestAuthority>,
    kind: "canonical" | "output",
  ) {
    const object = yield* decodeInput("object", () =>
      kind === "canonical"
        ? decodeWritableObjectIdentity(input.object)
        : decodeSavedOutputIdentity(input.object),
    );
    const canonicalKey = yield* decodeInput("canonical-key", () =>
      decodeCanonicalKey(input.canonicalKey),
    );
    const expectedVersion = yield* decodeInput("expected-version", () =>
      decodeExpectedVersion(input.expectedVersion),
    );
    const idempotencyKey = yield* decodeInput("idempotency-key", () =>
      decodeIdempotencyKey(input.idempotencyKey),
    );
    const schema = yield* decodeInput("schema-reference", () =>
      decodeSchemaReference(input.schema),
    );
    const definition =
      input.definition === undefined
        ? undefined
        : yield* decodeInput("definition-reference", () =>
            decodeDefinitionReference(input.definition),
          );
    const scope = yield* decodeInput("scope", () => decodeCanonicalScope(input.scope ?? {}));
    const sourceLineage = yield* decodeInput("source-lineage", () =>
      decodeSourceReferences(input.sourceLineage ?? []),
    );
    const reviewReferences = yield* decodeInput("review-references", () =>
      decodeReviewReferences(input.reviewReferences ?? []),
    );
    const decisionReferences = yield* decodeInput("decision-references", () =>
      decodeDecisionReferences(input.decisionReferences ?? []),
    );
    if (object.kind === "workflow-instance" && definition === undefined) {
      return yield* new MarketingCanonicalConflictError({
        reason: "workflow_definition_required",
        object,
      });
    }

    let projection: MarketingCanonicalProjectionReference | undefined;
    if (kind === "output") {
      const rawProjection = (input as SaveMarketingRegisteredOutputInput<RequestAuthority>)
        .projection;
      const source = yield* decodeInput("projection-source", () =>
        decodeCanonicalObjectIdentity(rawProjection.source),
      );
      const revision = yield* decodeInput("projection-revision", () =>
        decodeRevisionReference(rawProjection.revision),
      );
      const renderer = yield* decodeInput("renderer-reference", () =>
        decodeRendererReference(rawProjection.renderer),
      );
      if (source.kind === "saved-output") {
        return yield* new MarketingCanonicalConflictError({
          reason: "projection_source_cannot_be_saved_output",
          object: source,
        });
      }
      projection = { source, revision, renderer };
    }
    const registryContext: MarketingCanonicalRegistryWriteContext = {
      object,
      canonicalKey,
      schema,
      ...(definition === undefined ? {} : { definition }),
      scope,
      sourceLineage,
      reviewReferences,
      decisionReferences,
      ...(projection === undefined ? {} : { projection }),
    };
    const jsonPayload = yield* Effect.try({
      try: () => decodeJson(input.payload),
      catch: () => validationFailure("payload_not_json", referenceText(schema)),
    });
    const payload = yield* config.registry.validatePayload(registryContext, jsonPayload).pipe(
      Effect.flatMap((validated) =>
        Effect.try({
          try: () => decodeJson(validated),
          catch: () => validationFailure("payload_schema_invalid", referenceText(schema)),
        }),
      ),
    );
    const facts = yield* config.registry.projectFacts(registryContext, payload).pipe(
      Effect.flatMap((projected) =>
        Effect.try({
          try: () =>
            [...decodeProjectionFacts(projected)].sort((left, right) =>
              compareCanonicalText(left.key, right.key),
            ),
          catch: () => validationFailure("projection_fact_invalid", referenceText(schema)),
        }),
      ),
    );
    if (new Set(facts.map((fact) => fact.key)).size !== facts.length) {
      return yield* new MarketingCanonicalConflictError({
        reason: "duplicate_projection_fact",
        object,
      });
    }
    if (definition !== undefined) {
      yield* config.registry.validateDefinition({ ...registryContext, definition });
    }
    return {
      object,
      canonicalKey,
      expectedVersion,
      idempotencyKey,
      schema,
      ...(definition === undefined ? {} : { definition }),
      scope,
      payload,
      facts,
      sourceLineage,
      reviewReferences,
      decisionReferences,
      ...(projection === undefined ? {} : { projection }),
    } satisfies DecodedWrite;
  });

  const writeInput = Effect.fn("MarketingCanonicalStore.writeInput")(function* (
    rawInput:
      | WriteMarketingCanonicalObjectInput<RequestAuthority>
      | SaveMarketingRegisteredOutputInput<RequestAuthority>,
    kind: "canonical" | "output",
  ): Effect.fn.Return<MarketingCanonicalRecord, MarketingCanonicalStoreErrorType> {
    const { requestAuthority, selection } = rawInput;
    return yield* resolveWorkspace(
      { requestAuthority, selection },
      ({ database, marketingActorId }) =>
        Effect.gen(function* () {
          const object = yield* decodeInput("object", () =>
            kind === "canonical"
              ? decodeWritableObjectIdentity(rawInput.object)
              : decodeSavedOutputIdentity(rawInput.object),
          );
          const canonicalKey = yield* decodeInput("canonical-key", () =>
            decodeCanonicalKey(rawInput.canonicalKey),
          );
          const expectedVersion = yield* decodeInput("expected-version", () =>
            decodeExpectedVersion(rawInput.expectedVersion),
          );
          const operation = operationFor(object, expectedVersion);
          yield* authorize(requestAuthority, {
            operation,
            selection,
            resolvedMarketingActorId: marketingActorId,
            object,
            canonicalKey,
          });
          const input = yield* decodeWrite(rawInput, kind);
          const projection = input.projection;
          if (projection !== undefined) {
            if (input.object.kind !== "saved-output") {
              return yield* new MarketingCanonicalConflictError({
                reason: "projection_target_must_be_saved_output",
                object: input.object,
              });
            }
            const source = yield* Effect.try({
              try: () => readProjectionSource(database, selection, projection),
              catch: (cause) => mapCanonicalCause("read_projection_source", cause),
            });
            yield* config.registry.validateRenderer({
              object: input.object,
              canonicalKey: input.canonicalKey,
              schema: input.schema,
              ...(input.definition === undefined ? {} : { definition: input.definition }),
              scope: input.scope,
              sourceLineage: input.sourceLineage,
              reviewReferences: input.reviewReferences,
              decisionReferences: input.decisionReferences,
              projection,
              source,
              payload: input.payload,
              facts: input.facts,
            });
          }
          const payloadJson = jsonText(input.payload);
          const payloadHash = encodeWriteHash(
            operation,
            selection,
            marketingActorId,
            input,
            payloadJson,
          );
          const nowIso = DateTime.formatIso(yield* DateTime.now);

          return yield* Effect.try({
            try: () =>
              runTransaction(database, () => {
                const idempotency = database
                  .prepare(
                    `SELECT operation, payload_hash AS payloadHash,
                            object_id AS objectId, revision_id AS revisionId,
                            result_version AS resultVersion
                     FROM auldric_canonical_idempotency WHERE idempotency_key = ?`,
                  )
                  .get(input.idempotencyKey) as unknown as CanonicalIdempotencyRow | undefined;
                if (idempotency !== undefined) {
                  if (
                    idempotency.operation !== operation ||
                    idempotency.payloadHash !== payloadHash
                  ) {
                    throw new MarketingCanonicalConflictError({
                      reason: "idempotency_key_reused",
                      object: input.object,
                    });
                  }
                  return readRecordRevision(
                    database,
                    selection,
                    idempotency.objectId,
                    idempotency.revisionId,
                    idempotency.resultVersion,
                  );
                }

                const existing = readHeadById(database, input.object.id);
                const claim = readHeadByClaim(database, selection.workspaceId, input.canonicalKey);
                if (claim !== undefined && claim.objectId !== input.object.id) {
                  throw new MarketingCanonicalConflictError({
                    reason: "duplicate_canonical_claim",
                    object: input.object,
                    expectedVersion: input.expectedVersion,
                    actualVersion: decodeCanonicalVersion(claim.currentVersion),
                  });
                }
                if (existing !== undefined) {
                  assertSelection(existing, selection);
                  if (
                    existing.objectKind !== input.object.kind ||
                    existing.canonicalKey !== input.canonicalKey
                  ) {
                    throw new MarketingCanonicalConflictError({
                      reason: "canonical_identity_conflict",
                      object: input.object,
                    });
                  }
                  if (existing.currentVersion !== input.expectedVersion) {
                    throw new MarketingCanonicalConflictError({
                      reason: "stale_version",
                      object: input.object,
                      expectedVersion: input.expectedVersion,
                      actualVersion: decodeCanonicalVersion(existing.currentVersion),
                    });
                  }
                } else if (input.expectedVersion !== 0) {
                  throw new MarketingCanonicalConflictError({
                    reason: "stale_version",
                    object: input.object,
                    expectedVersion: input.expectedVersion,
                  });
                }

                assertNoDuplicateReferences(input.sourceLineage);
                assertNoDuplicateReferences(input.reviewReferences);
                assertNoDuplicateReferences(input.decisionReferences);
                if (input.scope.workflow !== undefined) {
                  assertRevisionTarget(database, selection, "workflow-instance", {
                    id: input.scope.workflow.workflowInstanceId,
                    revision: input.scope.workflow.revision,
                  });
                }
                for (const reference of input.sourceLineage) {
                  assertReference(database, selection, "source", {
                    id: reference.sourceId,
                    revision: reference.revision,
                  });
                }
                for (const reference of input.reviewReferences) {
                  assertReference(database, selection, "review", {
                    id: reference.reviewId,
                    revision: reference.revision,
                  });
                }
                for (const reference of input.decisionReferences) {
                  assertReference(database, selection, "decision", {
                    id: reference.decisionId,
                    revision: reference.revision,
                  });
                }

                if (input.projection !== undefined) {
                  readProjectionSource(database, selection, input.projection);
                }

                const version = decodeCanonicalVersion((existing?.currentVersion ?? 0) + 1);
                const revisionId = makeRevisionId();
                if (existing === undefined) {
                  database
                    .prepare(
                      `INSERT INTO auldric_canonical_objects(
                         object_id, object_kind, organization_id, project_id, workspace_id,
                         canonical_key, current_version, head_revision_id, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                      input.object.id,
                      input.object.kind,
                      selection.organizationId,
                      selection.projectId,
                      selection.workspaceId,
                      input.canonicalKey,
                      version,
                      revisionId,
                      nowIso,
                      nowIso,
                    );
                }

                database
                  .prepare(
                    `INSERT INTO auldric_canonical_revisions(
                       revision_id, object_id, object_kind, version, environment_id,
                       schema_key, schema_version, definition_key, definition_version,
                       workflow_instance_id, workflow_revision_id,
                       workflow_revision_version, stage_key, step_key,
                       renderer_key, renderer_version,
                       projection_source_object_id, projection_source_revision_id,
                       projection_source_version, payload_json, payload_sha256,
                       actor_id, idempotency_key, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    revisionId,
                    input.object.id,
                    input.object.kind,
                    version,
                    input.scope.environmentId ?? null,
                    input.schema.key,
                    input.schema.version,
                    input.definition?.key ?? null,
                    input.definition?.version ?? null,
                    input.scope.workflow?.workflowInstanceId ?? null,
                    input.scope.workflow?.revision.revisionId ?? null,
                    input.scope.workflow?.revision.version ?? null,
                    input.scope.workflow?.stageKey ?? null,
                    input.scope.workflow?.stepKey ?? null,
                    input.projection?.renderer.key ?? null,
                    input.projection?.renderer.version ?? null,
                    input.projection?.source.id ?? null,
                    input.projection?.revision.revisionId ?? null,
                    input.projection?.revision.version ?? null,
                    payloadJson,
                    sha256(payloadJson),
                    marketingActorId,
                    input.idempotencyKey,
                    nowIso,
                  );

                if (existing !== undefined) {
                  const updated = database
                    .prepare(
                      `UPDATE auldric_canonical_objects
                       SET current_version = ?, head_revision_id = ?, updated_at = ?
                       WHERE object_id = ? AND current_version = ?`,
                    )
                    .run(version, revisionId, nowIso, input.object.id, input.expectedVersion);
                  if (updated.changes !== 1) {
                    throw new MarketingCanonicalConflictError({
                      reason: "stale_version",
                      object: input.object,
                      expectedVersion: input.expectedVersion,
                    });
                  }
                }

                input.sourceLineage.forEach((reference, ordinal) =>
                  insertReference(database, revisionId, "source", ordinal, {
                    id: reference.sourceId,
                    revision: reference.revision,
                  }),
                );
                input.reviewReferences.forEach((reference, ordinal) =>
                  insertReference(database, revisionId, "review", ordinal, {
                    id: reference.reviewId,
                    revision: reference.revision,
                  }),
                );
                input.decisionReferences.forEach((reference, ordinal) =>
                  insertReference(database, revisionId, "decision", ordinal, {
                    id: reference.decisionId,
                    revision: reference.revision,
                  }),
                );
                for (const fact of input.facts) {
                  const valueJson = jsonText(fact.value);
                  database
                    .prepare(
                      `INSERT INTO auldric_canonical_projection_facts(
                         revision_id, fact_key, value_json, value_sha256
                       ) VALUES (?, ?, ?, ?)`,
                    )
                    .run(revisionId, fact.key, valueJson, sha256(valueJson));
                }
                insertRevisionSeal(database, revisionId, nowIso);

                database
                  .prepare(
                    `INSERT INTO auldric_canonical_idempotency(
                       idempotency_key, operation, payload_hash,
                       object_id, revision_id, result_version, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    input.idempotencyKey,
                    operation,
                    payloadHash,
                    input.object.id,
                    revisionId,
                    version,
                    nowIso,
                  );

                return readRecordRevision(
                  database,
                  selection,
                  input.object.id,
                  revisionId,
                  version,
                );
              }),
            catch: (cause) => mapCanonicalCause("write", cause),
          });
        }),
    );
  });

  const listInventory: MarketingCanonicalStore<RequestAuthority>["listInventory"] = (input) =>
    resolveWorkspace(input, ({ database, marketingActorId }) =>
      Effect.gen(function* () {
        yield* authorize(input.requestAuthority, {
          operation: "list-canonical-inventory",
          selection: input.selection,
          resolvedMarketingActorId: marketingActorId,
        });
        return yield* Effect.try({
          try: () => {
            const rows = database
              .prepare(
                revisionSelect(
                  `WHERE o.organization_id = ?
                     AND o.project_id = ?
                     AND o.workspace_id = ?
                     AND o.head_revision_id = r.revision_id
                     AND o.current_version = r.version
                   ORDER BY o.object_kind, o.canonical_key, o.object_id`,
                ),
              )
              .all(
                input.selection.organizationId,
                input.selection.projectId,
                input.selection.workspaceId,
              ) as unknown as ReadonlyArray<CanonicalRevisionRow>;
            return rows.map((row) => inventoryFromRow(database, input.selection, row));
          },
          catch: (cause) => mapCanonicalCause("list_inventory", cause),
        });
      }),
    );

  const read: MarketingCanonicalStore<RequestAuthority>["read"] = (input) =>
    Effect.gen(function* () {
      const object = yield* decodeInput("object", () =>
        decodeCanonicalObjectIdentity(input.object),
      );
      return yield* resolveWorkspace(input, ({ database, marketingActorId }) =>
        Effect.gen(function* () {
          yield* authorize(input.requestAuthority, {
            operation: "read-canonical-object",
            selection: input.selection,
            resolvedMarketingActorId: marketingActorId,
            object,
          });
          return yield* Effect.try({
            try: () => readHeadRecord(database, input.selection, object),
            catch: (cause) => mapCanonicalCause("read", cause),
          });
        }),
      );
    });

  const findByCanonicalKey: MarketingCanonicalStore<RequestAuthority>["findByCanonicalKey"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const canonicalKey = yield* decodeInput("canonical-key", () =>
        decodeCanonicalKey(input.canonicalKey),
      );
      return yield* resolveWorkspace(input, ({ database, marketingActorId }) =>
        Effect.gen(function* () {
          yield* authorize(input.requestAuthority, {
            operation: "read-canonical-object",
            selection: input.selection,
            resolvedMarketingActorId: marketingActorId,
            canonicalKey,
          });
          return yield* Effect.try({
            try: () => {
              const head = readHeadByClaim(database, input.selection.workspaceId, canonicalKey);
              if (head === undefined) return undefined;
              assertSelection(head, input.selection);
              return readHeadRecord(
                database,
                input.selection,
                decodeCanonicalObjectIdentity({ kind: head.objectKind, id: head.objectId }),
              );
            },
            catch: (cause) => mapCanonicalCause("find_by_canonical_key", cause),
          });
        }),
      );
    });

  const readRevision: MarketingCanonicalStore<RequestAuthority>["readRevision"] = (input) =>
    Effect.gen(function* () {
      const object = yield* decodeInput("object", () =>
        decodeCanonicalObjectIdentity(input.object),
      );
      const revision = yield* decodeInput("revision", () =>
        decodeRevisionReference(input.revision),
      );
      return yield* resolveWorkspace(input, ({ database, marketingActorId }) =>
        Effect.gen(function* () {
          yield* authorize(input.requestAuthority, {
            operation: "read-canonical-object",
            selection: input.selection,
            resolvedMarketingActorId: marketingActorId,
            object,
          });
          return yield* Effect.try({
            try: () =>
              readRecordRevision(
                database,
                input.selection,
                object.id,
                revision.revisionId,
                revision.version,
              ),
            catch: (cause) => mapCanonicalCause("read_revision", cause),
          });
        }),
      );
    });

  const listRevisions: MarketingCanonicalStore<RequestAuthority>["listRevisions"] = (input) =>
    Effect.gen(function* () {
      const object = yield* decodeInput("object", () =>
        decodeCanonicalObjectIdentity(input.object),
      );
      return yield* resolveWorkspace(input, ({ database, marketingActorId }) =>
        Effect.gen(function* () {
          yield* authorize(input.requestAuthority, {
            operation: "list-canonical-revisions",
            selection: input.selection,
            resolvedMarketingActorId: marketingActorId,
            object,
          });
          return yield* Effect.try({
            try: () => {
              const head = readHeadById(database, object.id);
              if (head === undefined || head.objectKind !== object.kind) {
                throw new MarketingCanonicalNotFoundError({ object });
              }
              assertSelection(head, input.selection);
              const rows = database
                .prepare(
                  revisionSelect(
                    `WHERE o.object_id = ? AND o.object_kind = ?
                     ORDER BY r.version`,
                  ),
                )
                .all(object.id, object.kind) as unknown as ReadonlyArray<CanonicalRevisionRow>;
              return rows.map((row) => recordFromRow(database, input.selection, row));
            },
            catch: (cause) => mapCanonicalCause("list_revisions", cause),
          });
        }),
      );
    });

  const queryFacts: MarketingCanonicalStore<RequestAuthority>["queryFacts"] = (input) =>
    resolveWorkspace(input, ({ database, marketingActorId }) =>
      Effect.gen(function* () {
        const key =
          input.key === undefined
            ? undefined
            : yield* decodeInput("fact-key", () => decodeFactKey(input.key));
        yield* authorize(input.requestAuthority, {
          operation: "query-canonical-facts",
          selection: input.selection,
          resolvedMarketingActorId: marketingActorId,
          ...(key === undefined ? {} : { factKey: key }),
        });
        return yield* Effect.try({
          try: () => {
            const sql = `SELECT
                o.object_id AS objectId,
                o.object_kind AS objectKind,
                r.revision_id AS revisionId,
                r.version AS revisionVersion,
                s.children_sha256 AS childrenSha256,
                s.sealed_at AS sealedAt,
                f.fact_key AS factKey,
                f.value_json AS valueJson,
                f.value_sha256 AS valueSha256
              FROM auldric_canonical_projection_facts f
              JOIN auldric_canonical_revisions r ON r.revision_id = f.revision_id
              LEFT JOIN auldric_canonical_revision_seals s ON s.revision_id = r.revision_id
              JOIN auldric_canonical_objects o ON o.object_id = r.object_id
              WHERE o.organization_id = ?
                AND o.project_id = ?
                AND o.workspace_id = ?
                AND o.head_revision_id = r.revision_id
                AND o.current_version = r.version
                ${key === undefined ? "" : "AND f.fact_key = ?"}
              ORDER BY f.fact_key, o.object_kind, o.canonical_key, o.object_id`;
            const rows = database
              .prepare(sql)
              .all(
                input.selection.organizationId,
                input.selection.projectId,
                input.selection.workspaceId,
                ...(key === undefined ? [] : [key]),
              ) as unknown as ReadonlyArray<CanonicalFactQueryRow>;
            const verifiedRevisions = new Set<string>();
            for (const row of rows) {
              if (!verifiedRevisions.has(row.revisionId)) {
                assertRevisionSeal(database, row);
                verifiedRevisions.add(row.revisionId);
              }
            }
            return rows.map((row) => ({
              object: decodeCanonicalObjectIdentity({
                kind: row.objectKind,
                id: row.objectId,
              }),
              revisionId: decodeRevisionId(row.revisionId),
              version: decodeCanonicalVersion(row.revisionVersion),
              fact: factFromRow(row, row.revisionId),
            }));
          },
          catch: (cause) => mapCanonicalCause("query_facts", cause),
        });
      }),
    );

  const write: MarketingCanonicalStore<RequestAuthority>["write"] = (input) =>
    writeInput(input, "canonical");

  const saveRegisteredOutput: MarketingCanonicalStore<RequestAuthority>["saveRegisteredOutput"] = (
    input,
  ) => writeInput(input, "output");

  return {
    listInventory,
    read,
    findByCanonicalKey,
    readRevision,
    listRevisions,
    queryFacts,
    write,
    saveRegisteredOutput,
  };
}
