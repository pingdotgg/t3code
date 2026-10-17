// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Message ids/payload hashes and opaque cursor payloads are deliberate wire/storage boundaries.
import {
  CIVILIZATION_MAX_MESSAGE_BYTES,
  type CivilizationAdminMailPage,
  CivilizationAgentAccessError,
  CivilizationInboxCursor,
  type CivilizationInboxPage,
  type CivilizationMailAcknowledgeResult,
  type CivilizationMailBody,
  CivilizationMailCapacityError,
  CivilizationMailConflictError,
  CivilizationMailInvalidError,
  CivilizationMailNotFoundError,
  CivilizationMailQuotaError,
  CivilizationUnavailableError,
  type CivilizationMailReceiveResult,
  type CivilizationMailSendResult,
  type CivilizationMailSummary,
  CivilizationMessageId,
  type CivilizationMessageId as CivilizationMessageIdType,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { getEffectiveCivilizationConfig } from "./ConfigService.ts";
import { makeCivilizationDiagnostics } from "./Diagnostics.ts";
import { civilizationProviderCapability } from "./ProviderCapability.ts";

const CURSOR_VERSION = 1 as const;
const LIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

type MailTerminalReason =
  | "recipient_settled"
  | "recipient_archived"
  | "recipient_deleted"
  | "project_deleted"
  | "expired"
  | "purged";

type CitizenMailRow = {
  readonly thread_id: ThreadId;
  readonly project_id: ProjectId;
  readonly parent_thread_id: ThreadId | null;
  readonly relationship_to_parent: "fork" | "subagent" | null;
  readonly observed_only: number;
  readonly name_display: string;
  readonly epoch: number;
  readonly closed: number;
  readonly deleted: number;
  readonly delivery_epoch: number;
  readonly delivery_settled: number;
  readonly delivery_archived: number;
  readonly delivery_deleted: number;
};

type ThreadMailRow = {
  readonly thread_id: ThreadId;
  readonly project_id: ProjectId;
  readonly provider_instance_id: ProviderInstanceId | null;
  readonly runtime_mode: RuntimeMode;
  readonly interaction_mode: ProviderInteractionMode;
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
};

type FreshRunProjectRow = {
  readonly project_open: number;
  readonly run_id: RunId | null;
  readonly thread_id: ThreadId | null;
  readonly provider_instance_id: ProviderInstanceId | null;
  readonly status: string | null;
};

type PrincipalRow = {
  readonly citizen_thread_id: ThreadId;
  readonly citizen_project_id: ProjectId;
  readonly parent_thread_id: ThreadId | null;
  readonly relationship_to_parent: "fork" | "subagent" | null;
  readonly observed_only: number;
  readonly name_display: string;
  readonly epoch: number;
  readonly closed: number;
  readonly deleted: number;
  readonly delivery_epoch: number;
  readonly delivery_settled: number;
  readonly delivery_archived: number;
  readonly delivery_deleted: number;
  readonly projection_thread_id: ThreadId;
  readonly projection_project_id: ProjectId;
  readonly provider_instance_id: ProviderInstanceId | null;
  readonly runtime_mode: RuntimeMode;
  readonly interaction_mode: ProviderInteractionMode;
  readonly archived_at: string | null;
  readonly projection_deleted_at: string | null;
};

type ProjectStateRow = {
  readonly mail_revision: number;
  readonly retained_message_count: number;
  readonly retained_body_bytes: number;
};

type MessageRow = {
  readonly message_id: string;
  readonly project_id: ProjectId;
  readonly sender_thread_id: ThreadId;
  readonly sender_name_at_send: string;
  readonly sender_citizen_epoch: number;
  readonly sender_run_id: RunId;
  readonly recipient_thread_id: ThreadId;
  readonly recipient_delivery_epoch: number;
  readonly reply_to_message_id: string | null;
  readonly body: string;
  readonly body_bytes: number;
  readonly accepted_runtime_mode: RuntimeMode;
  readonly accepted_interaction_mode: ProviderInteractionMode;
  readonly accepted_environment_revision: number;
  readonly accepted_project_revision: number;
  readonly accepted_at: string;
  readonly expires_at: string;
  readonly terminal_retention_days: number;
  readonly first_offered_at: string | null;
  readonly last_offered_at: string | null;
  readonly offer_count: number;
  readonly acknowledged_at: string | null;
  readonly terminal_at: string | null;
  readonly terminal_reason: MailTerminalReason | null;
};

type ReceiptRow = {
  readonly project_id: ProjectId;
  readonly actor_thread_id: ThreadId;
  readonly actor_citizen_epoch: number;
  readonly operation_kind: "send" | "receive" | "acknowledge";
  readonly client_request_id: string;
  readonly canonical_payload_hash: string;
  readonly result_message_id: string;
  readonly created_at: string;
  readonly expires_at: string;
};

type TimeRow = {
  readonly now: string;
  readonly minute_start: string;
  readonly retry_at: string;
};

interface InboxCursorPayload {
  readonly v: 1;
  readonly kind: "inbox";
  readonly projectId: ProjectId;
  readonly recipientThreadId: ThreadId;
  readonly revision: number;
  readonly deliveryEpoch: number;
  readonly includeAcknowledged: boolean;
  readonly afterAcceptedAt: string;
  readonly afterMessageId: string;
}

interface AdminInboxCursorPayload {
  readonly v: 1;
  readonly kind: "admin_inbox";
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly afterAcceptedAt: string;
  readonly afterMessageId: string;
}

export interface CivilizationMailCaller {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly citizenEpoch: number;
  readonly deliveryEpoch: number;
  readonly runId: RunId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface CivilizationMailCallerInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface CivilizationMailContextCandidate {
  readonly message: CivilizationMailBody;
}

const invalid = (
  reason: ConstructorParameters<typeof CivilizationMailInvalidError>[0]["reason"],
  message: string,
) => new CivilizationMailInvalidError({ code: "civilization_mail_invalid", reason, message });

const denied = (
  reason: ConstructorParameters<typeof CivilizationAgentAccessError>[0]["reason"],
  message: string,
) =>
  new CivilizationAgentAccessError({
    code: "civilization_agent_access_denied",
    reason,
    message,
  });

const isMailInvalid = Schema.is(CivilizationMailInvalidError);
const mailSync = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      isMailInvalid(cause)
        ? cause
        : invalid("invalid_message", "Civilization mail validation failed."),
  });

const mailStorageUnavailable = () =>
  new CivilizationUnavailableError({
    code: "civilization_unavailable",
    reason: "storage",
    message: "Civilization mail storage is unavailable.",
  });

const utf8Length = (value: string) => Buffer.byteLength(value, "utf8");
const responseBytes = (value: unknown) => utf8Length(JSON.stringify(value));

const unsafeText = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

const validateClientRequestId = (value: string) => {
  if (value.trim().length === 0 || utf8Length(value) > 1024 || unsafeText(value)) {
    throw invalid(
      "invalid_message",
      "clientRequestId is empty, too large, or contains unsafe formatting.",
    );
  }
  return value;
};

const validateBody = (body: string, configuredBytes: number) => {
  if (body.trim().length === 0 || unsafeText(body)) {
    throw invalid(
      "invalid_message",
      "A Civilization mail body must be non-empty safely encoded text.",
    );
  }
  const bytes = utf8Length(body);
  const limit = Math.min(configuredBytes, CIVILIZATION_MAX_MESSAGE_BYTES);
  if (bytes > limit) {
    throw invalid(
      "message_too_large",
      `Civilization mail body exceeds the configured ${configuredBytes} UTF-8 byte limit.`,
    );
  }
  return bytes;
};

const payloadHash = (value: unknown) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;

const newMessageId = () => CivilizationMessageId.make(`mail:${NodeCrypto.randomUUID()}`);

