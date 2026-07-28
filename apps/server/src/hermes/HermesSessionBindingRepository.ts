import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const HermesProtocolClassification = Schema.Literals(["legacy", "supported", "unsupported"]);
export type HermesProtocolClassification = typeof HermesProtocolClassification.Type;

export const HermesMutationIntentState = Schema.Literals([
  "prepared",
  "admitted",
  "confirmed",
  "indeterminate",
  "reconciled",
  "rejected",
]);
export type HermesMutationIntentState = typeof HermesMutationIntentState.Type;

export const HermesSessionBinding = Schema.Struct({
  bindingId: Schema.String,
  providerInstanceId: Schema.String,
  profileKey: Schema.String,
  projectId: Schema.String,
  storedSessionKey: Schema.String,
  threadId: Schema.String,
  protocolClassification: HermesProtocolClassification,
  protocolMajor: Schema.NullOr(Schema.Number),
  protocolMinor: Schema.NullOr(Schema.Number),
  capabilities: Schema.Array(Schema.String),
  reconciliationCursor: Schema.NullOr(Schema.String),
  reconciliationFingerprint: Schema.NullOr(Schema.String),
  titleRevision: Schema.Number,
  titleOrigin: Schema.NullOr(Schema.String),
  parentBindingId: Schema.NullOr(Schema.String),
  branchBoundaryMode: Schema.NullOr(Schema.Literal("latest_only")),
  branchBoundaryMessageId: Schema.NullOr(Schema.String),
  branchBoundaryMessageCount: Schema.NullOr(Schema.Number),
  leaseOwnerKey: Schema.NullOr(Schema.String),
  leaseGeneration: Schema.Number,
  leaseExpiresAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type HermesSessionBinding = typeof HermesSessionBinding.Type;

export const HermesMutationIntent = Schema.Struct({
  operationId: Schema.String,
  bindingId: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.String,
  profileKey: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  attemptId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
  mutationKind: Schema.String,
  method: Schema.String,
  payloadDigest: Schema.String,
  ownerGeneration: Schema.Number,
  state: HermesMutationIntentState,
  preparedAt: Schema.String,
  admittedAt: Schema.NullOr(Schema.String),
  settledAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type HermesMutationIntent = typeof HermesMutationIntent.Type;

export const HermesSessionImport = Schema.Struct({
  importId: Schema.String,
  providerInstanceId: Schema.String,
  profileKey: Schema.String,
  projectId: Schema.String,
  importKind: Schema.Literals(["session", "main"]),
  storedSessionKey: Schema.NullOr(Schema.String),
  threadId: Schema.String,
  state: Schema.Literals(["prepared", "thread_created", "completed"]),
  inheritedMessageCount: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type HermesSessionImport = typeof HermesSessionImport.Type;

export interface PrepareHermesSessionImportInput {
  readonly importId: string;
  readonly providerInstanceId: string;
  readonly profileKey: string;
  readonly projectId: string;
  readonly importKind: "session" | "main";
  readonly storedSessionKey: string | null;
  readonly threadId: string;
  readonly now: string;
}

export interface CreateHermesSessionBindingInput {
  readonly bindingId: string;
  readonly providerInstanceId: string;
  readonly profileKey: string;
  readonly projectId: string;
  readonly storedSessionKey: string;
  readonly threadId: string;
  readonly protocolClassification: HermesProtocolClassification;
  readonly protocolMajor: number | null;
  readonly protocolMinor: number | null;
  readonly capabilities: ReadonlyArray<string>;
  readonly reconciliationCursor: string | null;
  readonly reconciliationFingerprint: string | null;
  readonly titleRevision?: number;
  readonly titleOrigin?: string | null;
  readonly parentBindingId?: string | null;
  readonly branchBoundaryMode?: "latest_only" | null;
  readonly branchBoundaryMessageId?: string | null;
  readonly branchBoundaryMessageCount?: number | null;
  readonly now: string;
  /**
   * When supplied, binding creation and confirmation/attachment of this
   * pre-binding `session_create` intent commit in one transaction.
   */
  readonly createOperationId?: string;
}

export interface HermesBindingStoredIdentity {
  readonly providerInstanceId: string;
  readonly profileKey: string;
  readonly storedSessionKey: string;
}

export interface HermesHistoryScope {
  readonly providerInstanceId: string;
  readonly profileKey: string;
  readonly projectId: string;
}

export interface HermesLeaseFence {
  readonly bindingId: string;
  readonly ownerKey: string;
  readonly generation: number;
  /**
   * Canonical UTC ISO timestamp used both for expiry comparison and auditing.
   */
  readonly now: string;
}

export interface HermesOwnerLease {
  readonly bindingId: string;
  readonly ownerKey: string;
  readonly generation: number;
  readonly expiresAt: string;
}

export interface AcquireHermesOwnerLeaseInput {
  readonly bindingId: string;
  readonly ownerKey: string;
  readonly expectedGeneration: number;
  readonly now: string;
  readonly expiresAt: string;
}

export interface UpdateHermesNegotiationInput extends HermesLeaseFence {
  readonly protocolClassification: HermesProtocolClassification;
  readonly protocolMajor: number | null;
  readonly protocolMinor: number | null;
  readonly capabilities: ReadonlyArray<string>;
}

export interface UpdateHermesReconciliationInput extends HermesLeaseFence {
  readonly cursor: string | null;
  readonly fingerprint: string | null;
}

export interface UpdateHermesTitleStateInput extends HermesLeaseFence {
  readonly revision: number;
  readonly origin: string;
}

export interface PrepareHermesMutationIntentInput extends HermesLeaseFence {
  readonly operationId: string;
  readonly mutationKind: string;
  readonly method: string;
  /**
   * Digest of the external write payload. Raw payloads, prompts, transcripts,
   * credentials, and gateway session ids must never be passed to this service.
   */
  readonly payloadDigest: string;
}

export interface PrepareHermesSessionCreateIntentInput {
  readonly operationId: string;
  readonly providerInstanceId: string;
  readonly profileKey: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly runId?: string | null;
  readonly attemptId?: string | null;
  readonly messageId?: string | null;
  readonly method: string;
  readonly payloadDigest: string;
  readonly now: string;
}

export type PrepareHermesMutationIntentResult =
  | {
      readonly status: "prepared";
      readonly intent: HermesMutationIntent;
    }
  | {
      readonly status: "lease_not_held";
    }
  | {
      readonly status: "operation_exists";
      readonly intent: HermesMutationIntent;
    }
  | {
      readonly status: "unsettled_prompt";
      readonly operationId: string;
    };

export type PrepareHermesSessionCreateIntentResult =
  | {
      readonly status: "prepared";
      readonly intent: HermesMutationIntent;
    }
  | {
      readonly status: "operation_exists";
      readonly intent: HermesMutationIntent;
    }
  | {
      readonly status: "unsettled_create";
      readonly operationId: string;
    };

export interface TransitionHermesMutationIntentInput extends HermesLeaseFence {
  readonly operationId: string;
  readonly from: HermesMutationIntentState;
  readonly to: HermesMutationIntentState;
}

export interface TransitionHermesSessionCreateIntentInput {
  readonly operationId: string;
  readonly from: "prepared" | "admitted";
  readonly to: "admitted" | "indeterminate" | "rejected";
  readonly now: string;
}

export class HermesSessionBindingRepositoryError extends Schema.TaggedErrorClass<HermesSessionBindingRepositoryError>()(
  "HermesSessionBindingRepositoryError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Hermes session binding repository failed in ${this.operation}: ${this.detail}`;
  }
}

export interface HermesSessionBindingRepositoryShape {
  readonly createBinding: (
    input: CreateHermesSessionBindingInput,
  ) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  readonly getByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<HermesSessionBinding>, HermesSessionBindingRepositoryError>;
  readonly getByStoredIdentity: (
    identity: HermesBindingStoredIdentity,
  ) => Effect.Effect<Option.Option<HermesSessionBinding>, HermesSessionBindingRepositoryError>;
  readonly updateNegotiation: (
    input: UpdateHermesNegotiationInput,
  ) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  readonly updateReconciliation: (
    input: UpdateHermesReconciliationInput,
  ) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  readonly updateTitleState: (
    input: UpdateHermesTitleStateInput,
  ) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  readonly acquireOwnerLease: (
    input: AcquireHermesOwnerLeaseInput,
  ) => Effect.Effect<Option.Option<HermesOwnerLease>, HermesSessionBindingRepositoryError>;
  readonly renewOwnerLease: (
    input: HermesLeaseFence & { readonly expiresAt: string },
  ) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  readonly releaseOwnerLease: (
    input: Omit<HermesLeaseFence, "now"> & { readonly now: string },
  ) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  readonly prepareMutationIntent: (
    input: PrepareHermesMutationIntentInput,
  ) => Effect.Effect<PrepareHermesMutationIntentResult, HermesSessionBindingRepositoryError>;
  readonly prepareSessionCreateIntent: (
    input: PrepareHermesSessionCreateIntentInput,
  ) => Effect.Effect<PrepareHermesSessionCreateIntentResult, HermesSessionBindingRepositoryError>;
  readonly transitionSessionCreateIntent: (
    input: TransitionHermesSessionCreateIntentInput,
  ) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  readonly transitionMutationIntent: (
    input: TransitionHermesMutationIntentInput,
  ) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  readonly getMutationIntent: (
    operationId: string,
  ) => Effect.Effect<Option.Option<HermesMutationIntent>, HermesSessionBindingRepositoryError>;
  readonly listUnsettledMutationIntents: (
    bindingId: string,
  ) => Effect.Effect<ReadonlyArray<HermesMutationIntent>, HermesSessionBindingRepositoryError>;
  readonly prepareSessionImport: (
    input: PrepareHermesSessionImportInput,
  ) => Effect.Effect<HermesSessionImport, HermesSessionBindingRepositoryError>;
  readonly getSessionImportByStoredIdentity: (
    identity: HermesBindingStoredIdentity & { readonly projectId: string },
  ) => Effect.Effect<Option.Option<HermesSessionImport>, HermesSessionBindingRepositoryError>;
  readonly getMainSessionImport: (input: {
    readonly providerInstanceId: string;
    readonly profileKey: string;
    readonly projectId: string;
  }) => Effect.Effect<Option.Option<HermesSessionImport>, HermesSessionBindingRepositoryError>;
  readonly transitionSessionImport: (input: {
    readonly importId: string;
    readonly from: "prepared" | "thread_created";
    readonly to: "thread_created" | "completed";
    readonly now: string;
  }) => Effect.Effect<boolean, HermesSessionBindingRepositoryError>;
  /**
   * Records the inherited-history boundary exactly once. Later hydrations of
   * the same import keep the original boundary so native T3 messages appended
   * after the import never receive imported-transcript normalization.
   */
  readonly setSessionImportInheritedCount: (input: {
    readonly importId: string;
    readonly inheritedMessageCount: number;
    readonly now: string;
  }) => Effect.Effect<number, HermesSessionBindingRepositoryError>;
  readonly listHistoryThreadIds: (
    scope: HermesHistoryScope,
  ) => Effect.Effect<ReadonlyArray<string>, HermesSessionBindingRepositoryError>;
  readonly clearHistoryRecords: (
    scope: HermesHistoryScope,
  ) => Effect.Effect<number, HermesSessionBindingRepositoryError>;
}

export class HermesSessionBindingRepository extends Context.Service<
  HermesSessionBindingRepository,
  HermesSessionBindingRepositoryShape
>()("t3/hermes/HermesSessionBindingRepository") {}

interface BindingRow {
  readonly binding_id: string;
  readonly provider_instance_id: string;
  readonly profile_key: string;
  readonly project_id: string;
  readonly stored_session_key: string;
  readonly thread_id: string;
  readonly protocol_classification: string;
  readonly protocol_major: number | null;
  readonly protocol_minor: number | null;
  readonly capabilities_json: string;
  readonly reconciliation_cursor: string | null;
  readonly reconciliation_fingerprint: string | null;
  readonly title_revision: number;
  readonly title_origin: string | null;
  readonly parent_binding_id: string | null;
  readonly branch_boundary_mode: string | null;
  readonly branch_boundary_message_id: string | null;
  readonly branch_boundary_message_count: number | null;
  readonly lease_owner_key: string | null;
  readonly lease_generation: number;
  readonly lease_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface IntentRow {
  readonly operation_id: string;
  readonly binding_id: string | null;
  readonly provider_instance_id: string;
  readonly profile_key: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly attempt_id: string | null;
  readonly message_id: string | null;
  readonly mutation_kind: string;
  readonly method: string;
  readonly payload_digest: string;
  readonly owner_generation: number;
  readonly state: string;
  readonly prepared_at: string;
  readonly admitted_at: string | null;
  readonly settled_at: string | null;
  readonly updated_at: string;
}

interface ImportRow {
  readonly import_id: string;
  readonly provider_instance_id: string;
  readonly profile_key: string;
  readonly project_id: string;
  readonly import_kind: string;
  readonly stored_session_key: string | null;
  readonly thread_id: string;
  readonly state: string;
  readonly inherited_message_count: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeCapabilities = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const decodeBinding = Schema.decodeUnknownEffect(HermesSessionBinding);
const decodeIntent = Schema.decodeUnknownEffect(HermesMutationIntent);
const decodeImport = Schema.decodeUnknownEffect(HermesSessionImport);
const isRepositoryError = Schema.is(HermesSessionBindingRepositoryError);

function repositoryError(operation: string, detail: string, cause?: unknown) {
  return new HermesSessionBindingRepositoryError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function mapRepositoryError(operation: string, detail: string) {
  return (cause: unknown): HermesSessionBindingRepositoryError =>
    isRepositoryError(cause) ? cause : repositoryError(operation, detail, cause);
}

const bindingFromRow = Effect.fn("HermesSessionBindingRepository.bindingFromRow")(function* (
  row: BindingRow,
) {
  const capabilities = yield* decodeCapabilities(row.capabilities_json);
  return yield* decodeBinding({
    bindingId: row.binding_id,
    providerInstanceId: row.provider_instance_id,
    profileKey: row.profile_key,
    projectId: row.project_id,
    storedSessionKey: row.stored_session_key,
    threadId: row.thread_id,
    protocolClassification: row.protocol_classification,
    protocolMajor: row.protocol_major,
    protocolMinor: row.protocol_minor,
    capabilities,
    reconciliationCursor: row.reconciliation_cursor,
    reconciliationFingerprint: row.reconciliation_fingerprint,
    titleRevision: row.title_revision,
    titleOrigin: row.title_origin,
    parentBindingId: row.parent_binding_id,
    branchBoundaryMode: row.branch_boundary_mode,
    branchBoundaryMessageId: row.branch_boundary_message_id,
    branchBoundaryMessageCount: row.branch_boundary_message_count,
    leaseOwnerKey: row.lease_owner_key,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

const intentFromRow = Effect.fn("HermesSessionBindingRepository.intentFromRow")(function* (
  row: IntentRow,
) {
  return yield* decodeIntent({
    operationId: row.operation_id,
    bindingId: row.binding_id,
    providerInstanceId: row.provider_instance_id,
    profileKey: row.profile_key,
    projectId: row.project_id,
    threadId: row.thread_id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    messageId: row.message_id,
    mutationKind: row.mutation_kind,
    method: row.method,
    payloadDigest: row.payload_digest,
    ownerGeneration: row.owner_generation,
    state: row.state,
    preparedAt: row.prepared_at,
    admittedAt: row.admitted_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  });
});

const importFromRow = Effect.fn("HermesSessionBindingRepository.importFromRow")(function* (
  row: ImportRow,
) {
  return yield* decodeImport({
    importId: row.import_id,
    providerInstanceId: row.provider_instance_id,
    profileKey: row.profile_key,
    projectId: row.project_id,
    importKind: row.import_kind,
    storedSessionKey: row.stored_session_key,
    threadId: row.thread_id,
    state: row.state,
    inheritedMessageCount: row.inherited_message_count ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

function optionFromRows<A, B, E, R>(
  rows: ReadonlyArray<A>,
  decode: (row: A) => Effect.Effect<B, E, R>,
): Effect.Effect<Option.Option<B>, E, R> {
  const row = rows[0];
  return row === undefined
    ? Effect.succeed(Option.none())
    : decode(row).pipe(Effect.map((value) => Option.some(value)));
}

function normalizedCapabilities(capabilities: ReadonlyArray<string>): string {
  return JSON.stringify([...new Set(capabilities)].toSorted());
}

function validateProtocolVersion(
  operation: string,
  major: number | null,
  minor: number | null,
): Effect.Effect<void, HermesSessionBindingRepositoryError> {
  if ((major === null) !== (minor === null)) {
    return Effect.fail(
      repositoryError(
        operation,
        "Protocol major and minor must either both be set or both be null.",
      ),
    );
  }
  if (
    (major !== null && (!Number.isInteger(major) || major < 0)) ||
    (minor !== null && (!Number.isInteger(minor) || minor < 0))
  ) {
    return Effect.fail(
      repositoryError(operation, "Protocol major and minor must be non-negative integers."),
    );
  }
  return Effect.void;
}

const SHA256_DIGEST = /^[a-f0-9]{64}$/;

const allowedTransitions: Readonly<Record<HermesMutationIntentState, ReadonlySet<string>>> = {
  prepared: new Set(["admitted", "indeterminate", "reconciled", "rejected"]),
  admitted: new Set(["confirmed", "indeterminate", "rejected"]),
  confirmed: new Set(),
  indeterminate: new Set(["reconciled", "rejected"]),
  reconciled: new Set(),
  rejected: new Set(),
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createBinding = Effect.fn("HermesSessionBindingRepository.createBinding")(
    function* (input: CreateHermesSessionBindingInput) {
      yield* validateProtocolVersion("createBinding", input.protocolMajor, input.protocolMinor);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly binding_id: string }>`
            INSERT INTO hermes_session_bindings (
              binding_id,
              provider_instance_id,
              profile_key,
              project_id,
              stored_session_key,
              thread_id,
              protocol_classification,
              protocol_major,
              protocol_minor,
              capabilities_json,
              reconciliation_cursor,
              reconciliation_fingerprint,
              title_revision,
              title_origin,
              parent_binding_id,
              branch_boundary_mode,
              branch_boundary_message_id,
              branch_boundary_message_count,
              lease_owner_key,
              lease_generation,
              lease_expires_at,
              created_at,
              updated_at
            ) VALUES (
              ${input.bindingId},
              ${input.providerInstanceId},
              ${input.profileKey},
              ${input.projectId},
              ${input.storedSessionKey},
              ${input.threadId},
              ${input.protocolClassification},
              ${input.protocolMajor},
              ${input.protocolMinor},
              ${normalizedCapabilities(input.capabilities)},
              ${input.reconciliationCursor},
              ${input.reconciliationFingerprint},
              ${input.titleRevision ?? 0},
              ${input.titleOrigin ?? null},
              ${input.parentBindingId ?? null},
              ${input.branchBoundaryMode ?? null},
              ${input.branchBoundaryMessageId ?? null},
              ${input.branchBoundaryMessageCount ?? null},
              NULL,
              0,
              NULL,
              ${input.now},
              ${input.now}
            )
            ON CONFLICT DO NOTHING
            RETURNING binding_id
          `;
          if (rows.length === 0) {
            if (input.createOperationId === undefined) return false;
            const alreadyAttached = yield* sql<{ readonly operation_id: string }>`
              SELECT intent.operation_id
              FROM hermes_mutation_intents AS intent
              INNER JOIN hermes_session_bindings AS binding
                ON binding.binding_id = intent.binding_id
              WHERE intent.operation_id = ${input.createOperationId}
                AND intent.state = 'confirmed'
                AND intent.mutation_kind = 'session_create'
                AND binding.binding_id = ${input.bindingId}
                AND binding.provider_instance_id = ${input.providerInstanceId}
                AND binding.profile_key = ${input.profileKey}
                AND binding.project_id = ${input.projectId}
                AND binding.stored_session_key = ${input.storedSessionKey}
                AND binding.thread_id = ${input.threadId}
            `;
            return alreadyAttached.length === 1;
          }
          if (input.createOperationId === undefined) return true;

          const attached = yield* sql<{ readonly operation_id: string }>`
            UPDATE hermes_mutation_intents
            SET
              binding_id = ${input.bindingId},
              state = 'confirmed',
              settled_at = ${input.now},
              updated_at = ${input.now}
            WHERE operation_id = ${input.createOperationId}
              AND binding_id IS NULL
              AND provider_instance_id = ${input.providerInstanceId}
              AND profile_key = ${input.profileKey}
              AND project_id = ${input.projectId}
              AND thread_id = ${input.threadId}
              AND mutation_kind = 'session_create'
              AND state IN ('prepared', 'admitted', 'indeterminate')
            RETURNING operation_id
          `;
          if (attached.length !== 1) {
            return yield* repositoryError(
              "createBinding",
              "The pre-binding session-create intent was missing or did not match the binding identity.",
            );
          }
          return true;
        }),
      );
    },
    Effect.mapError(mapRepositoryError("createBinding", "Could not create the binding.")),
  );

  const getByThreadId = Effect.fn("HermesSessionBindingRepository.getByThreadId")(
    function* (threadId: string) {
      const rows = yield* sql<BindingRow>`
      SELECT *
      FROM hermes_session_bindings
      WHERE thread_id = ${threadId}
    `;
      return yield* optionFromRows(rows, bindingFromRow);
    },
    Effect.mapError(mapRepositoryError("getByThreadId", "Could not load the binding.")),
  );

  const getByStoredIdentity = Effect.fn("HermesSessionBindingRepository.getByStoredIdentity")(
    function* (identity: HermesBindingStoredIdentity) {
      const rows = yield* sql<BindingRow>`
      SELECT *
      FROM hermes_session_bindings
      WHERE provider_instance_id = ${identity.providerInstanceId}
        AND profile_key = ${identity.profileKey}
        AND stored_session_key = ${identity.storedSessionKey}
    `;
      return yield* optionFromRows(rows, bindingFromRow);
    },
    Effect.mapError(mapRepositoryError("getByStoredIdentity", "Could not load the binding.")),
  );

  const updateNegotiation = Effect.fn("HermesSessionBindingRepository.updateNegotiation")(
    function* (input: UpdateHermesNegotiationInput) {
      yield* validateProtocolVersion("updateNegotiation", input.protocolMajor, input.protocolMinor);
      const rows = yield* sql<{ readonly binding_id: string }>`
      UPDATE hermes_session_bindings
      SET
        protocol_classification = ${input.protocolClassification},
        protocol_major = ${input.protocolMajor},
        protocol_minor = ${input.protocolMinor},
        capabilities_json = ${normalizedCapabilities(input.capabilities)},
        updated_at = ${input.now}
      WHERE binding_id = ${input.bindingId}
        AND lease_owner_key = ${input.ownerKey}
        AND lease_generation = ${input.generation}
        AND lease_expires_at > ${input.now}
      RETURNING binding_id
    `;
      return rows.length === 1;
    },
    Effect.mapError(mapRepositoryError("updateNegotiation", "Could not update negotiation.")),
  );

  const updateReconciliation = Effect.fn("HermesSessionBindingRepository.updateReconciliation")(
    function* (input: UpdateHermesReconciliationInput) {
      const rows = yield* sql<{ readonly binding_id: string }>`
      UPDATE hermes_session_bindings
      SET
        reconciliation_cursor = ${input.cursor},
        reconciliation_fingerprint = ${input.fingerprint},
        updated_at = ${input.now}
      WHERE binding_id = ${input.bindingId}
        AND lease_owner_key = ${input.ownerKey}
        AND lease_generation = ${input.generation}
        AND lease_expires_at > ${input.now}
      RETURNING binding_id
    `;
      return rows.length === 1;
    },
    Effect.mapError(mapRepositoryError("updateReconciliation", "Could not update reconciliation.")),
  );

  const updateTitleState = Effect.fn("HermesSessionBindingRepository.updateTitleState")(
    function* (input: UpdateHermesTitleStateInput) {
      const rows = yield* sql<{ readonly binding_id: string }>`
        UPDATE hermes_session_bindings
        SET
          title_revision = ${input.revision},
          title_origin = ${input.origin},
          updated_at = ${input.now}
        WHERE binding_id = ${input.bindingId}
          AND lease_owner_key = ${input.ownerKey}
          AND lease_generation = ${input.generation}
          AND lease_expires_at > ${input.now}
          AND title_revision < ${input.revision}
        RETURNING binding_id
      `;
      return rows.length === 1;
    },
    Effect.mapError(mapRepositoryError("updateTitleState", "Could not update title state.")),
  );

  const acquireOwnerLease = Effect.fn("HermesSessionBindingRepository.acquireOwnerLease")(
    function* (input: AcquireHermesOwnerLeaseInput) {
      if (input.expiresAt <= input.now) {
        return yield* repositoryError(
          "acquireOwnerLease",
          "Lease expiry must be later than the compare-and-swap timestamp.",
        );
      }
      const rows = yield* sql<{
        readonly binding_id: string;
        readonly lease_owner_key: string;
        readonly lease_generation: number;
        readonly lease_expires_at: string;
      }>`
      UPDATE hermes_session_bindings
      SET
        lease_owner_key = ${input.ownerKey},
        lease_generation = lease_generation + 1,
        lease_expires_at = ${input.expiresAt},
        updated_at = ${input.now}
      WHERE binding_id = ${input.bindingId}
        AND lease_generation = ${input.expectedGeneration}
        AND (
          lease_owner_key IS NULL
          OR lease_expires_at <= ${input.now}
          OR lease_owner_key = ${input.ownerKey}
        )
      RETURNING binding_id, lease_owner_key, lease_generation, lease_expires_at
    `;
      const row = rows[0];
      return row === undefined
        ? Option.none()
        : Option.some({
            bindingId: row.binding_id,
            ownerKey: row.lease_owner_key,
            generation: row.lease_generation,
            expiresAt: row.lease_expires_at,
          });
    },
    Effect.mapError(mapRepositoryError("acquireOwnerLease", "Could not acquire the owner lease.")),
  );

  const renewOwnerLease = Effect.fn("HermesSessionBindingRepository.renewOwnerLease")(
    function* (input: HermesLeaseFence & { readonly expiresAt: string }) {
      if (input.expiresAt <= input.now) {
        return yield* repositoryError(
          "renewOwnerLease",
          "Lease expiry must be later than the compare-and-swap timestamp.",
        );
      }
      const rows = yield* sql<{ readonly binding_id: string }>`
      UPDATE hermes_session_bindings
      SET lease_expires_at = ${input.expiresAt}, updated_at = ${input.now}
      WHERE binding_id = ${input.bindingId}
        AND lease_owner_key = ${input.ownerKey}
        AND lease_generation = ${input.generation}
        AND lease_expires_at > ${input.now}
      RETURNING binding_id
    `;
      return rows.length === 1;
    },
    Effect.mapError(mapRepositoryError("renewOwnerLease", "Could not renew the owner lease.")),
  );

  const releaseOwnerLease = Effect.fn("HermesSessionBindingRepository.releaseOwnerLease")(
    function* (input: Omit<HermesLeaseFence, "now"> & { readonly now: string }) {
      const rows = yield* sql<{ readonly binding_id: string }>`
      UPDATE hermes_session_bindings
      SET lease_owner_key = NULL, lease_expires_at = NULL, updated_at = ${input.now}
      WHERE binding_id = ${input.bindingId}
        AND lease_owner_key = ${input.ownerKey}
        AND lease_generation = ${input.generation}
      RETURNING binding_id
    `;
      return rows.length === 1;
    },
    Effect.mapError(mapRepositoryError("releaseOwnerLease", "Could not release the owner lease.")),
  );

  const getMutationIntent = Effect.fn("HermesSessionBindingRepository.getMutationIntent")(
    function* (operationId: string) {
      const rows = yield* sql<IntentRow>`
      SELECT *
      FROM hermes_mutation_intents
      WHERE operation_id = ${operationId}
    `;
      return yield* optionFromRows(rows, intentFromRow);
    },
    Effect.mapError(mapRepositoryError("getMutationIntent", "Could not load the mutation intent.")),
  );

  const prepareMutationIntent = Effect.fn("HermesSessionBindingRepository.prepareMutationIntent")(
    function* (input: PrepareHermesMutationIntentInput) {
      if (!SHA256_DIGEST.test(input.payloadDigest)) {
        return yield* repositoryError(
          "prepareMutationIntent",
          "payloadDigest must be a lowercase SHA-256 hex digest.",
        );
      }
      const rows = yield* sql<IntentRow>`
      INSERT INTO hermes_mutation_intents (
        operation_id,
        binding_id,
        provider_instance_id,
        profile_key,
        project_id,
        thread_id,
        run_id,
        attempt_id,
        message_id,
        mutation_kind,
        method,
        payload_digest,
        owner_generation,
        state,
        prepared_at,
        admitted_at,
        settled_at,
        updated_at
      )
      SELECT
        ${input.operationId},
        binding_id,
        provider_instance_id,
        profile_key,
        project_id,
        thread_id,
        NULL,
        NULL,
        NULL,
        ${input.mutationKind},
        ${input.method},
        ${input.payloadDigest},
        ${input.generation},
        'prepared',
        ${input.now},
        NULL,
        NULL,
        ${input.now}
      FROM hermes_session_bindings
      WHERE binding_id = ${input.bindingId}
        AND lease_owner_key = ${input.ownerKey}
        AND lease_generation = ${input.generation}
        AND lease_expires_at > ${input.now}
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
      const prepared = rows[0];
      if (prepared !== undefined) {
        return {
          status: "prepared",
          intent: yield* intentFromRow(prepared),
        } satisfies PrepareHermesMutationIntentResult;
      }

      const existing = yield* getMutationIntent(input.operationId);
      if (Option.isSome(existing)) {
        return {
          status: "operation_exists",
          intent: existing.value,
        } satisfies PrepareHermesMutationIntentResult;
      }

      if (input.mutationKind === "prompt") {
        const unsettled = yield* sql<{ readonly operation_id: string }>`
        SELECT operation_id
        FROM hermes_mutation_intents
        WHERE binding_id = ${input.bindingId}
          AND mutation_kind = 'prompt'
          AND state IN ('prepared', 'admitted', 'indeterminate')
        ORDER BY prepared_at ASC, operation_id ASC
        LIMIT 1
      `;
        if (unsettled[0] !== undefined) {
          return {
            status: "unsettled_prompt",
            operationId: unsettled[0].operation_id,
          } satisfies PrepareHermesMutationIntentResult;
        }
      }
      return { status: "lease_not_held" } satisfies PrepareHermesMutationIntentResult;
    },
    Effect.mapError(
      mapRepositoryError("prepareMutationIntent", "Could not prepare the mutation intent."),
    ),
  );

  const prepareSessionCreateIntent = Effect.fn(
    "HermesSessionBindingRepository.prepareSessionCreateIntent",
  )(
    function* (input: PrepareHermesSessionCreateIntentInput) {
      if (!SHA256_DIGEST.test(input.payloadDigest)) {
        return yield* repositoryError(
          "prepareSessionCreateIntent",
          "payloadDigest must be a lowercase SHA-256 hex digest.",
        );
      }
      const rows = yield* sql<IntentRow>`
        INSERT INTO hermes_mutation_intents (
          operation_id,
          binding_id,
          provider_instance_id,
          profile_key,
          project_id,
          thread_id,
          run_id,
          attempt_id,
          message_id,
          mutation_kind,
          method,
          payload_digest,
          owner_generation,
          state,
          prepared_at,
          admitted_at,
          settled_at,
          updated_at
        ) VALUES (
          ${input.operationId},
          NULL,
          ${input.providerInstanceId},
          ${input.profileKey},
          ${input.projectId},
          ${input.threadId},
          ${input.runId ?? null},
          ${input.attemptId ?? null},
          ${input.messageId ?? null},
          'session_create',
          ${input.method},
          ${input.payloadDigest},
          0,
          'prepared',
          ${input.now},
          NULL,
          NULL,
          ${input.now}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      const prepared = rows[0];
      if (prepared !== undefined) {
        return {
          status: "prepared",
          intent: yield* intentFromRow(prepared),
        } satisfies PrepareHermesSessionCreateIntentResult;
      }

      const existing = yield* getMutationIntent(input.operationId);
      if (Option.isSome(existing)) {
        return {
          status: "operation_exists",
          intent: existing.value,
        } satisfies PrepareHermesSessionCreateIntentResult;
      }

      const unsettled = yield* sql<{ readonly operation_id: string }>`
        SELECT operation_id
        FROM hermes_mutation_intents
        WHERE provider_instance_id = ${input.providerInstanceId}
          AND profile_key = ${input.profileKey}
          AND project_id = ${input.projectId}
          AND thread_id = ${input.threadId}
          AND mutation_kind = 'session_create'
          AND state IN ('prepared', 'admitted', 'indeterminate')
        ORDER BY prepared_at ASC, operation_id ASC
        LIMIT 1
      `;
      return {
        status: "unsettled_create",
        operationId: unsettled[0]!.operation_id,
      } satisfies PrepareHermesSessionCreateIntentResult;
    },
    Effect.mapError(
      mapRepositoryError(
        "prepareSessionCreateIntent",
        "Could not prepare the pre-binding session-create intent.",
      ),
    ),
  );

  const transitionSessionCreateIntent = Effect.fn(
    "HermesSessionBindingRepository.transitionSessionCreateIntent",
  )(
    function* (input: TransitionHermesSessionCreateIntentInput) {
      const valid =
        (input.from === "prepared" &&
          (input.to === "admitted" || input.to === "indeterminate" || input.to === "rejected")) ||
        (input.from === "admitted" && (input.to === "indeterminate" || input.to === "rejected"));
      if (!valid) {
        return yield* repositoryError(
          "transitionSessionCreateIntent",
          `Invalid pre-binding session-create transition ${input.from} -> ${input.to}.`,
        );
      }
      const terminal = input.to === "rejected";
      const rows = yield* sql<{ readonly operation_id: string }>`
        UPDATE hermes_mutation_intents
        SET
          state = ${input.to},
          admitted_at = CASE
            WHEN ${input.to} = 'admitted' THEN COALESCE(admitted_at, ${input.now})
            ELSE admitted_at
          END,
          settled_at = CASE WHEN ${terminal ? 1 : 0} = 1 THEN ${input.now} ELSE NULL END,
          updated_at = ${input.now}
        WHERE operation_id = ${input.operationId}
          AND binding_id IS NULL
          AND mutation_kind = 'session_create'
          AND state = ${input.from}
        RETURNING operation_id
      `;
      return rows.length === 1;
    },
    Effect.mapError(
      mapRepositoryError(
        "transitionSessionCreateIntent",
        "Could not transition the pre-binding session-create intent.",
      ),
    ),
  );

  const transitionMutationIntent = Effect.fn(
    "HermesSessionBindingRepository.transitionMutationIntent",
  )(
    function* (input: TransitionHermesMutationIntentInput) {
      if (!allowedTransitions[input.from].has(input.to)) {
        return yield* repositoryError(
          "transitionMutationIntent",
          `Invalid mutation intent transition ${input.from} -> ${input.to}.`,
        );
      }
      const terminal =
        input.to === "confirmed" || input.to === "reconciled" || input.to === "rejected";
      const rows = yield* sql<{ readonly operation_id: string }>`
      UPDATE hermes_mutation_intents
      SET
        state = ${input.to},
        admitted_at = CASE
          WHEN ${input.to} = 'admitted' THEN COALESCE(admitted_at, ${input.now})
          ELSE admitted_at
        END,
        settled_at = CASE WHEN ${terminal ? 1 : 0} = 1 THEN ${input.now} ELSE NULL END,
        updated_at = ${input.now}
      WHERE operation_id = ${input.operationId}
        AND binding_id = ${input.bindingId}
        AND state = ${input.from}
        AND EXISTS (
          SELECT 1
          FROM hermes_session_bindings AS binding
          WHERE binding.binding_id = hermes_mutation_intents.binding_id
            AND binding.lease_owner_key = ${input.ownerKey}
            AND binding.lease_generation = ${input.generation}
            AND binding.lease_expires_at > ${input.now}
        )
      RETURNING operation_id
    `;
      return rows.length === 1;
    },
    Effect.mapError(
      mapRepositoryError("transitionMutationIntent", "Could not transition the mutation intent."),
    ),
  );

  const listUnsettledMutationIntents = Effect.fn(
    "HermesSessionBindingRepository.listUnsettledMutationIntents",
  )(
    function* (bindingId: string) {
      const rows = yield* sql<IntentRow>`
      SELECT *
      FROM hermes_mutation_intents
      WHERE binding_id = ${bindingId}
        AND state IN ('prepared', 'admitted', 'indeterminate')
      ORDER BY prepared_at ASC, operation_id ASC
    `;
      return yield* Effect.forEach(rows, intentFromRow, { concurrency: 1 });
    },
    Effect.mapError(
      mapRepositoryError(
        "listUnsettledMutationIntents",
        "Could not list unsettled mutation intents.",
      ),
    ),
  );

  const prepareSessionImport = Effect.fn("HermesSessionBindingRepository.prepareSessionImport")(
    function* (input: PrepareHermesSessionImportInput) {
      const inserted = yield* sql<ImportRow>`
        INSERT INTO hermes_session_imports (
          import_id,
          provider_instance_id,
          profile_key,
          project_id,
          import_kind,
          stored_session_key,
          thread_id,
          state,
          created_at,
          updated_at
        ) VALUES (
          ${input.importId},
          ${input.providerInstanceId},
          ${input.profileKey},
          ${input.projectId},
          ${input.importKind},
          ${input.storedSessionKey},
          ${input.threadId},
          'prepared',
          ${input.now},
          ${input.now}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      if (inserted[0] !== undefined) return yield* importFromRow(inserted[0]);

      const existing =
        input.importKind === "main"
          ? yield* sql<ImportRow>`
              SELECT * FROM hermes_session_imports
              WHERE provider_instance_id = ${input.providerInstanceId}
                AND profile_key = ${input.profileKey}
                AND project_id = ${input.projectId}
                AND import_kind = 'main'
              LIMIT 1
            `
          : yield* sql<ImportRow>`
              SELECT * FROM hermes_session_imports
              WHERE provider_instance_id = ${input.providerInstanceId}
                AND profile_key = ${input.profileKey}
                AND project_id = ${input.projectId}
                AND stored_session_key = ${input.storedSessionKey}
                AND import_kind = 'session'
              LIMIT 1
            `;
      if (existing[0] === undefined) {
        return yield* repositoryError(
          "prepareSessionImport",
          "Import identity conflicted with a different durable row.",
        );
      }
      return yield* importFromRow(existing[0]);
    },
    Effect.mapError(
      mapRepositoryError("prepareSessionImport", "Could not prepare the session import."),
    ),
  );

  const getSessionImportByStoredIdentity = Effect.fn(
    "HermesSessionBindingRepository.getSessionImportByStoredIdentity",
  )(
    function* (identity: HermesBindingStoredIdentity & { readonly projectId: string }) {
      const rows = yield* sql<ImportRow>`
        SELECT * FROM hermes_session_imports
        WHERE provider_instance_id = ${identity.providerInstanceId}
          AND profile_key = ${identity.profileKey}
          AND project_id = ${identity.projectId}
          AND stored_session_key = ${identity.storedSessionKey}
          AND import_kind = 'session'
        LIMIT 1
      `;
      return rows[0] === undefined ? Option.none() : Option.some(yield* importFromRow(rows[0]));
    },
    Effect.mapError(
      mapRepositoryError(
        "getSessionImportByStoredIdentity",
        "Could not read the stored-session import.",
      ),
    ),
  );

  const getMainSessionImport = Effect.fn("HermesSessionBindingRepository.getMainSessionImport")(
    function* (input: {
      readonly providerInstanceId: string;
      readonly profileKey: string;
      readonly projectId: string;
    }) {
      const rows = yield* sql<ImportRow>`
        SELECT * FROM hermes_session_imports
        WHERE provider_instance_id = ${input.providerInstanceId}
          AND profile_key = ${input.profileKey}
          AND project_id = ${input.projectId}
          AND import_kind = 'main'
        LIMIT 1
      `;
      return rows[0] === undefined ? Option.none() : Option.some(yield* importFromRow(rows[0]));
    },
    Effect.mapError(
      mapRepositoryError("getMainSessionImport", "Could not read the Hermes Main import."),
    ),
  );

  const transitionSessionImport = Effect.fn(
    "HermesSessionBindingRepository.transitionSessionImport",
  )(
    function* (input: {
      readonly importId: string;
      readonly from: "prepared" | "thread_created";
      readonly to: "thread_created" | "completed";
      readonly now: string;
    }) {
      const valid =
        (input.from === "prepared" && input.to === "thread_created") ||
        (input.from === "thread_created" && input.to === "completed");
      if (!valid) {
        return yield* repositoryError(
          "transitionSessionImport",
          `Invalid session import transition ${input.from} -> ${input.to}.`,
        );
      }
      const rows = yield* sql<{ readonly import_id: string }>`
        UPDATE hermes_session_imports
        SET state = ${input.to}, updated_at = ${input.now}
        WHERE import_id = ${input.importId}
          AND state = ${input.from}
        RETURNING import_id
      `;
      return rows.length === 1;
    },
    Effect.mapError(
      mapRepositoryError("transitionSessionImport", "Could not transition the session import."),
    ),
  );

  const setSessionImportInheritedCount = Effect.fn(
    "HermesSessionBindingRepository.setSessionImportInheritedCount",
  )(
    function* (input: {
      readonly importId: string;
      readonly inheritedMessageCount: number;
      readonly now: string;
    }) {
      if (!Number.isSafeInteger(input.inheritedMessageCount) || input.inheritedMessageCount < 0) {
        return yield* repositoryError(
          "setSessionImportInheritedCount",
          "Inherited message count must be a non-negative integer.",
        );
      }
      yield* sql`
        UPDATE hermes_session_imports
        SET inherited_message_count = ${input.inheritedMessageCount}, updated_at = ${input.now}
        WHERE import_id = ${input.importId}
          AND inherited_message_count IS NULL
      `;
      const rows = yield* sql<{ readonly inherited_message_count: number | null }>`
        SELECT inherited_message_count
        FROM hermes_session_imports
        WHERE import_id = ${input.importId}
      `;
      const recorded = rows[0]?.inherited_message_count;
      if (recorded === null || recorded === undefined) {
        return yield* repositoryError(
          "setSessionImportInheritedCount",
          "Import row was missing while recording the inherited boundary.",
        );
      }
      return recorded;
    },
    Effect.mapError(
      mapRepositoryError(
        "setSessionImportInheritedCount",
        "Could not record the inherited-history boundary.",
      ),
    ),
  );

  const listHistoryThreadIds = Effect.fn("HermesSessionBindingRepository.listHistoryThreadIds")(
    function* (scope: HermesHistoryScope) {
      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM hermes_session_bindings
        WHERE provider_instance_id = ${scope.providerInstanceId}
          AND profile_key = ${scope.profileKey}
          AND project_id = ${scope.projectId}
        UNION
        SELECT thread_id
        FROM hermes_session_imports
        WHERE provider_instance_id = ${scope.providerInstanceId}
          AND profile_key = ${scope.profileKey}
          AND project_id = ${scope.projectId}
      `;
      return rows.map((row) => row.thread_id);
    },
    Effect.mapError(
      mapRepositoryError("listHistoryThreadIds", "Could not list locally owned Hermes threads."),
    ),
  );

  const clearHistoryRecords = Effect.fn("HermesSessionBindingRepository.clearHistoryRecords")(
    function* (scope: HermesHistoryScope) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const unsettled = yield* sql<{ readonly operation_id: string }>`
            SELECT operation_id
            FROM hermes_mutation_intents
            WHERE provider_instance_id = ${scope.providerInstanceId}
              AND profile_key = ${scope.profileKey}
              AND project_id = ${scope.projectId}
              AND state IN ('prepared', 'admitted', 'indeterminate')
            LIMIT 1
          `;
          if (unsettled[0] !== undefined) {
            return yield* repositoryError(
              "clearHistoryRecords",
              `History reset is blocked by unsettled Hermes mutation ${unsettled[0].operation_id}.`,
            );
          }
          const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM hermes_session_imports
            WHERE provider_instance_id = ${scope.providerInstanceId}
              AND profile_key = ${scope.profileKey}
              AND project_id = ${scope.projectId}
          `;
          yield* sql`
            DELETE FROM hermes_mutation_intents
            WHERE provider_instance_id = ${scope.providerInstanceId}
              AND profile_key = ${scope.profileKey}
              AND project_id = ${scope.projectId}
          `;
          yield* sql`
            DELETE FROM hermes_session_bindings
            WHERE provider_instance_id = ${scope.providerInstanceId}
              AND profile_key = ${scope.profileKey}
              AND project_id = ${scope.projectId}
          `;
          yield* sql`
            DELETE FROM hermes_session_imports
            WHERE provider_instance_id = ${scope.providerInstanceId}
              AND profile_key = ${scope.profileKey}
              AND project_id = ${scope.projectId}
          `;
          return rows[0]?.count ?? 0;
        }),
      );
    },
    Effect.mapError(
      mapRepositoryError("clearHistoryRecords", "Could not clear T3 Work history records."),
    ),
  );

  return HermesSessionBindingRepository.of({
    createBinding,
    getByThreadId,
    getByStoredIdentity,
    updateNegotiation,
    updateReconciliation,
    updateTitleState,
    acquireOwnerLease,
    renewOwnerLease,
    releaseOwnerLease,
    prepareMutationIntent,
    prepareSessionCreateIntent,
    transitionSessionCreateIntent,
    transitionMutationIntent,
    getMutationIntent,
    listUnsettledMutationIntents,
    prepareSessionImport,
    getSessionImportByStoredIdentity,
    getMainSessionImport,
    transitionSessionImport,
    setSessionImportInheritedCount,
    listHistoryThreadIds,
    clearHistoryRecords,
  });
});

export const layer: Layer.Layer<HermesSessionBindingRepository, never, SqlClient.SqlClient> =
  Layer.effect(HermesSessionBindingRepository, make);
