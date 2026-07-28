import {
  HermesInAppNotification,
  HermesNotificationOutboxEntry,
  HermesProactiveEventProvenance,
  HermesProactiveRequiredCapabilities,
  HermesProactiveSourceStatus,
  HermesProactiveWorkItem,
  type HermesGatewayCompatibility,
  type HermesNotificationOutboxEntry as HermesNotificationOutboxEntryType,
  type HermesProactiveDiagnosticCode,
  type HermesProactiveSourceStatus as HermesProactiveSourceStatusType,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeSource = Schema.decodeUnknownEffect(HermesProactiveSourceStatus);
const decodeOutbox = Schema.decodeUnknownEffect(HermesNotificationOutboxEntry);
const decodeWorkItem = Schema.decodeUnknownEffect(HermesProactiveWorkItem);
const decodeNotification = Schema.decodeUnknownEffect(HermesInAppNotification);
const encodeProvenance = Schema.encodeEffect(HermesProactiveEventProvenance);
const MissingCapabilitiesJson = Schema.fromJsonString(Schema.Array(Schema.String));
const ProvenanceJson = Schema.fromJsonString(HermesProactiveEventProvenance);
const decodeMissingCapabilitiesJson = Schema.decodeUnknownSync(MissingCapabilitiesJson);
const encodeMissingCapabilitiesJson = Schema.encodeSync(MissingCapabilitiesJson);
const encodeProvenanceJson = Schema.encodeSync(ProvenanceJson);

export interface RegisterHermesProactiveSourceInput {
  readonly providerInstanceId: string;
  readonly profileKey: string;
  readonly compatibility: HermesGatewayCompatibility;
  readonly now: string;
}

export interface HermesProactiveIncomingEvent {
  readonly externalEventId: string;
  readonly externalCursor: string;
  readonly eventKind: string;
  readonly title: string;
  readonly body: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly occurredAt: string;
}

export interface IngestHermesProactivePageInput {
  readonly sourceId: string;
  readonly expectedCursor: string | null;
  readonly nextCursor: string;
  readonly gatewayRevision: string | null;
  readonly protocolMajor: number | null;
  readonly protocolMinor: number | null;
  readonly receivedAt: string;
  readonly events: ReadonlyArray<HermesProactiveIncomingEvent>;
}

export type IngestHermesProactivePageResult =
  | {
      readonly status: "applied";
      readonly inserted: number;
      readonly duplicates: number;
      readonly checkpointCursor: string;
      readonly checkpointSequence: number;
    }
  | {
      readonly status: "already_applied";
      readonly checkpointCursor: string;
      readonly checkpointSequence: number;
    }
  | {
      readonly status: "stale_checkpoint";
      readonly checkpointCursor: string | null;
      readonly checkpointSequence: number;
    }
  | {
      readonly status: "degraded";
      readonly diagnosticCode: HermesProactiveDiagnosticCode;
    };

export interface ClaimHermesNotificationInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export class HermesProactiveEventRepositoryError extends Schema.TaggedErrorClass<HermesProactiveEventRepositoryError>()(
  "HermesProactiveEventRepositoryError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Hermes proactive event repository failed in ${this.operation}: ${this.detail}`;
  }
}

export interface HermesProactiveEventRepositoryShape {
  readonly registerSource: (
    input: RegisterHermesProactiveSourceInput,
  ) => Effect.Effect<HermesProactiveSourceStatusType, HermesProactiveEventRepositoryError>;
  readonly getSource: (
    sourceId: string,
  ) => Effect.Effect<
    Option.Option<HermesProactiveSourceStatusType>,
    HermesProactiveEventRepositoryError
  >;
  readonly ingestPage: (
    input: IngestHermesProactivePageInput,
  ) => Effect.Effect<IngestHermesProactivePageResult, HermesProactiveEventRepositoryError>;
  readonly claimNotification: (
    input: ClaimHermesNotificationInput,
  ) => Effect.Effect<
    Option.Option<HermesNotificationOutboxEntryType>,
    HermesProactiveEventRepositoryError
  >;
  readonly deliverInApp: (input: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly now: string;
  }) => Effect.Effect<boolean, HermesProactiveEventRepositoryError>;
  readonly retryNotification: (input: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly now: string;
    readonly availableAt: string;
    readonly errorCode: string;
  }) => Effect.Effect<boolean, HermesProactiveEventRepositoryError>;
  readonly deadLetterNotification: (input: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly now: string;
    readonly errorCode: string;
  }) => Effect.Effect<boolean, HermesProactiveEventRepositoryError>;
  readonly listWorkItems: () => Effect.Effect<
    ReadonlyArray<HermesProactiveWorkItem>,
    HermesProactiveEventRepositoryError
  >;
  readonly listInAppNotifications: () => Effect.Effect<
    ReadonlyArray<HermesInAppNotification>,
    HermesProactiveEventRepositoryError
  >;
}