const messageSummary = (row: MessageRow): CivilizationMailSummary => ({
  messageId: CivilizationMessageId.make(row.message_id),
  senderThreadId: row.sender_thread_id,
  senderNameAtSend: row.sender_name_at_send,
  senderCitizenEpoch: row.sender_citizen_epoch,
  senderRunId: row.sender_run_id,
  recipientThreadId: row.recipient_thread_id,
  recipientDeliveryEpoch: row.recipient_delivery_epoch,
  replyToMessageId:
    row.reply_to_message_id === null ? null : CivilizationMessageId.make(row.reply_to_message_id),
  bodyBytes: row.body_bytes,
  acceptedRuntimeMode: row.accepted_runtime_mode,
  acceptedInteractionMode: row.accepted_interaction_mode,
  acceptedEnvironmentRevision: row.accepted_environment_revision,
  acceptedProjectRevision: row.accepted_project_revision,
  acceptedAt: row.accepted_at,
  expiresAt: row.expires_at,
  terminalRetentionDays: row.terminal_retention_days,
  firstOfferedAt: row.first_offered_at,
  lastOfferedAt: row.last_offered_at,
  offerCount: row.offer_count,
  acknowledgedAt: row.acknowledged_at,
  terminalAt: row.terminal_at,
  terminalReason: row.terminal_reason,
});

const messageBody = (row: MessageRow): CivilizationMailBody => ({
  ...messageSummary(row),
  body: row.body,
});

const encodeInboxCursor = (payload: Omit<InboxCursorPayload, "v" | "kind">) =>
  CivilizationInboxCursor.make(
    Buffer.from(JSON.stringify({ v: CURSOR_VERSION, kind: "inbox", ...payload }), "utf8").toString(
      "base64url",
    ),
  );

const decodeInboxCursor = (
  cursor: string | undefined,
  expected: Pick<
    InboxCursorPayload,
    "projectId" | "recipientThreadId" | "revision" | "deliveryEpoch" | "includeAcknowledged"
  >,
): InboxCursorPayload | undefined => {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== cursor) throw new Error("cursor");
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<InboxCursorPayload>;
    if (
      parsed.v !== CURSOR_VERSION ||
      parsed.kind !== "inbox" ||
      parsed.projectId !== expected.projectId ||
      parsed.recipientThreadId !== expected.recipientThreadId ||
      parsed.revision !== expected.revision ||
      parsed.deliveryEpoch !== expected.deliveryEpoch ||
      parsed.includeAcknowledged !== expected.includeAcknowledged ||
      typeof parsed.afterAcceptedAt !== "string" ||
      typeof parsed.afterMessageId !== "string"
    ) {
      throw new Error("cursor mismatch");
    }
    return parsed as InboxCursorPayload;
  } catch {
    throw invalid("invalid_cursor", "The Civilization inbox cursor is invalid or stale.");
  }
};

const encodeAdminInboxCursor = (payload: Omit<AdminInboxCursorPayload, "v" | "kind">) =>
  CivilizationInboxCursor.make(
    Buffer.from(
      JSON.stringify({ v: CURSOR_VERSION, kind: "admin_inbox", ...payload }),
      "utf8",
    ).toString("base64url"),
  );

const decodeAdminInboxCursor = (
  cursor: string | undefined,
  expected: Pick<AdminInboxCursorPayload, "projectId" | "revision">,
): AdminInboxCursorPayload | undefined => {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== cursor) throw new Error("cursor");
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<AdminInboxCursorPayload>;
    if (
      parsed.v !== CURSOR_VERSION ||
      parsed.kind !== "admin_inbox" ||
      parsed.projectId !== expected.projectId ||
      parsed.revision !== expected.revision ||
      typeof parsed.afterAcceptedAt !== "string" ||
      typeof parsed.afterMessageId !== "string"
    ) {
      throw new Error("cursor mismatch");
    }
    return parsed as AdminInboxCursorPayload;
  } catch {
    throw invalid(
      "invalid_cursor",
      "The Civilization administrative inbox cursor is invalid or stale.",
    );
  }
};

const threadKind = (citizen: CitizenMailRow): "root" | "fork" | "subagent" | undefined =>
  citizen.parent_thread_id === null
    ? "root"
    : citizen.relationship_to_parent === "fork" || citizen.relationship_to_parent === "subagent"
      ? citizen.relationship_to_parent
      : undefined;

const assertMessagingRelationship = (
  citizen: CitizenMailRow,
  config: {
    readonly eligibleThreadKinds: ReadonlyArray<"root" | "fork" | "subagent">;
    readonly allowControllableChildren: boolean;
  },
) => {
  const kind = threadKind(citizen);
  if (
    kind === undefined ||
    !config.eligibleThreadKinds.includes(kind) ||
    (kind !== "root" && !config.allowControllableChildren)
  ) {
    return Effect.fail(
      denied("forbidden", "This citizen kind is not eligible for Civilization messaging."),
    );
  }
  return Effect.void;
};

const currentTime = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const row = (yield* sql<TimeRow>`
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
               strftime('%Y-%m-%dT%H:%M:00Z', 'now') AS minute_start,
               strftime('%Y-%m-%dT%H:%M:00Z', 'now', '+1 minute') AS retry_at
      `)[0];
    if (row === undefined) return yield* Effect.die("SQLite did not return a current timestamp.");
    return row;
  });

const currentQuotaTime = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const nowMs = DateTime.toEpochMillis(now);
  const minuteStart = DateTime.makeUnsafe(Math.floor(nowMs / 60_000) * 60_000);
  return {
    now: DateTime.formatIso(now),
    minute_start: DateTime.formatIso(minuteStart),
    retry_at: DateTime.formatIso(DateTime.add(minuteStart, { minutes: 1 })),
  } satisfies TimeRow;
});

const selectMessage = (sql: SqlClient.SqlClient, projectId: ProjectId, messageId: string) =>
  Effect.gen(function* () {
    return (yield* sql<MessageRow>`
        SELECT message_id, project_id, sender_thread_id, sender_name_at_send,
               sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
               reply_to_message_id, body, body_bytes, accepted_runtime_mode,
               accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
               accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
               offer_count, acknowledged_at, terminal_at, terminal_reason
        FROM civilization_messages
        WHERE project_id = ${projectId} AND message_id = ${messageId}
        LIMIT 1
      `)[0];
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const diagnostics = yield* makeCivilizationDiagnostics((projectId) =>
    getEffectiveCivilizationConfig(projectId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  );

  const providerMessagingCapability = Effect.fn("CivilizationMail.providerCapability")(function* (
    providerInstanceId: ProviderInstanceId,
    observedOnly: boolean,
  ) {
    return yield* adapters.get(providerInstanceId).pipe(
      Effect.map((adapter) =>
        civilizationProviderCapability({
          providerInstanceId,
          driver: adapter.driver,
          observedOnly,
        }),
      ),
      Effect.catch(() =>
        Effect.fail(
          denied(
            "unsupported_provider",
            "The selected provider is not available for Civilization messaging.",
          ),
        ),
      ),
    );
  });

  const readCitizen = Effect.fn("CivilizationMail.readCitizen")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    return (yield* sql<CitizenMailRow>`
        SELECT thread_id, project_id, parent_thread_id, relationship_to_parent, observed_only,
               name_display, epoch, closed, deleted, delivery_epoch, delivery_settled,
               delivery_archived, delivery_deleted
        FROM civilization_citizens
        WHERE project_id = ${projectId} AND thread_id = ${threadId}
        LIMIT 1
      `)[0];
  });

  const readThread = Effect.fn("CivilizationMail.readThread")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    return (yield* sql<ThreadMailRow>`
        SELECT thread_id, project_id, provider_instance_id, runtime_mode, interaction_mode,
               archived_at, deleted_at
        FROM orchestration_v2_projection_threads
        WHERE project_id = ${projectId} AND thread_id = ${threadId}
        LIMIT 1
      `)[0];
  });

  const assertBasePrincipal = Effect.fn("CivilizationMail.assertBasePrincipal")(function* (
    caller: Pick<CivilizationMailCallerInput, "projectId" | "threadId">,
  ) {
    const row = (yield* sql<PrincipalRow>`
        SELECT c.thread_id AS citizen_thread_id, c.project_id AS citizen_project_id,
               c.parent_thread_id, c.relationship_to_parent, c.observed_only, c.name_display,
               c.epoch, c.closed, c.deleted, c.delivery_epoch, c.delivery_settled,
               c.delivery_archived, c.delivery_deleted,
               t.thread_id AS projection_thread_id, t.project_id AS projection_project_id,
               t.provider_instance_id, t.runtime_mode, t.interaction_mode,
               t.archived_at, t.deleted_at AS projection_deleted_at
        FROM civilization_citizens c
        JOIN orchestration_v2_projection_threads t
          ON t.thread_id = c.thread_id AND t.project_id = c.project_id
        WHERE c.project_id = ${caller.projectId} AND c.thread_id = ${caller.threadId}
        LIMIT 1
      `)[0];
    if (row === undefined) {
      return yield* denied(
        "unadopted",
        "The calling thread is not an enrolled Civilization citizen.",
      );
    }
    const citizen: CitizenMailRow = {
      thread_id: row.citizen_thread_id,
      project_id: row.citizen_project_id,
      parent_thread_id: row.parent_thread_id,
      relationship_to_parent: row.relationship_to_parent,
      observed_only: row.observed_only,
      name_display: row.name_display,
      epoch: row.epoch,
      closed: row.closed,
      deleted: row.deleted,
      delivery_epoch: row.delivery_epoch,
      delivery_settled: row.delivery_settled,
      delivery_archived: row.delivery_archived,
      delivery_deleted: row.delivery_deleted,
    };
    const thread: ThreadMailRow = {
      thread_id: row.projection_thread_id,
      project_id: row.projection_project_id,
      provider_instance_id: row.provider_instance_id,
      runtime_mode: row.runtime_mode,
      interaction_mode: row.interaction_mode,
      archived_at: row.archived_at,
      deleted_at: row.projection_deleted_at,
    };
    return { citizen, thread } as const;
  });

  const readReceipt = Effect.fn("CivilizationMail.readReceipt")(function* (input: {
    readonly projectId: ProjectId;
    readonly actorThreadId: ThreadId;
    readonly clientRequestId: string;
  }) {
    return (yield* sql<ReceiptRow>`
        SELECT project_id, actor_thread_id, actor_citizen_epoch, operation_kind,
               client_request_id, canonical_payload_hash, result_message_id, created_at, expires_at
        FROM civilization_mail_operation_receipts
        WHERE project_id = ${input.projectId}
          AND actor_thread_id = ${input.actorThreadId}
          AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `)[0];
  });

  const resolveReceipt = Effect.fn("CivilizationMail.resolveReceipt")(function* (input: {
    readonly receipt: ReceiptRow;
    readonly operationKind: ReceiptRow["operation_kind"];
    readonly payloadHash: string;
  }) {
    if (
      input.receipt.operation_kind !== input.operationKind ||
      input.receipt.canonical_payload_hash !== input.payloadHash
    ) {
      return yield* new CivilizationMailConflictError({
        code: "civilization_mail_conflict",
        reason: "idempotency_conflict",
        message:
          "This Civilization mail clientRequestId was already used for a different mutation.",
      });
    }
    return CivilizationMessageId.make(input.receipt.result_message_id);
  });

  const assertFreshCaller = Effect.fn("CivilizationMail.assertFreshCaller")(function* (
    caller: CivilizationMailCaller,
    effective: Effect.Success<ReturnType<typeof getEffectiveCivilizationConfig>>,
    preloaded?: Effect.Success<ReturnType<typeof assertBasePrincipal>>,
  ) {
    if (!effective.config.participation.enabled || effective.config.participation.emergencyOff) {
      return yield* denied("disabled", "Civilization is disabled for this project.");
    }
    if (!effective.config.messaging.enabled) {
      return yield* denied("disabled", "Civilization messaging is disabled for this project.");
    }
    const { citizen, thread } = preloaded ?? (yield* assertBasePrincipal(caller));
    const freshState = (yield* sql<FreshRunProjectRow>`
        SELECT CASE WHEN p.project_id IS NULL THEN 0 ELSE 1 END AS project_open,
               r.run_id, r.thread_id, r.provider_instance_id, r.status
        FROM (SELECT 1) seed
        LEFT JOIN projection_projects p
          ON p.project_id = ${caller.projectId} AND p.deleted_at IS NULL
        LEFT JOIN orchestration_v2_projection_runs r
          ON r.run_id = ${caller.runId} AND r.thread_id = ${caller.threadId}
        LIMIT 1
      `)[0]!;
    if (freshState.project_open !== 1) {
      return yield* denied("unadopted", "The calling citizen or project is not available.");
    }
    if (citizen.deleted === 1 || citizen.delivery_deleted === 1 || thread.deleted_at !== null) {
      return yield* denied("deleted_citizen", "The calling Civilization citizen is deleted.");
    }
    if (citizen.observed_only === 1) {
      return yield* denied(
        "observed_agent_read_only",
        "Provider-owned observed agents cannot send or receive Civilization mail.",
      );
    }
    if (
      citizen.closed === 1 ||
      citizen.delivery_settled === 1 ||
      citizen.delivery_archived === 1 ||
      thread.archived_at !== null
    ) {
      return yield* denied("closed_citizen", "The calling Civilization citizen is closed.");
    }
    if (citizen.epoch !== caller.citizenEpoch || citizen.delivery_epoch !== caller.deliveryEpoch) {
      return yield* denied("stale_epoch", "The calling Civilization lifecycle epoch changed.");
    }
    if (
      freshState.run_id === null ||
      freshState.status === null ||
      !LIVE_RUN_STATUSES.has(freshState.status) ||
      freshState.provider_instance_id !== caller.providerInstanceId ||
      thread.provider_instance_id !== caller.providerInstanceId
    ) {
      return yield* denied("stale_run", "The calling provider no longer owns this live run.");
    }
    if (
      exceededDispatchModeLimit(
        { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode },
        { runtimeMode: thread.runtime_mode, interactionMode: thread.interaction_mode },
      ) !== undefined
    ) {
      return yield* denied(
        "forbidden",
        "The calling thread's permission ceiling changed during the operation.",
      );
    }
    yield* assertMessagingRelationship(citizen, effective.config.messaging);
    return {
      citizen,
      thread,
      runtimeMode: thread.runtime_mode,
      interactionMode: thread.interaction_mode,
    } as const;
  });

  const authoritativeCaller = Effect.fn("CivilizationMail.authoritativeCaller")(function* (
    input: CivilizationMailCallerInput,
  ) {
    const effective = yield* getEffectiveCivilizationConfig(input.projectId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const base = yield* assertBasePrincipal(input);
    if (base.citizen.observed_only === 1) {
      return yield* denied(
        "observed_agent_read_only",
        "Provider-owned observed agents cannot use Civilization mail.",
      );
    }
    const capability = yield* providerMessagingCapability(input.providerInstanceId, false);
    if (!capability.messaging) {
      return yield* denied(
        "unsupported_provider",
        "The calling provider is not supported for Civilization messaging.",
      );
    }
    const provisional: CivilizationMailCaller = {
      threadId: input.threadId,
      projectId: input.projectId,
      citizenEpoch: base.citizen.epoch,
      deliveryEpoch: base.citizen.delivery_epoch,
      runId: input.runId,
      providerInstanceId: input.providerInstanceId,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
    };
    const fresh = yield* assertFreshCaller(provisional, effective, base);
    return {
      ...provisional,
      runtimeMode: fresh.runtimeMode,
      interactionMode: fresh.interactionMode,
    } satisfies CivilizationMailCaller;
  });

  const receiptExpiry = (days: number) => `+${days} days`;

  const insertReceipt = Effect.fn("CivilizationMail.insertReceipt")(function* (input: {
    readonly caller: CivilizationMailCaller;
    readonly kind: ReceiptRow["operation_kind"];
    readonly clientRequestId: string;
    readonly canonicalPayloadHash: string;
    readonly resultMessageId: CivilizationMessageIdType;
    readonly now: string;
    readonly retentionDays: number;
  }) {
    yield* sql`
      INSERT INTO civilization_mail_operation_receipts (
        project_id, actor_thread_id, actor_citizen_epoch, operation_kind,
        client_request_id, canonical_payload_hash, result_message_id,
        created_at, expires_at
      ) VALUES (
        ${input.caller.projectId}, ${input.caller.threadId}, ${input.caller.citizenEpoch}, ${input.kind},
        ${input.clientRequestId}, ${input.canonicalPayloadHash}, ${input.resultMessageId},
        ${input.now}, strftime('%Y-%m-%dT%H:%M:%fZ', ${input.now}, ${receiptExpiry(input.retentionDays)})
      )
    `;
  });

  const incrementQuota = Effect.fn("CivilizationMail.incrementQuota")(function* (input: {
    readonly projectId: ProjectId;
    readonly senderThreadId: ThreadId;
    readonly scope: "sender" | "project";
    readonly minuteStart: string;
    readonly retryAt: string;
    readonly limit: number;
  }) {
    const scopeId = input.scope === "sender" ? input.senderThreadId : input.projectId;
    const existing =
      (yield* sql<{ readonly accepted_count: number }>`
        SELECT accepted_count
        FROM civilization_mail_quota_windows
        WHERE project_id = ${input.projectId}
          AND scope_kind = ${input.scope}
          AND scope_id = ${scopeId}
          AND window_start_minute = ${input.minuteStart}
        LIMIT 1
      `)[0]?.accepted_count ?? 0;
    if (existing >= input.limit) {
      return yield* new CivilizationMailQuotaError({
        code: "civilization_mail_quota",
        scope: input.scope,
        limit: input.limit,
        retryAt: input.retryAt,
      });
    }
    yield* sql`
      INSERT INTO civilization_mail_quota_windows (
        project_id, scope_kind, scope_id, window_start_minute, accepted_count, updated_at
      ) VALUES (
        ${input.projectId}, ${input.scope}, ${scopeId}, ${input.minuteStart}, 1, ${input.minuteStart}
      )
      ON CONFLICT(project_id, scope_kind, scope_id, window_start_minute)
      DO UPDATE SET accepted_count = accepted_count + 1, updated_at = excluded.updated_at
    `;
  });

  const send = Effect.fn("CivilizationMail.send")(function* (input: {
    readonly caller: CivilizationMailCaller;
    readonly targetThreadId: ThreadId;
    readonly clientRequestId: string;
    readonly body: string;
    readonly replyToMessageId?: CivilizationMessageIdType;
  }) {
    const validated = yield* mailSync(() => ({
      clientRequestId: validateClientRequestId(input.clientRequestId),
      canonicalPayloadHash: payloadHash({
        targetThreadId: input.targetThreadId,
        body: input.body,
        replyToMessageId: input.replyToMessageId ?? null,
      }),
    }));

    // An accepted operation may be reconciled after lifecycle/provider changes.
    // Re-check only that the authenticated principal still names the same host
    // project/thread before revealing its durable receipt.
    yield* assertBasePrincipal(input.caller);
    const prior = yield* readReceipt({
      projectId: input.caller.projectId,
      actorThreadId: input.caller.threadId,
      clientRequestId: validated.clientRequestId,
    });
    if (prior !== undefined) {
      const messageId = yield* resolveReceipt({
        receipt: prior,
        operationKind: "send",
        payloadHash: validated.canonicalPayloadHash,
      });
      const row = yield* selectMessage(sql, input.caller.projectId, messageId);
      if (row === undefined) {
        return yield* new CivilizationMailNotFoundError({
          code: "civilization_mail_not_found",
          messageId,
        });
      }
      return { message: messageSummary(row) } satisfies CivilizationMailSendResult;
    }

    if (input.targetThreadId === input.caller.threadId) {
      return yield* invalid("self_send", "Civilization citizens cannot send mail to themselves.");
    }

    const preliminaryTargetCitizen = yield* readCitizen(
      input.caller.projectId,
      input.targetThreadId,
    );
    const preliminaryTargetThread = yield* readThread(input.caller.projectId, input.targetThreadId);
    if (
      preliminaryTargetCitizen === undefined ||
      preliminaryTargetThread === undefined ||
      preliminaryTargetThread.provider_instance_id === null
    ) {
      return yield* denied(
        "forbidden",
        "The target is not an eligible same-project Civilization citizen.",
      );
    }
    if (preliminaryTargetCitizen.observed_only === 1) {
      return yield* denied(
        "observed_agent_read_only",
        "Provider-owned observed agents cannot receive Civilization mail.",
      );
    }
    const targetProviderInstanceId = preliminaryTargetThread.provider_instance_id;
    const targetCapability = yield* providerMessagingCapability(
      targetProviderInstanceId,
      preliminaryTargetCitizen.observed_only === 1,
    );
    if (!targetCapability.messaging) {
      return yield* denied(
        "unsupported_provider",
        "The target provider is not supported for Civilization messaging.",
      );
    }

    const messageId = newMessageId();
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Serialize duplicate in-flight clientRequestIds at the writer boundary.
          const concurrentReceipt = yield* readReceipt({
            projectId: input.caller.projectId,
            actorThreadId: input.caller.threadId,
            clientRequestId: validated.clientRequestId,
          });
          if (concurrentReceipt !== undefined) {
            const existingMessageId = yield* resolveReceipt({
              receipt: concurrentReceipt,
              operationKind: "send",
              payloadHash: validated.canonicalPayloadHash,
            });
            const existing = yield* selectMessage(sql, input.caller.projectId, existingMessageId);
            if (existing === undefined) {
              return yield* new CivilizationMailNotFoundError({
                code: "civilization_mail_not_found",
                messageId: existingMessageId,
              });
            }
            return { message: messageSummary(existing) } satisfies CivilizationMailSendResult;
          }

          const effective = yield* getEffectiveCivilizationConfig(input.caller.projectId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const freshCaller = yield* assertFreshCaller(input.caller, effective);
          const bodyBytes = yield* mailSync(() =>
            validateBody(input.body, effective.config.messaging.messageBytes),
          );
          const targetCitizen = yield* readCitizen(input.caller.projectId, input.targetThreadId);
          const targetThread = yield* readThread(input.caller.projectId, input.targetThreadId);
          if (
            targetCitizen === undefined ||
            targetThread === undefined ||
            targetThread.provider_instance_id !== targetProviderInstanceId
          ) {
            return yield* denied(
              "forbidden",
              "The target changed before Civilization mail acceptance; retry with current state.",
            );
          }
          if (targetCitizen.observed_only === 1) {
            return yield* denied(
              "observed_agent_read_only",
              "Provider-owned observed agents cannot receive Civilization mail.",
            );
          }
          if (
            targetCitizen.deleted === 1 ||
            targetCitizen.delivery_deleted === 1 ||
            targetThread.deleted_at !== null
          ) {
            return yield* denied("deleted_citizen", "The target Civilization citizen is deleted.");
          }
          if (
            targetCitizen.closed === 1 ||
            targetCitizen.delivery_settled === 1 ||
            targetCitizen.delivery_archived === 1 ||
            targetThread.archived_at !== null
          ) {
            return yield* denied("closed_citizen", "The target Civilization citizen is closed.");
          }
          yield* assertMessagingRelationship(targetCitizen, effective.config.messaging);
          if (
            exceededDispatchModeLimit(
              {
                runtimeMode: freshCaller.runtimeMode,
                interactionMode: freshCaller.interactionMode,
              },
              {
                runtimeMode: targetThread.runtime_mode,
                interactionMode: targetThread.interaction_mode,
              },
            ) !== undefined
          ) {
            return yield* denied(
              "forbidden",
              "The target thread runs above the sender's current permission ceiling.",
            );
          }

          if (input.replyToMessageId !== undefined) {
            if (!effective.config.messaging.repliesEnabled) {
              return yield* invalid("invalid_reply", "Civilization mail replies are disabled.");
            }
            const parent = yield* selectMessage(
              sql,
              input.caller.projectId,
              input.replyToMessageId,
            );
            if (
              parent === undefined ||
              parent.terminal_at !== null ||
              parent.expires_at <= (yield* currentTime(sql)).now
            ) {
              return yield* invalid(
                "invalid_reply",
                "The referenced Civilization correspondence is not accessible.",
              );
            }
            const callerWasSender = parent.sender_thread_id === input.caller.threadId;
            const callerWasRecipient = parent.recipient_thread_id === input.caller.threadId;
            if (!callerWasSender && !callerWasRecipient) {
              return yield* invalid(
                "invalid_reply",
                "The referenced message does not belong to this correspondence.",
              );
            }
            const expectedTarget = callerWasSender
              ? parent.recipient_thread_id
              : parent.sender_thread_id;
            if (expectedTarget !== input.targetThreadId) {
              return yield* invalid(
                "invalid_reply",
                "A reply must target the other participant in the correspondence.",
              );
            }
            if (
              (callerWasSender && parent.sender_citizen_epoch !== input.caller.citizenEpoch) ||
              (callerWasRecipient &&
                parent.recipient_delivery_epoch !== input.caller.deliveryEpoch) ||
              (callerWasSender &&
                parent.recipient_delivery_epoch !== targetCitizen.delivery_epoch) ||
              (callerWasRecipient && parent.sender_citizen_epoch !== targetCitizen.epoch)
            ) {
              return yield* invalid(
                "invalid_reply",
                "The referenced correspondence belongs to an older lifecycle epoch.",
              );
            }
          }

          const time = yield* currentTime(sql);
          const quotaTime = yield* currentQuotaTime;
          // Expired unacknowledged deliveries stop consuming recipient pending
          // capacity immediately; retained-storage capacity is intentionally not
          // freed until physical retention cleanup deletes the row.
          yield* sql`
          UPDATE civilization_messages
          SET terminal_at = ${time.now}, terminal_reason = 'expired'
          WHERE project_id = ${input.caller.projectId}
            AND recipient_thread_id = ${input.targetThreadId}
            AND recipient_delivery_epoch = ${targetCitizen.delivery_epoch}
            AND terminal_at IS NULL AND acknowledged_at IS NULL
            AND expires_at <= ${time.now}
        `;

          const pending =
            (yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM civilization_messages
            WHERE project_id = ${input.caller.projectId}
              AND recipient_thread_id = ${input.targetThreadId}
              AND recipient_delivery_epoch = ${targetCitizen.delivery_epoch}
              AND terminal_at IS NULL AND acknowledged_at IS NULL
          `)[0]?.count ?? 0;
          if (pending >= effective.config.messaging.pendingPerRecipient) {
            return yield* new CivilizationMailCapacityError({
              code: "civilization_mail_capacity",
              scope: "recipient_pending",
              limit: effective.config.messaging.pendingPerRecipient,
              current: pending,
            });
          }
          const state = (yield* sql<ProjectStateRow>`
            SELECT mail_revision, retained_message_count, retained_body_bytes
            FROM civilization_project_state
            WHERE project_id = ${input.caller.projectId}
            LIMIT 1
          `)[0] ?? { mail_revision: 0, retained_message_count: 0, retained_body_bytes: 0 };
          if (state.retained_message_count >= effective.config.messaging.retainedMessageCount) {
            return yield* new CivilizationMailCapacityError({
              code: "civilization_mail_capacity",
              scope: "project_message_count",
              limit: effective.config.messaging.retainedMessageCount,
              current: state.retained_message_count,
            });
          }
          if (
            state.retained_body_bytes + bodyBytes >
            effective.config.messaging.retainedBodyBytes
          ) {
            return yield* new CivilizationMailCapacityError({
              code: "civilization_mail_capacity",
              scope: "project_body_bytes",
              limit: effective.config.messaging.retainedBodyBytes,
              current: state.retained_body_bytes,
            });
          }
          yield* incrementQuota({
            projectId: input.caller.projectId,
            senderThreadId: input.caller.threadId,
            scope: "sender",
            minuteStart: quotaTime.minute_start,
            retryAt: quotaTime.retry_at,
            limit: effective.config.messaging.senderPerMinute,
          });
          yield* incrementQuota({
            projectId: input.caller.projectId,
            senderThreadId: input.caller.threadId,
            scope: "project",
            minuteStart: quotaTime.minute_start,
            retryAt: quotaTime.retry_at,
            limit: effective.config.messaging.projectPerMinute,
          });

          const ttlModifier = `+${effective.config.messaging.unreadTtlDays} days`;
          yield* sql`
          INSERT INTO civilization_messages (
            message_id, project_id, sender_thread_id, sender_name_at_send,
            sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
            reply_to_message_id, body, body_bytes,
            accepted_runtime_mode, accepted_interaction_mode,
            accepted_environment_revision, accepted_project_revision,
            accepted_at, expires_at, terminal_retention_days,
            first_offered_at, last_offered_at, offer_count,
            acknowledged_at, terminal_at, terminal_reason
          ) VALUES (
            ${messageId}, ${input.caller.projectId}, ${input.caller.threadId}, ${freshCaller.citizen.name_display},
            ${input.caller.citizenEpoch}, ${input.caller.runId}, ${input.targetThreadId}, ${targetCitizen.delivery_epoch},
            ${input.replyToMessageId ?? null}, ${input.body}, ${bodyBytes},
            ${freshCaller.runtimeMode}, ${freshCaller.interactionMode},
            ${effective.environmentRevision}, ${effective.projectRevision},
            ${time.now}, strftime('%Y-%m-%dT%H:%M:%fZ', ${time.now}, ${ttlModifier}),
            ${effective.config.operations.terminalRetentionDays},
            NULL, NULL, 0, NULL, NULL, NULL
          )
        `;
          yield* insertReceipt({
            caller: input.caller,
            kind: "send",
            clientRequestId: validated.clientRequestId,
            canonicalPayloadHash: validated.canonicalPayloadHash,
            resultMessageId: messageId,
            now: time.now,
            retentionDays: effective.config.operations.operationReceiptRetentionDays,
          });
          const accepted = yield* selectMessage(sql, input.caller.projectId, messageId);
          if (accepted === undefined)
            return yield* Effect.die("Accepted Civilization mail vanished.");
          return { message: messageSummary(accepted) } satisfies CivilizationMailSendResult;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: () =>
            Effect.gen(function* () {
              yield* diagnostics.emit({
                projectId: input.caller.projectId,
                event: "civilization.mail.storage-unavailable",
                severity: "error",
                fields: {
                  threadId: input.caller.threadId,
                  runId: input.caller.runId,
                  bytes: utf8Length(input.body),
                  rejectionCode: "storage",
                },
              });
              return yield* mailStorageUnavailable();
            }),
        }),
      );
  });

  const listInbox = Effect.fn("CivilizationMail.listInbox")(function* (input: {
    readonly caller: CivilizationMailCaller;
    readonly cursor?: string;
    readonly limit?: number;
    readonly includeAcknowledged?: boolean;
  }) {
    const effective = yield* getEffectiveCivilizationConfig(input.caller.projectId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    yield* assertFreshCaller(input.caller, effective);
    const includeAcknowledged = input.includeAcknowledged ?? true;
    const limit = yield* mailSync(() => {
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
        throw invalid(
          "invalid_cursor",
          "Civilization inbox page limit must be a positive integer.",
        );
      }
      return Math.min(
        input.limit ?? effective.config.operations.inboxPageSize,
        effective.config.operations.inboxPageSize,
      );
    });
    const state = (yield* sql<ProjectStateRow>`
        SELECT mail_revision, retained_message_count, retained_body_bytes
        FROM civilization_project_state WHERE project_id = ${input.caller.projectId} LIMIT 1
      `)[0] ?? { mail_revision: 0, retained_message_count: 0, retained_body_bytes: 0 };
    const cursor = yield* mailSync(() =>
      decodeInboxCursor(input.cursor, {
        projectId: input.caller.projectId,
        recipientThreadId: input.caller.threadId,
        revision: state.mail_revision,
        deliveryEpoch: input.caller.deliveryEpoch,
        includeAcknowledged,
      }),
    );
    const time = yield* currentTime(sql);
    const rows = yield* sql<MessageRow>`
      SELECT message_id, project_id, sender_thread_id, sender_name_at_send,
             sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
             reply_to_message_id, body, body_bytes, accepted_runtime_mode,
             accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
             accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
             offer_count, acknowledged_at, terminal_at, terminal_reason
      FROM civilization_messages
      WHERE project_id = ${input.caller.projectId}
        AND recipient_thread_id = ${input.caller.threadId}
        AND recipient_delivery_epoch = ${input.caller.deliveryEpoch}
        AND terminal_at IS NULL AND expires_at > ${time.now}
        AND (${includeAcknowledged ? 1 : 0} = 1 OR acknowledged_at IS NULL)
        AND (${cursor === undefined ? 1 : 0} = 1
          OR accepted_at < ${cursor?.afterAcceptedAt ?? ""}
          OR (accepted_at = ${cursor?.afterAcceptedAt ?? ""} AND message_id < ${cursor?.afterMessageId ?? ""}))
      ORDER BY accepted_at DESC, message_id DESC
      LIMIT ${limit + 1}
    `;
    const messages: Array<CivilizationMailSummary> = [];
    let byteLimited = false;
    for (const row of rows.slice(0, limit)) {
      const candidate = messageSummary(row);
      const candidateCursor = encodeInboxCursor({
        projectId: input.caller.projectId,
        recipientThreadId: input.caller.threadId,
        revision: state.mail_revision,
        deliveryEpoch: input.caller.deliveryEpoch,
        includeAcknowledged,
        afterAcceptedAt: row.accepted_at,
        afterMessageId: row.message_id,
      });
      const candidatePage = {
        revision: state.mail_revision,
        deliveryEpoch: input.caller.deliveryEpoch,
        messages: [...messages, candidate],
        nextCursor: candidateCursor,
        partial: true,
      } satisfies CivilizationInboxPage;
      if (responseBytes(candidatePage) > effective.config.operations.responseBodyBytes) {
        byteLimited = true;
        break;
      }
      messages.push(candidate);
    }
    if (rows.length > 0 && messages.length === 0) {
      return yield* invalid(
        "response_too_large",
        "The configured Civilization response-body limit cannot fit one inbox entry.",
      );
    }
    const partial = byteLimited || rows.length > messages.length;
    const last = messages.length === 0 ? undefined : rows[messages.length - 1];
    const nextCursor =
      partial && last !== undefined
        ? encodeInboxCursor({
            projectId: input.caller.projectId,
            recipientThreadId: input.caller.threadId,
            revision: state.mail_revision,
            deliveryEpoch: input.caller.deliveryEpoch,
            includeAcknowledged,
            afterAcceptedAt: last.accepted_at,
            afterMessageId: last.message_id,
          })
        : null;
    return {
      revision: state.mail_revision,
      deliveryEpoch: input.caller.deliveryEpoch,
      messages,
      nextCursor,
      partial,
    } satisfies CivilizationInboxPage;
  });

  const assertMessageReadable = Effect.fn("CivilizationMail.assertMessageReadable")(
    function* (input: {
      readonly caller: CivilizationMailCaller;
      readonly row: MessageRow;
      readonly now: string;
    }) {
      if (input.row.recipient_thread_id !== input.caller.threadId) {
        return yield* denied(
          "forbidden",
          "This Civilization mail is not addressed to the calling citizen.",
        );
      }
      if (input.row.recipient_delivery_epoch !== input.caller.deliveryEpoch) {
        return yield* denied(
          "stale_epoch",
          "This Civilization mail belongs to an older delivery epoch.",
        );
      }
      if (input.row.terminal_at !== null) {
        return yield* invalid(
          "terminal_message",
          "This Civilization mail is terminal and cannot be released to an agent.",
        );
      }
      if (input.row.expires_at <= input.now) {
        return yield* invalid("expired_message", "This Civilization mail has expired.");
      }
      if (
        exceededDispatchModeLimit(
          {
            runtimeMode: input.row.accepted_runtime_mode,
            interactionMode: input.row.accepted_interaction_mode,
          },
          {
            runtimeMode: input.caller.runtimeMode,
            interactionMode: input.caller.interactionMode,
          },
        ) !== undefined
      ) {
        return yield* denied(
          "forbidden",
          "The recipient now runs above this message's accepted transfer ceiling.",
        );
      }
    },
  );

  const receive = Effect.fn("CivilizationMail.receive")(function* (input: {
    readonly caller: CivilizationMailCaller;
    readonly messageId: CivilizationMessageIdType;
    readonly clientRequestId: string;
  }) {
    const validated = yield* mailSync(() => ({
      clientRequestId: validateClientRequestId(input.clientRequestId),
      canonicalPayloadHash: payloadHash({ messageId: input.messageId }),
    }));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const effective = yield* getEffectiveCivilizationConfig(input.caller.projectId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const fresh = yield* assertFreshCaller(input.caller, effective);
        const currentCaller = {
          ...input.caller,
          runtimeMode: fresh.runtimeMode,
          interactionMode: fresh.interactionMode,
        };
        const time = yield* currentTime(sql);
        const row = yield* selectMessage(sql, input.caller.projectId, input.messageId);
        if (row === undefined) {
          return yield* new CivilizationMailNotFoundError({
            code: "civilization_mail_not_found",
            messageId: input.messageId,
          });
        }
        yield* assertMessageReadable({ caller: currentCaller, row, now: time.now });
        const receipt = yield* readReceipt({
          projectId: input.caller.projectId,
          actorThreadId: input.caller.threadId,
          clientRequestId: validated.clientRequestId,
        });
        if (receipt !== undefined) {
          yield* resolveReceipt({
            receipt,
            operationKind: "receive",
            payloadHash: validated.canonicalPayloadHash,
          });
        } else {
          yield* sql`
            UPDATE civilization_messages
            SET first_offered_at = COALESCE(first_offered_at, ${time.now}),
                last_offered_at = ${time.now},
                offer_count = offer_count + 1
            WHERE project_id = ${input.caller.projectId} AND message_id = ${input.messageId}
          `;
          yield* insertReceipt({
            caller: input.caller,
            kind: "receive",
            clientRequestId: validated.clientRequestId,
            canonicalPayloadHash: validated.canonicalPayloadHash,
            resultMessageId: input.messageId,
            now: time.now,
            retentionDays: effective.config.operations.operationReceiptRetentionDays,
          });
        }
        const updated = yield* selectMessage(sql, input.caller.projectId, input.messageId);
        if (updated === undefined) return yield* Effect.die("Offered Civilization mail vanished.");
        const revision =
          (yield* sql<{ readonly mail_revision: number }>`
            SELECT mail_revision FROM civilization_project_state
            WHERE project_id = ${input.caller.projectId} LIMIT 1
          `)[0]?.mail_revision ?? 0;
        return {
          revision,
          deliveryEpoch: input.caller.deliveryEpoch,
          offeredAt: updated.last_offered_at ?? time.now,
          message: messageBody(updated),
        } satisfies CivilizationMailReceiveResult;
      }),
    );
  });

  const acknowledge = Effect.fn("CivilizationMail.acknowledge")(function* (input: {
    readonly caller: CivilizationMailCaller;
    readonly messageId: CivilizationMessageIdType;
    readonly clientRequestId: string;
  }) {
    const validated = yield* mailSync(() => ({
      clientRequestId: validateClientRequestId(input.clientRequestId),
      canonicalPayloadHash: payloadHash({ messageId: input.messageId }),
    }));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const effective = yield* getEffectiveCivilizationConfig(input.caller.projectId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const fresh = yield* assertFreshCaller(input.caller, effective);
        const time = yield* currentTime(sql);
        const row = yield* selectMessage(sql, input.caller.projectId, input.messageId);
        if (row === undefined) {
          return yield* new CivilizationMailNotFoundError({
            code: "civilization_mail_not_found",
            messageId: input.messageId,
          });
        }
        yield* assertMessageReadable({
          caller: {
            ...input.caller,
            runtimeMode: fresh.runtimeMode,
            interactionMode: fresh.interactionMode,
          },
          row,
          now: time.now,
        });
        if (row.offer_count <= 0) {
          return yield* invalid(
            "invalid_message",
            "Civilization mail must be offered before it can be acknowledged.",
          );
        }
        const receipt = yield* readReceipt({
          projectId: input.caller.projectId,
          actorThreadId: input.caller.threadId,
          clientRequestId: validated.clientRequestId,
        });
        if (receipt !== undefined) {
          yield* resolveReceipt({
            receipt,
            operationKind: "acknowledge",
            payloadHash: validated.canonicalPayloadHash,
          });
        } else {
          if (row.acknowledged_at === null) {
            yield* sql`
              UPDATE civilization_messages
              SET acknowledged_at = ${time.now}
              WHERE project_id = ${input.caller.projectId} AND message_id = ${input.messageId}
            `;
          }
          yield* insertReceipt({
            caller: input.caller,
            kind: "acknowledge",
            clientRequestId: validated.clientRequestId,
            canonicalPayloadHash: validated.canonicalPayloadHash,
            resultMessageId: input.messageId,
            now: time.now,
            retentionDays: effective.config.operations.operationReceiptRetentionDays,
          });
        }
        const updated = yield* selectMessage(sql, input.caller.projectId, input.messageId);
        if (updated?.acknowledged_at === null || updated === undefined) {
          return yield* Effect.die(
            "Acknowledged Civilization mail has no acknowledgement timestamp.",
          );
        }
        return {
          messageId: input.messageId,
          acknowledgedAt: updated.acknowledged_at,
        } satisfies CivilizationMailAcknowledgeResult;
      }),
    );
  });

  const selectInboxForContext = Effect.fn("CivilizationMail.selectInboxForContext")(
    function* (input: {
      readonly caller: CivilizationMailCaller;
      readonly limit: number;
      readonly selection: "recent" | "stable_id";
    }) {
      if (input.limit <= 0) return [] as ReadonlyArray<CivilizationMailContextCandidate>;
      const effective = yield* getEffectiveCivilizationConfig(input.caller.projectId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const fresh = yield* assertFreshCaller(input.caller, effective);
      const time = yield* currentTime(sql);
      const scanLimit = Math.max(input.limit * 4, input.limit + 1);
      const rows =
        input.selection === "recent"
          ? yield* sql<MessageRow>`
          SELECT message_id, project_id, sender_thread_id, sender_name_at_send,
                 sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
                 reply_to_message_id, body, body_bytes, accepted_runtime_mode,
                 accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
                 accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
                 offer_count, acknowledged_at, terminal_at, terminal_reason
          FROM civilization_messages
          WHERE project_id = ${input.caller.projectId}
            AND recipient_thread_id = ${input.caller.threadId}
            AND recipient_delivery_epoch = ${input.caller.deliveryEpoch}
            AND terminal_at IS NULL AND acknowledged_at IS NULL AND expires_at > ${time.now}
          ORDER BY accepted_at DESC, message_id DESC
          LIMIT ${scanLimit}
        `
          : yield* sql<MessageRow>`
          SELECT message_id, project_id, sender_thread_id, sender_name_at_send,
                 sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
                 reply_to_message_id, body, body_bytes, accepted_runtime_mode,
                 accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
                 accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
                 offer_count, acknowledged_at, terminal_at, terminal_reason
          FROM civilization_messages
          WHERE project_id = ${input.caller.projectId}
            AND recipient_thread_id = ${input.caller.threadId}
            AND recipient_delivery_epoch = ${input.caller.deliveryEpoch}
            AND terminal_at IS NULL AND acknowledged_at IS NULL AND expires_at > ${time.now}
          ORDER BY message_id ASC
          LIMIT ${scanLimit}
        `;
      const current = {
        runtimeMode: fresh.runtimeMode,
        interactionMode: fresh.interactionMode,
      };
      return rows
        .filter(
          (row) =>
            exceededDispatchModeLimit(
              {
                runtimeMode: row.accepted_runtime_mode,
                interactionMode: row.accepted_interaction_mode,
              },
              current,
            ) === undefined,
        )
        .slice(0, input.limit)
        .map((row) => ({ message: messageBody(row) }) satisfies CivilizationMailContextCandidate);
    },
  );

  // ContextService calls this only after authoritativeCaller has validated the
  // same caller. No mail is released here; offerInboxForContext performs the
  // fresh authority/config/lifecycle check again at the actual offer boundary.
  const selectInboxForContextAfterAuthority = Effect.fn(
    "CivilizationMail.selectInboxForContextAfterAuthority",
  )(function* (input: {
    readonly caller: CivilizationMailCaller;
    readonly limit: number;
    readonly selection: "recent" | "stable_id";
  }) {
    if (input.limit <= 0) return [] as ReadonlyArray<CivilizationMailContextCandidate>;
    const time = yield* currentTime(sql);
    const scanLimit = Math.max(input.limit * 4, input.limit + 1);
    const rows =
      input.selection === "recent"
        ? yield* sql<MessageRow>`
            SELECT message_id, project_id, sender_thread_id, sender_name_at_send,
                   sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
                   reply_to_message_id, body, body_bytes, accepted_runtime_mode,
                   accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
                   accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
                   offer_count, acknowledged_at, terminal_at, terminal_reason
            FROM civilization_messages
            WHERE project_id = ${input.caller.projectId}
              AND recipient_thread_id = ${input.caller.threadId}
              AND recipient_delivery_epoch = ${input.caller.deliveryEpoch}
              AND terminal_at IS NULL AND acknowledged_at IS NULL AND expires_at > ${time.now}
            ORDER BY accepted_at DESC, message_id DESC
            LIMIT ${scanLimit}
          `
        : yield* sql<MessageRow>`
            SELECT message_id, project_id, sender_thread_id, sender_name_at_send,
                   sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
                   reply_to_message_id, body, body_bytes, accepted_runtime_mode,
                   accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
                   accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
                   offer_count, acknowledged_at, terminal_at, terminal_reason
            FROM civilization_messages
            WHERE project_id = ${input.caller.projectId}
              AND recipient_thread_id = ${input.caller.threadId}
              AND recipient_delivery_epoch = ${input.caller.deliveryEpoch}
              AND terminal_at IS NULL AND acknowledged_at IS NULL AND expires_at > ${time.now}
            ORDER BY message_id ASC
            LIMIT ${scanLimit}
          `;
    return rows
      .filter(
        (row) =>
          exceededDispatchModeLimit(
            {
              runtimeMode: row.accepted_runtime_mode,
              interactionMode: row.accepted_interaction_mode,
            },
            {
              runtimeMode: input.caller.runtimeMode,
              interactionMode: input.caller.interactionMode,
            },
          ) === undefined,
      )
      .slice(0, input.limit)
      .map((row) => ({ message: messageBody(row) }) satisfies CivilizationMailContextCandidate);
  });

  const offerInboxForContext = Effect.fn("CivilizationMail.offerInboxForContext")(
    function* (input: {
      readonly caller: CivilizationMailCaller;
      readonly messageIds: ReadonlyArray<CivilizationMessageIdType>;
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const effective = yield* getEffectiveCivilizationConfig(input.caller.projectId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const fresh = yield* assertFreshCaller(input.caller, effective);
          const time = yield* currentTime(sql);
          const messageIds = [...new Set(input.messageIds)];
          const candidates =
            messageIds.length === 0
              ? []
              : yield* sql<MessageRow>`
                  SELECT message_id, project_id, sender_thread_id, sender_name_at_send,
                         sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
                         reply_to_message_id, body, body_bytes, accepted_runtime_mode,
                         accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
                         accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
                         offer_count, acknowledged_at, terminal_at, terminal_reason
                  FROM civilization_messages
                  WHERE project_id = ${input.caller.projectId}
                    AND message_id IN ${sql.in(messageIds)}
                `;
          const eligibleIds = candidates
            .filter(
              (row) =>
                row.recipient_thread_id === input.caller.threadId &&
                row.recipient_delivery_epoch === input.caller.deliveryEpoch &&
                row.terminal_at === null &&
                row.acknowledged_at === null &&
                row.expires_at > time.now &&
                exceededDispatchModeLimit(
                  {
                    runtimeMode: row.accepted_runtime_mode,
                    interactionMode: row.accepted_interaction_mode,
                  },
                  { runtimeMode: fresh.runtimeMode, interactionMode: fresh.interactionMode },
                ) === undefined,
            )
            .map((row) => row.message_id);
          const updated =
            eligibleIds.length === 0
              ? []
              : yield* sql<MessageRow>`
                  UPDATE civilization_messages
                  SET first_offered_at = COALESCE(first_offered_at, ${time.now}),
                      last_offered_at = ${time.now}, offer_count = offer_count + 1
                  WHERE project_id = ${input.caller.projectId}
                    AND message_id IN ${sql.in(eligibleIds)}
                    AND recipient_thread_id = ${input.caller.threadId}
                    AND recipient_delivery_epoch = ${input.caller.deliveryEpoch}
                    AND terminal_at IS NULL AND acknowledged_at IS NULL AND expires_at > ${time.now}
                  RETURNING message_id, project_id, sender_thread_id, sender_name_at_send,
                            sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
                            reply_to_message_id, body, body_bytes, accepted_runtime_mode,
                            accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
                            accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
                            offer_count, acknowledged_at, terminal_at, terminal_reason
                `;
          const updatedById = new Map(updated.map((row) => [row.message_id, row] as const));
          const offered = messageIds.flatMap((messageId) => {
            const row = updatedById.get(messageId);
            return row === undefined ? [] : [row];
          });
          const revision =
            (yield* sql<{ readonly mail_revision: number }>`
            SELECT mail_revision FROM civilization_project_state
            WHERE project_id = ${input.caller.projectId} LIMIT 1
          `)[0]?.mail_revision ?? 0;
          return {
            revision,
            offeredAt: time.now,
            messages: offered.map(messageBody),
          } as const;
        }),
      );
    },
  );

  const readAdminMessage = Effect.fn("CivilizationMail.readAdminMessage")(function* (input: {
    readonly projectId: ProjectId;
    readonly messageId: CivilizationMessageIdType;
  }) {
    const row = yield* selectMessage(sql, input.projectId, input.messageId);
    if (row === undefined) {
      return yield* new CivilizationMailNotFoundError({
        code: "civilization_mail_not_found",
        messageId: input.messageId,
      });
    }
    return { projectId: input.projectId, ...messageBody(row) } as const;
  });

  const listAdminMail = Effect.fn("CivilizationMail.listAdminMail")(function* (input: {
    readonly projectId: ProjectId;
    readonly cursor?: string;
    readonly limit?: number;
  }) {
    const effective = yield* getEffectiveCivilizationConfig(input.projectId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const limit = yield* mailSync(() => {
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
        throw invalid(
          "invalid_cursor",
          "Civilization inbox page limit must be a positive integer.",
        );
      }
      return Math.min(
        input.limit ?? effective.config.operations.inboxPageSize,
        effective.config.operations.inboxPageSize,
      );
    });
    const state = (yield* sql<ProjectStateRow>`
        SELECT mail_revision, retained_message_count, retained_body_bytes
        FROM civilization_project_state WHERE project_id = ${input.projectId} LIMIT 1
      `)[0] ?? { mail_revision: 0, retained_message_count: 0, retained_body_bytes: 0 };
    const cursor = yield* mailSync(() =>
      decodeAdminInboxCursor(input.cursor, {
        projectId: input.projectId,
        revision: state.mail_revision,
      }),
    );
    const rows = yield* sql<MessageRow>`
      SELECT message_id, project_id, sender_thread_id, sender_name_at_send,
             sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
             reply_to_message_id, body, body_bytes, accepted_runtime_mode,
             accepted_interaction_mode, accepted_environment_revision, accepted_project_revision,
             accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at,
             offer_count, acknowledged_at, terminal_at, terminal_reason
      FROM civilization_messages
      WHERE project_id = ${input.projectId}
        AND (${cursor === undefined ? 1 : 0} = 1
          OR accepted_at < ${cursor?.afterAcceptedAt ?? ""}
          OR (accepted_at = ${cursor?.afterAcceptedAt ?? ""} AND message_id < ${cursor?.afterMessageId ?? ""}))
      ORDER BY accepted_at DESC, message_id DESC
      LIMIT ${limit + 1}
    `;
    const messages: Array<CivilizationMailSummary> = [];
    let byteLimited = false;
    for (const row of rows.slice(0, limit)) {
      const candidate = messageSummary(row);
      const candidateCursor = encodeAdminInboxCursor({
        projectId: input.projectId,
        revision: state.mail_revision,
        afterAcceptedAt: row.accepted_at,
        afterMessageId: row.message_id,
      });
      const candidatePage = {
        projectId: input.projectId,
        revision: state.mail_revision,
        messages: [...messages, candidate],
        nextCursor: candidateCursor,
        partial: true,
      } satisfies CivilizationAdminMailPage;
      if (responseBytes(candidatePage) > effective.config.operations.responseBodyBytes) {
        byteLimited = true;
        break;
      }
      messages.push(candidate);
    }
    if (rows.length > 0 && messages.length === 0) {
      return yield* invalid(
        "response_too_large",
        "The configured Civilization response-body limit cannot fit one administrative inbox entry.",
      );
    }
    const partial = byteLimited || rows.length > messages.length;
    const last = messages.length === 0 ? undefined : rows[messages.length - 1];
    return {
      projectId: input.projectId,
      revision: state.mail_revision,
      messages,
      nextCursor:
        partial && last !== undefined
          ? encodeAdminInboxCursor({
              projectId: input.projectId,
              revision: state.mail_revision,
              afterAcceptedAt: last.accepted_at,
              afterMessageId: last.message_id,
            })
          : null,
      partial,
    } satisfies CivilizationAdminMailPage;
  });

  const cleanupProject = Effect.fn("CivilizationMail.cleanupProject")(function* (
    projectId: ProjectId,
  ) {
    const effective = yield* getEffectiveCivilizationConfig(projectId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const batch = effective.config.operations.cleanupBatch;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const time = yield* currentTime(sql);
        yield* sql`
          UPDATE civilization_messages
          SET terminal_at = ${time.now}, terminal_reason = 'expired'
          WHERE message_id IN (
            SELECT message_id FROM civilization_messages
            WHERE project_id = ${projectId}
              AND terminal_at IS NULL AND acknowledged_at IS NULL
              AND expires_at <= ${time.now}
            ORDER BY expires_at ASC, message_id ASC
            LIMIT ${batch}
          )
        `;
        const expired =
          (yield* sql<{ readonly count: number }>`SELECT changes() AS count`)[0]?.count ?? 0;
        yield* sql`
          DELETE FROM civilization_messages
          WHERE message_id IN (
            SELECT message_id FROM civilization_messages
            WHERE project_id = ${projectId}
              AND terminal_at IS NOT NULL
              AND strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at, '+' || terminal_retention_days || ' days') <= ${time.now}
            ORDER BY terminal_at ASC, message_id ASC
            LIMIT ${batch}
          )
        `;
        const deletedMessages =
          (yield* sql<{ readonly count: number }>`SELECT changes() AS count`)[0]?.count ?? 0;
        yield* sql`
          DELETE FROM civilization_mail_operation_receipts
          WHERE rowid IN (
            SELECT rowid FROM civilization_mail_operation_receipts
            WHERE project_id = ${projectId} AND expires_at <= ${time.now}
            ORDER BY expires_at ASC, rowid ASC
            LIMIT ${batch}
          )
        `;
        const deletedReceipts =
          (yield* sql<{ readonly count: number }>`SELECT changes() AS count`)[0]?.count ?? 0;
        yield* sql`
          DELETE FROM civilization_mail_quota_windows
          WHERE rowid IN (
            SELECT rowid FROM civilization_mail_quota_windows
            WHERE project_id = ${projectId} AND window_start_minute < ${time.minute_start}
            ORDER BY window_start_minute ASC, rowid ASC
            LIMIT ${batch}
          )
        `;
        const deletedQuotaWindows =
          (yield* sql<{ readonly count: number }>`SELECT changes() AS count`)[0]?.count ?? 0;
        return {
          expired,
          deletedMessages,
          deletedReceipts,
          deletedQuotaWindows,
        } as const;
      }),
    );
  });

  return {
    authoritativeCaller,
    send,
    listInbox,
    receive,
    acknowledge,
    selectInboxForContext,
    selectInboxForContextAfterAuthority,
    offerInboxForContext,
    listAdminMail,
    readAdminMessage,
    cleanupProject,
  } as const;
});

export type CivilizationMailServiceShape = Effect.Success<typeof make>;

const unavailable = () => Effect.die("Civilization mail is not installed in this runtime layer.");
const unavailableService = {
  authoritativeCaller: () => unavailable(),
  send: () => unavailable(),
  listInbox: () => unavailable(),
  receive: () => unavailable(),
  acknowledge: () => unavailable(),
  selectInboxForContext: () => unavailable(),
  selectInboxForContextAfterAuthority: () => unavailable(),
  offerInboxForContext: () => unavailable(),
  listAdminMail: () => unavailable(),
  readAdminMessage: () => unavailable(),
  cleanupProject: () => unavailable(),
} satisfies CivilizationMailServiceShape;

export class CivilizationMailService extends Context.Reference<CivilizationMailServiceShape>(
  "t3/civilization/MailService/CivilizationMailService",
  { defaultValue: () => unavailableService },
) {}

export const layer = Layer.effect(CivilizationMailService, make);