export class HermesProactiveEventRepository extends Context.Service<
  HermesProactiveEventRepository,
  HermesProactiveEventRepositoryShape
>()("t3/hermes/HermesProactiveEventRepository") {}

interface SourceRow {
  readonly source_id: string;
  readonly provider_instance_id: string;
  readonly profile_key: string;
  readonly capability_state: string;
  readonly diagnostic_code: string;
  readonly missing_capabilities_json: string;
  readonly checkpoint_cursor: string | null;
  readonly checkpoint_sequence: number;
  readonly last_checked_at: string;
  readonly updated_at: string;
}

interface OutboxRow {
  readonly outbox_id: string;
  readonly event_id: string;
  readonly state: string;
  readonly attempt_count: number;
  readonly available_at: string;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly delivered_at: string | null;
}

interface EventRow {
  readonly event_id: string;
  readonly title: string;
  readonly body: string;
  readonly project_id: string | null;
  readonly thread_id: string | null;
  readonly occurred_at: string;
}

interface WorkItemRow {
  readonly work_item_id: string;
  readonly event_id: string;
  readonly project_id: string | null;
  readonly thread_id: string | null;
  readonly title: string;
  readonly summary: string;
  readonly status: string;
  readonly occurred_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface NotificationRow {
  readonly notification_id: string;
  readonly event_id: string;
  readonly work_item_id: string;
  readonly project_id: string | null;
  readonly thread_id: string | null;
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function stableId(namespace: string, ...parts: ReadonlyArray<string>): string {
  const digest = NodeCrypto.createHash("sha256")
    .update([namespace, ...parts].map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex");
  return `${namespace}:${digest}`;
}

export function classifyHermesProactiveCapability(compatibility: HermesGatewayCompatibility): {
  readonly state: "ready" | "degraded";
  readonly diagnosticCode: HermesProactiveDiagnosticCode;
  readonly missingCapabilities: ReadonlyArray<string>;
} {
  if (compatibility.inventory === null) {
    return {
      state: "degraded",
      diagnosticCode: "missing_capability_inventory",
      missingCapabilities: [...HermesProactiveRequiredCapabilities],
    };
  }
  const available = new Set(compatibility.capabilities);
  const missingCapabilities = HermesProactiveRequiredCapabilities.filter(
    (capability) => !available.has(capability),
  );
  if (missingCapabilities.includes("cron.events.global_cursor")) {
    return {
      state: "degraded",
      diagnosticCode: "missing_durable_global_cursor",
      missingCapabilities,
    };
  }
  if (missingCapabilities.includes("events.stable_ids")) {
    return {
      state: "degraded",
      diagnosticCode: "missing_stable_event_ids",
      missingCapabilities,
    };
  }
  return { state: "ready", diagnosticCode: "ready", missingCapabilities: [] };
}

function sourceFromRow(row: SourceRow) {
  return decodeSource({
    sourceId: row.source_id,
    providerInstanceId: row.provider_instance_id,
    profileKey: row.profile_key,
    state: row.capability_state,
    diagnosticCode: row.diagnostic_code,
    missingCapabilities: decodeMissingCapabilitiesJson(row.missing_capabilities_json),
    checkpointCursor: row.checkpoint_cursor,
    checkpointSequence: row.checkpoint_sequence,
    lastCheckedAt: row.last_checked_at,
    updatedAt: row.updated_at,
  });
}

function outboxFromRow(row: OutboxRow) {
  return decodeOutbox({
    outboxId: row.outbox_id,
    eventId: row.event_id,
    state: row.state,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  });
}

const isRepositoryError = Schema.is(HermesProactiveEventRepositoryError);

function repositoryError(operation: string, detail: string, cause?: unknown) {
  return new HermesProactiveEventRepositoryError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function mapRepositoryError(operation: string, detail: string) {
  return (cause: unknown): HermesProactiveEventRepositoryError =>
    isRepositoryError(cause) ? cause : repositoryError(operation, detail, cause);
}

export const layer: Layer.Layer<HermesProactiveEventRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    HermesProactiveEventRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const loadSource = Effect.fn("HermesProactiveEventRepository.loadSource")(function* (
        sourceId: string,
      ) {
        const rows = yield* sql<SourceRow>`
        SELECT
          source_id,
          provider_instance_id,
          profile_key,
          capability_state,
          diagnostic_code,
          missing_capabilities_json,
          checkpoint_cursor,
          checkpoint_sequence,
          last_checked_at,
          updated_at
        FROM hermes_proactive_sources
        WHERE source_id = ${sourceId}
        LIMIT 1
      `;
        const row = rows[0];
        return row === undefined ? Option.none() : Option.some(yield* sourceFromRow(row));
      });

      const registerSource: HermesProactiveEventRepositoryShape["registerSource"] = (input) =>
        Effect.gen(function* () {
          const sourceId = stableId(
            "hermes-source",
            input.providerInstanceId,
            input.profileKey,
            "global-cron-events",
          );
          const classification = classifyHermesProactiveCapability(input.compatibility);
          yield* sql`
          INSERT INTO hermes_proactive_sources (
            source_id,
            provider_instance_id,
            profile_key,
            capability_state,
            diagnostic_code,
            missing_capabilities_json,
            checkpoint_cursor,
            checkpoint_sequence,
            last_checked_at,
            created_at,
            updated_at
          )
          VALUES (
            ${sourceId},
            ${input.providerInstanceId},
            ${input.profileKey},
            ${classification.state},
            ${classification.diagnosticCode},
            ${encodeMissingCapabilitiesJson(classification.missingCapabilities)},
            NULL,
            0,
            ${input.now},
            ${input.now},
            ${input.now}
          )
          ON CONFLICT(provider_instance_id, profile_key)
          DO UPDATE SET
            capability_state = excluded.capability_state,
            diagnostic_code = excluded.diagnostic_code,
            missing_capabilities_json = excluded.missing_capabilities_json,
            last_checked_at = excluded.last_checked_at,
            updated_at = excluded.updated_at
        `;
          const source = yield* loadSource(sourceId);
          if (Option.isNone(source)) {
            return yield* repositoryError("registerSource", "Source disappeared after upsert.");
          }
          return source.value;
        }).pipe(
          Effect.mapError(mapRepositoryError("registerSource", "Could not register the source.")),
        );

      const getSource: HermesProactiveEventRepositoryShape["getSource"] = (sourceId) =>
        loadSource(sourceId).pipe(
          Effect.mapError(mapRepositoryError("getSource", "Could not load the source.")),
        );

      const ingestPage: HermesProactiveEventRepositoryShape["ingestPage"] = (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const sourceOption = yield* loadSource(input.sourceId);
              if (Option.isNone(sourceOption)) {
                return yield* repositoryError("ingestPage", "Source is not registered.");
              }
              const source = sourceOption.value;
              if (source.state === "degraded") {
                return {
                  status: "degraded",
                  diagnosticCode: source.diagnosticCode,
                } as const;
              }
              if (input.nextCursor.length === 0) {
                return yield* repositoryError("ingestPage", "A durable next cursor is required.");
              }
              if (source.checkpointCursor === input.nextCursor) {
                return {
                  status: "already_applied",
                  checkpointCursor: input.nextCursor,
                  checkpointSequence: source.checkpointSequence,
                } as const;
              }
              if (source.checkpointCursor !== input.expectedCursor) {
                return {
                  status: "stale_checkpoint",
                  checkpointCursor: source.checkpointCursor,
                  checkpointSequence: source.checkpointSequence,
                } as const;
              }

              let inserted = 0;
              for (const event of input.events) {
                if (event.externalEventId.length === 0 || event.externalCursor.length === 0) {
                  return yield* repositoryError(
                    "ingestPage",
                    "Every proactive event requires a stable id and durable cursor.",
                  );
                }
                const eventId = stableId("hermes-event", input.sourceId, event.externalEventId);
                const provenance = yield* encodeProvenance({
                  provider: "hermes",
                  providerInstanceId: source.providerInstanceId,
                  profileKey: source.profileKey,
                  sourceId: source.sourceId,
                  externalEventId: event.externalEventId,
                  externalCursor: event.externalCursor,
                  gatewayRevision: input.gatewayRevision,
                  protocolMajor: input.protocolMajor,
                  protocolMinor: input.protocolMinor,
                  ingestedAt: input.receivedAt,
                });
                const rows = yield* sql<{ event_id: string }>`
                INSERT INTO hermes_proactive_events (
                  event_id,
                  source_id,
                  external_event_id,
                  external_cursor,
                  event_kind,
                  title,
                  body,
                  project_id,
                  thread_id,
                  occurred_at,
                  received_at,
                  provenance_json
                )
                VALUES (
                  ${eventId},
                  ${input.sourceId},
                  ${event.externalEventId},
                  ${event.externalCursor},
                  ${event.eventKind},
                  ${event.title},
                  ${event.body},
                  ${event.projectId},
                  ${event.threadId},
                  ${event.occurredAt},
                  ${input.receivedAt},
                  ${encodeProvenanceJson(provenance)}
                )
                ON CONFLICT(source_id, external_event_id) DO NOTHING
                RETURNING event_id
              `;
                if (rows.length === 0) continue;
                inserted += 1;
                yield* sql`
                INSERT INTO hermes_notification_outbox (
                  outbox_id,
                  event_id,
                  state,
                  attempt_count,
                  available_at,
                  lease_owner,
                  lease_expires_at,
                  last_error_code,
                  created_at,
                  updated_at,
                  delivered_at
                )
                VALUES (
                  ${stableId("hermes-outbox", eventId)},
                  ${eventId},
                  'pending',
                  0,
                  ${input.receivedAt},
                  NULL,
                  NULL,
                  NULL,
                  ${input.receivedAt},
                  ${input.receivedAt},
                  NULL
                )
              `;
              }

              const advanced = yield* sql<{ checkpoint_sequence: number }>`
              UPDATE hermes_proactive_sources
              SET checkpoint_cursor = ${input.nextCursor},
                  checkpoint_sequence = checkpoint_sequence + 1,
                  updated_at = ${input.receivedAt}
              WHERE source_id = ${input.sourceId}
                AND (
                  checkpoint_cursor = ${input.expectedCursor}
                  OR (checkpoint_cursor IS NULL AND ${input.expectedCursor} IS NULL)
                )
              RETURNING checkpoint_sequence
            `;
              const checkpoint = advanced[0];
              if (checkpoint === undefined) {
                return yield* repositoryError("ingestPage", "Checkpoint compare-and-set failed.");
              }
              return {
                status: "applied",
                inserted,
                duplicates: input.events.length - inserted,
                checkpointCursor: input.nextCursor,
                checkpointSequence: checkpoint.checkpoint_sequence,
              } as const;
            }),
          )
          .pipe(Effect.mapError(mapRepositoryError("ingestPage", "Could not ingest the page.")));

      const claimNotification: HermesProactiveEventRepositoryShape["claimNotification"] = (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const candidates = yield* sql<{ outbox_id: string }>`
              SELECT outbox_id
              FROM hermes_notification_outbox
              WHERE
                (
                  state IN ('pending', 'retry')
                  AND available_at <= ${input.now}
                )
                OR (
                  state = 'processing'
                  AND lease_expires_at <= ${input.now}
                )
              ORDER BY available_at ASC, created_at ASC, outbox_id ASC
              LIMIT 1
            `;
              const candidate = candidates[0];
              if (candidate === undefined) return Option.none();
              const claimed = yield* sql<OutboxRow>`
              UPDATE hermes_notification_outbox
              SET state = 'processing',
                  attempt_count = attempt_count + 1,
                  lease_owner = ${input.workerId},
                  lease_expires_at = ${input.leaseExpiresAt},
                  updated_at = ${input.now}
              WHERE outbox_id = ${candidate.outbox_id}
                AND (
                  (
                    state IN ('pending', 'retry')
                    AND available_at <= ${input.now}
                  )
                  OR (
                    state = 'processing'
                    AND lease_expires_at <= ${input.now}
                  )
                )
              RETURNING *
            `;
              const row = claimed[0];
              return row === undefined ? Option.none() : Option.some(yield* outboxFromRow(row));
            }),
          )
          .pipe(
            Effect.mapError(
              mapRepositoryError("claimNotification", "Could not claim a notification."),
            ),
          );

      const deliverInApp: HermesProactiveEventRepositoryShape["deliverInApp"] = (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const events = yield* sql<EventRow>`
              SELECT
                event.event_id,
                event.title,
                event.body,
                event.project_id,
                event.thread_id,
                event.occurred_at
              FROM hermes_notification_outbox AS outbox
              JOIN hermes_proactive_events AS event ON event.event_id = outbox.event_id
              WHERE outbox.outbox_id = ${input.outboxId}
                AND outbox.state = 'processing'
                AND outbox.lease_owner = ${input.workerId}
              LIMIT 1
            `;
              const event = events[0];
              if (event === undefined) return false;
              const workItemId = stableId("hermes-work", event.event_id);
              yield* sql`
              INSERT INTO hermes_proactive_work_items (
                work_item_id,
                event_id,
                project_id,
                thread_id,
                title,
                summary,
                status,
                occurred_at,
                created_at,
                updated_at
              )
              VALUES (
                ${workItemId},
                ${event.event_id},
                ${event.project_id},
                ${event.thread_id},
                ${event.title},
                ${event.body},
                'unread',
                ${event.occurred_at},
                ${input.now},
                ${input.now}
              )
              ON CONFLICT(event_id) DO NOTHING
            `;
              yield* sql`
              INSERT INTO hermes_in_app_notifications (
                notification_id,
                event_id,
                work_item_id,
                project_id,
                thread_id,
                title,
                body,
                status,
                created_at,
                updated_at
              )
              VALUES (
                ${stableId("hermes-notification", event.event_id)},
                ${event.event_id},
                ${workItemId},
                ${event.project_id},
                ${event.thread_id},
                ${event.title},
                ${event.body},
                'unread',
                ${input.now},
                ${input.now}
              )
              ON CONFLICT(event_id) DO NOTHING
            `;
              const delivered = yield* sql<{ outbox_id: string }>`
              UPDATE hermes_notification_outbox
              SET state = 'delivered',
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = ${input.now},
                  delivered_at = ${input.now}
              WHERE outbox_id = ${input.outboxId}
                AND state = 'processing'
                AND lease_owner = ${input.workerId}
                AND lease_expires_at > ${input.now}
              RETURNING outbox_id
            `;
              return delivered.length === 1;
            }),
          )
          .pipe(
            Effect.mapError(
              mapRepositoryError("deliverInApp", "Could not deliver the notification."),
            ),
          );

      const retryNotification: HermesProactiveEventRepositoryShape["retryNotification"] = (input) =>
        sql<{ outbox_id: string }>`
        UPDATE hermes_notification_outbox
        SET state = 'retry',
            available_at = ${input.availableAt},
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = ${input.errorCode},
            updated_at = ${input.now}
        WHERE outbox_id = ${input.outboxId}
          AND state = 'processing'
          AND lease_owner = ${input.workerId}
          AND lease_expires_at > ${input.now}
        RETURNING outbox_id
      `.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.mapError(mapRepositoryError("retryNotification", "Could not schedule the retry.")),
        );

      const deadLetterNotification: HermesProactiveEventRepositoryShape["deadLetterNotification"] =
        (input) =>
          sql<{ outbox_id: string }>`
        UPDATE hermes_notification_outbox
        SET state = 'dead_letter',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = ${input.errorCode},
            updated_at = ${input.now}
        WHERE outbox_id = ${input.outboxId}
          AND state = 'processing'
          AND lease_owner = ${input.workerId}
          AND lease_expires_at > ${input.now}
        RETURNING outbox_id
      `.pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.mapError(
              mapRepositoryError(
                "deadLetterNotification",
                "Could not dead-letter the notification.",
              ),
            ),
          );

      const listWorkItems: HermesProactiveEventRepositoryShape["listWorkItems"] = () =>
        sql<WorkItemRow>`
        SELECT *
        FROM hermes_proactive_work_items
        ORDER BY occurred_at DESC, work_item_id ASC
      `.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows,
              (row) =>
                decodeWorkItem({
                  workItemId: row.work_item_id,
                  eventId: row.event_id,
                  projectId: row.project_id,
                  threadId: row.thread_id,
                  title: row.title,
                  summary: row.summary,
                  status: row.status,
                  occurredAt: row.occurred_at,
                  createdAt: row.created_at,
                  updatedAt: row.updated_at,
                }),
              { concurrency: 1 },
            ),
          ),
          Effect.mapError(mapRepositoryError("listWorkItems", "Could not list work items.")),
        );

      const listInAppNotifications: HermesProactiveEventRepositoryShape["listInAppNotifications"] =
        () =>
          sql<NotificationRow>`
        SELECT *
        FROM hermes_in_app_notifications
        ORDER BY created_at DESC, notification_id ASC
      `.pipe(
            Effect.flatMap((rows) =>
              Effect.forEach(
                rows,
                (row) =>
                  decodeNotification({
                    notificationId: row.notification_id,
                    eventId: row.event_id,
                    workItemId: row.work_item_id,
                    projectId: row.project_id,
                    threadId: row.thread_id,
                    title: row.title,
                    body: row.body,
                    status: row.status,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                  }),
                { concurrency: 1 },
              ),
            ),
            Effect.mapError(
              mapRepositoryError("listInAppNotifications", "Could not list in-app notifications."),
            ),
          );

      return HermesProactiveEventRepository.of({
        registerSource,
        getSource,
        ingestPage,
        claimNotification,
        deliverInApp,
        retryNotification,
        deadLetterNotification,
        listWorkItems,
        listInAppNotifications,
      });
    }),
  );
