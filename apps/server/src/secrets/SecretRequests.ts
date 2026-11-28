// Answers stay in the secret store behind one-use refs; orchestration records only request status.
// Consuming tools keep values out of transcripts, projections, clients and model context.
// A `file` request instead moves its value to an owner-only file for the agent's own shell.
// A secret the user pasted in chat goes straight to such a file, with no card.
import {
  CommandId,
  GmailReadOperation,
  type GmailMessageSummary,
  VaultServiceRead,
  type VaultServiceItem,
  SecretRef,
  SecretRequestError,
  isRetiredVaultOperation,
  secretRequestPageUrl,
  LOCAL_VAULT_PROVIDER,
  vaultMentionLabel,
  type TaggedVaultEntry,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type SecretReference,
  type SecretRequestAnswerInput,
  type SecretRequestAnswerResult,
  type OrchestratorMcpGmailListRecentResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import { listRecentGmail, type GmailApiError } from "./GmailApi.ts";
import { listConnectedItems } from "./ServiceConnections.ts";
import { manageLocalVault, readVaultRecord, vaultField, vaultOriginMatches } from "./LocalVault.ts";
import { authorizeVaultUse, vaultSecuritySummary } from "./VaultAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const PRIVATE_APPROVAL_TTL_MS = 60_000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;
const isGmailReadOperation = Schema.is(GmailReadOperation);
const isVaultServiceRead = Schema.is(VaultServiceRead);

const StoredSecret = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.String,
    value: Schema.String,
    savedAt: Schema.Number,
    origin: Schema.optionalKey(Schema.String),
    vaultEpoch: Schema.optionalKey(Schema.String),
  }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);
type PrivateOperation = GmailReadOperation | VaultServiceRead;
function sameOperation(left: PrivateOperation, right: PrivateOperation) {
  return (
    left.limit === right.limit &&
    ("folder" in left
      ? "folder" in right && left.folder === right.folder
      : "service" in right && left.service === right.service)
  );
}

interface PrivateApproval {
  readonly threadId: string;
  readonly turnItemId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly operation: PrivateOperation;
  readonly account: string;
  readonly revision: string;
  readonly vaultEpoch: string;
}

type PrivateResult =
  | { readonly messages: ReadonlyArray<GmailMessageSummary> }
  | { readonly items: ReadonlyArray<VaultServiceItem> };
type PrivateReply = Deferred.Deferred<PrivateResult, SecretRequestError>;
interface SpendInput<Op extends PrivateOperation> {
  readonly ref: SecretRef;
  readonly threadId: ThreadId;
  readonly operation: Op;
}
type SpendPrivate<Op extends PrivateOperation> = (
  input: SpendInput<Op>,
  currentSession: Effect.Effect<boolean>,
) => Effect.Effect<
  Extract<OrchestratorMcpGmailListRecentResult, { status: "displayed" }>,
  SecretRequestError | GmailApiError
>;

type SecretRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "secret_request" }>;
/** `undefined` names the value of a request without fields. */
type FieldName = string | undefined;
const fieldNames = (item: SecretRequestItem): ReadonlyArray<FieldName> =>
  item.fields?.map((field) => field.name) ?? [undefined];

/** The answer's value per field, or undefined when it does not answer exactly those fields. */
function answerValues(
  item: SecretRequestItem,
  answer: Exclude<SecretRequestAnswerInput["answer"], { readonly type: "decline" }>,
): ReadonlyArray<readonly [FieldName, string]> | undefined {
  if (item.fields === undefined)
    return "secret" in answer ? [[undefined, answer.secret]] : undefined;
  if (!("values" in answer)) return undefined;
  const { values } = answer;
  if (Object.keys(values).length !== item.fields.length) return undefined;
  const entries: Array<readonly [string, string]> = [];
  for (const field of item.fields) {
    const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined;
    if (value === undefined) return undefined;
    entries.push([field.name, value]);
  }
  return entries;
}

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly resolveTaggedEntry: (
      title: string,
    ) => Effect.Effect<Extract<TaggedVaultEntry, { field: string }>, SecretRequestError>;
    readonly resolveGmailEntry: (
      title: string,
      operation: GmailReadOperation,
    ) => Effect.Effect<
      Extract<TaggedVaultEntry, { gmail: GmailReadOperation }>,
      SecretRequestError
    >;
    readonly resolveServiceEntry: (
      title: string,
      operation: VaultServiceRead,
    ) => Effect.Effect<
      Extract<TaggedVaultEntry, { serviceRead: VaultServiceRead }>,
      SecretRequestError
    >;
    readonly consumeGmail: SpendPrivate<GmailReadOperation>;
    readonly consumeService: SpendPrivate<VaultServiceRead>;
    readonly cancelPrivateDisplay: (threadId: ThreadId, turnItemId: string) => Effect.Effect<void>;
    readonly answer: (
      input: SecretRequestAnswerInput,
    ) => Effect.Effect<SecretRequestAnswerResult, SecretRequestError>;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
      readonly targetUrl?: string;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Moves a saved `file` request's values to owner-only files, one per field. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<
      { readonly file: string } | { readonly files: { readonly [name: string]: string } },
      SecretRequestError
    >;
    /** Writes a secret the user pasted in chat to an owner-only file and returns its path. */
    readonly savePasted: (input: {
      readonly threadId: ThreadId;
      /** The provider session's namespace, so two sessions' keys never share a file. */
      readonly requestNamespace: string;
      readonly requestKey: string;
      readonly value: string;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const resolver = yield* SecretResolver.SecretResolver;
  // Beside the store's own files so the same owner-only directory and cleanup rules apply.
  const filesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");
  const uniqueEntry = Effect.fn("SecretRequests.uniqueEntry")(function* (title: string) {
    const vault = yield* manageLocalVault(store, { action: "list" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    const matches = vault.entries?.filter((entry) => vaultMentionLabel(entry.title) === title);
    if (vault.error || !vault.security?.configured || matches?.length !== 1)
      return yield* new SecretRequestError({ reason: "vault_tag_unavailable" });
    return matches[0]!;
  });
  const resolveGmailEntry: SecretRequests["Service"]["resolveGmailEntry"] = Effect.fn(
    "SecretRequests.resolveGmailEntry",
  )(function* (title, operation) {
    const entry = yield* uniqueEntry(title);
    if (entry.kind === "service" || !isGmailReadOperation(operation))
      return yield* new SecretRequestError({ reason: "vault_tag_unavailable" });
    return entry.gmailAccount
      ? { name: entry.name, gmail: operation }
      : { name: entry.name, gmail: operation, needsGmailConnection: true as const };
  });
  const resolveServiceEntry: SecretRequests["Service"]["resolveServiceEntry"] = Effect.fn(
    "SecretRequests.resolveServiceEntry",
  )(function* (title, operation) {
    const entry = yield* uniqueEntry(title);
    if (!isVaultServiceRead(operation))
      return yield* new SecretRequestError({ reason: "vault_tag_unavailable" });
    const connection = entry.serviceConnection;
    if (
      entry.kind !== "service" ||
      connection?.service !== operation.service ||
      !connection.revision
    )
      return yield* new SecretRequestError({ reason: "vault_service_not_connected" });
    return { name: entry.name, serviceRead: operation, revision: connection.revision };
  });
  const resolveTaggedEntry = Effect.fn("SecretRequests.resolveTaggedEntry")(function* (
    title: string,
  ) {
    const entry = yield* uniqueEntry(title);
    if (entry.kind === "gmail" || entry.kind === "service")
      return yield* new SecretRequestError({ reason: "vault_tag_unavailable" });
    // No protected tool currently consumes a website login with a verified target origin.
    if (entry.kind === "login") return yield* new SecretRequestError({ reason: "vault_tag_login" });
    return {
      name: entry.name,
      field: entry.kind === "token" ? ("token" as const) : ("note" as const),
    };
  });

  const mac = yield* Mac.Mac;
  // Keyed by the salt's hex text, as refs saved by earlier versions were.
  const refKey = yield* Mac.key(
    Mac.hmacSha256,
    new TextEncoder().encode(
      Hex.encode(yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie)),
    ),
  ).pipe(Effect.orDie);
  const refFor = (threadId: ThreadId, turnItemId: string, field?: string) =>
    mac
      .sign(
        refKey,
        new TextEncoder().encode(
          field === undefined
            ? `${threadId}\u0000${turnItemId}`
            : `${threadId}\u0000${turnItemId}\u0000${field}`,
        ),
      )
      .pipe(
        Effect.orDie,
        Effect.map((tag) => SecretRef.make(`${SECRET_REF_PREFIX}${Hex.encode(tag).slice(0, 32)}`)),
      );
  const removeAnswered = (threadId: ThreadId, item: SecretRequestItem) =>
    Effect.forEach(fieldNames(item), (field) =>
      refFor(threadId, item.id, field).pipe(Effect.flatMap((ref) => removeLogged(storeName(ref)))),
    );

  const readReference = Effect.fn("SecretRequests.readReference")(function* (
    reference: SecretReference,
  ) {
    // The resolver keeps failed reads for the server's life; a retry after unlocking must re-read.
    yield* resolver.invalidate([reference]);
    const [value] = yield* resolver.read([reference]);
    if (value === undefined || value.trim() === "") {
      return yield* new SecretRequestError({
        reason: "reference_unreadable",
        provider: yield* resolver.label(reference.provider),
      });
    }
    return value;
  });
  // Run and root must still belong to the attempt that presented the card, including
  // after a steer/restart. Recheck both when approving and immediately before spending.
  const requireLivePrivateCard = Effect.fn("SecretRequests.requireLivePrivateCard")(function* (
    threadId: ThreadId,
    expected: PrivateApproval,
    status: "pending" | "saved",
  ) {
    const records = yield* threadManagement
      .getThreadRecords(threadId, ["runs", "nodes", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const run = ThreadManagementService.latestActiveRun(records);
    const node = records.nodes.find((candidate) => candidate.id === expected.nodeId);
    if (
      records.thread.id !== threadId ||
      run?.id !== expected.runId ||
      run.rootNodeId !== expected.nodeId ||
      node?.threadId !== threadId ||
      node.runId !== run.id ||
      (node.status !== "running" && node.status !== "waiting" && node.status !== "pending")
    )
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    const item = records.turnItems.find((candidate) => candidate.id === expected.turnItemId);
    if (
      item?.type !== "secret_request" ||
      item.threadId !== threadId ||
      item.runId !== run.id ||
      item.nodeId !== node.id ||
      item.secretStatus !== status ||
      item.fields !== undefined ||
      item.delivery === "file" ||
      !item.taggedVault ||
      item.taggedVault.name !== expected.name ||
      "field" in item.taggedVault ||
      !sameOperation(
        "gmail" in item.taggedVault ? item.taggedVault.gmail : item.taggedVault.serviceRead,
        expected.operation,
      )
    )
      return yield* new SecretRequestError({ reason: "vault_access_denied" });
    if ("serviceRead" in item.taggedVault && item.taggedVault.revision !== expected.revision)
      return yield* new SecretRequestError({ reason: "vault_service_approval" });
    return { label: item.label, projectId: records.thread.projectId };
  });

  // Private approvals have no persistent ref: only the held tool call can claim one and
  // only the answering RPC owns its result. Losing either call must not turn it into a share.
  const privateApprovals = new Map<
    SecretRef,
    {
      approval: PrivateApproval & { readonly projectId: ProjectId; readonly savedAt: number };
      reply: PrivateReply;
      claimed: boolean;
    }
  >();
  // One answer at a time: fields are stored one by one, so two racing answers could otherwise
  // each keep some of their values on one card.
  const answerLock = yield* Semaphore.make(1);
  const recordAnswer = Effect.fn("SecretRequests.recordAnswer")(
    function* (
      input: SecretRequestAnswerInput,
      display: { ref: SecretRef; reply: PrivateReply } | undefined,
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* new SecretRequestError({ reason: "not_found" });
      }
      if (isRetiredVaultOperation(item.id)) {
        return yield* new SecretRequestError({ reason: "operation_request" });
      }
      if (item.secretStatus !== "pending") {
        return yield* new SecretRequestError({ reason: "already_answered" });
      }
      const answer: Exclude<
        SecretRequestAnswerInput["answer"],
        { type: "vault_gmail_display" | "vault_service_display" }
      > =
        input.answer.type === "vault_gmail_display" || input.answer.type === "vault_service_display"
          ? { type: "vault" as const, name: input.answer.name, fields: {}, pin: input.answer.pin }
          : input.answer;
      const tag = item.taggedVault;
      if (
        display &&
        (!tag ||
          "field" in tag ||
          ("gmail" in tag
            ? input.answer.type !== "vault_gmail_display"
            : input.answer.type !== "vault_service_display"))
      )
        return yield* new SecretRequestError({ reason: "vault_access_denied" });
      if (
        item.taggedVault &&
        answer.type !== "decline" &&
        (item.delivery === "file" ||
          item.fields !== undefined ||
          answer.type !== "vault" ||
          answer.name !== item.taggedVault.name ||
          ("field" in item.taggedVault
            ? answer.fields.value !== item.taggedVault.field
            : !display ||
              ("gmail" in item.taggedVault
                ? !isGmailReadOperation(item.taggedVault.gmail)
                : !isVaultServiceRead(item.taggedVault.serviceRead))))
      )
        return yield* new SecretRequestError({ reason: "vault_access_denied" });
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
      const { runId, nodeId } = item;
      // Create before recording so racing answers cannot overwrite values or show saved before storage.
      // Existing values on pending cards finish earlier saves whose recording failed.
      let approvedOrigin: string | undefined;
      let vaultEpoch: string | undefined;
      const readVaultAnswer = Effect.fn("SecretRequests.readVaultAnswer")(function* (
        answer: Extract<SecretRequestAnswerInput["answer"], { readonly type: "vault" }>,
      ) {
        if (item.delivery === "file" && answer.discloseToCommands !== true)
          return yield* new SecretRequestError({ reason: "vault_disclosure_required" });
        vaultEpoch = yield* authorizeVaultUse(
          store,
          answer.name,
          item.taggedVault ? "tagged" : item.delivery === "file" ? "command" : "request",
          answer.pin,
        ).pipe(
          Effect.mapError(
            (error) =>
              new SecretRequestError({
                reason:
                  error.code === "pin_not_set"
                    ? "vault_pin_not_set"
                    : error.code === "pin_required"
                      ? "vault_pin_required"
                      : error.code === "pin_invalid"
                        ? "vault_pin_invalid"
                        : error.code === "pin_locked"
                          ? "vault_pin_locked"
                          : "vault_access_denied",
              }),
          ),
        );
        const record = yield* readVaultRecord(store, answer.name);
        if (!record)
          return yield* new SecretRequestError({
            reason: "reference_unreadable",
            provider: "Hyakki vault",
          });
        if (item.taggedVault && vaultMentionLabel(record.title) !== item.label)
          return yield* new SecretRequestError({ reason: "vault_tag_unavailable" });
        if (tag && !("field" in tag)) {
          let account: string;
          let revision: string;
          if ("gmail" in tag) {
            if (record.kind === "service" || !record.gmailGrant || !record.gmailClient)
              return yield* new SecretRequestError({ reason: "vault_gmail_not_connected" });
            account = record.gmailGrant.account;
            revision = record.gmailClient.revision;
          } else {
            const connection = record.serviceConnection;
            if (record.kind !== "service" || connection?.service !== tag.serviceRead.service)
              return yield* new SecretRequestError({ reason: "vault_service_not_connected" });
            if (!tag.revision || connection.revision !== tag.revision)
              return yield* new SecretRequestError({ reason: "vault_service_approval" });
            account = connection.account;
            revision = connection.revision;
          }
          if (!("account" in input.answer) || input.answer.account !== account)
            return yield* new SecretRequestError({
              reason: "gmail" in tag ? "vault_gmail_approval" : "vault_service_approval",
            });
          const approval: PrivateApproval = {
            threadId: input.threadId,
            turnItemId: item.id,
            runId,
            nodeId,
            name: answer.name,
            operation: "gmail" in tag ? tag.gmail : tag.serviceRead,
            account,
            revision,
            vaultEpoch,
          };
          const live = yield* requireLivePrivateCard(input.threadId, approval, "pending");
          if (live.label !== item.label)
            return yield* new SecretRequestError({ reason: "vault_tag_unavailable" });
          return [[undefined, approval]] as const;
        }
        if (record.kind === "service")
          return yield* new SecretRequestError({ reason: "vault_access_denied" });
        if (!vaultOriginMatches(record, item.url))
          return yield* new SecretRequestError({ reason: "vault_origin_mismatch" });
        approvedOrigin = record.kind === "login" ? record.origin : undefined;
        const keys = item.fields?.map((field) => field.name) ?? ["value"];
        if (Object.keys(answer.fields).length !== keys.length)
          return yield* new SecretRequestError({ reason: "fields_mismatch" });
        const entries: Array<readonly [FieldName, string]> = [];
        for (const key of keys) {
          const field = Object.hasOwn(answer.fields, key) ? answer.fields[key] : undefined;
          const value = field === undefined ? undefined : vaultField(record, field);
          if (!value) return yield* new SecretRequestError({ reason: "fields_mismatch" });
          entries.push([item.fields === undefined ? undefined : key, value]);
        }
        return entries;
      });
      if (
        input.answer.type === "reference" &&
        input.answer.reference.provider === LOCAL_VAULT_PROVIDER
      )
        return yield* new SecretRequestError({ reason: "vault_use_picker" });
      if (input.answer.type === "reference") {
        if (item.delivery === "file" && input.answer.discloseToCommands !== true)
          return yield* new SecretRequestError({ reason: "vault_disclosure_required" });
        vaultEpoch = yield* authorizeVaultUse(
          store,
          "external-reference",
          "command",
          input.answer.pin,
        ).pipe(
          Effect.mapError(
            (error) =>
              new SecretRequestError({
                reason:
                  error.code === "pin_not_set"
                    ? "vault_pin_not_set"
                    : error.code === "pin_required"
                      ? "vault_pin_required"
                      : error.code === "pin_invalid"
                        ? "vault_pin_invalid"
                        : error.code === "pin_locked"
                          ? "vault_pin_locked"
                          : "vault_access_denied",
              }),
          ),
        );
      }
      const values: ReadonlyArray<readonly [FieldName, string | PrivateApproval]> | undefined =
        answer.type === "vault"
          ? yield* readVaultAnswer(answer)
          : answer.type === "decline"
            ? undefined
            : answer.type === "reference" && item.fields === undefined
              ? [[undefined, yield* readReference(answer.reference)] as const]
              : (answerValues(item, answer) ??
                (yield* new SecretRequestError({ reason: "fields_mismatch" })));
      if (values !== undefined) {
        const savedAt = yield* Clock.currentTimeMillis;
        // Cleared when interrupted too, or a retry would keep these values beside its own.
        yield* Effect.forEach(values, ([field, value]) =>
          Effect.gen(function* () {
            if (display) {
              if (typeof value === "string" || !(yield* removeLogged(storeName(display.ref))))
                return yield* new SecretRequestError({ reason: "store_failed" });
              privateApprovals.set(display.ref, {
                approval: { ...value, projectId: records.thread.projectId, savedAt },
                reply: display.reply,
                claimed: false,
              });
              return;
            }
            if (typeof value !== "string")
              return yield* new SecretRequestError({ reason: "vault_access_denied" });
            const encoded = yield* encodeStored({
              projectId: records.thread.projectId,
              value,
              savedAt,
              ...(approvedOrigin === undefined ? {} : { origin: approvedOrigin }),
              ...(vaultEpoch === undefined ? {} : { vaultEpoch }),
            }).pipe(Effect.orDie);
            yield* store
              .create(
                storeName(yield* refFor(input.threadId, item.id, field)),
                new TextEncoder().encode(encoded),
              )
              .pipe(
                Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
                Effect.mapError(
                  (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
                ),
              );
          }),
        ).pipe(Effect.onError(() => removeAnswered(input.threadId, item)));
      }
      const secretStatus = values === undefined ? "declined" : "saved";
      yield* threadManagement
        .dispatch({
          type: "secret_request.record",
          commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          label: item.label,
          ...(item.taggedVault === undefined ? {} : { taggedVault: item.taggedVault }),
          reason: item.reason,
          ...(item.url === undefined ? {} : { url: item.url }),
          ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
          ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
          ...(item.fields === undefined ? {} : { fields: item.fields }),
          secretStatus,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          // Clear failed saves so the pending card can be answered again.
          Effect.tapError(() =>
            values !== undefined ? removeAnswered(input.threadId, item) : Effect.void,
          ),
        );
      if (values === undefined) return;
      // The wait may have closed the card; delete unrecorded answers because no one receives their refs.
      const recorded = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        );
      const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
      if (card?.type !== "secret_request" || card.secretStatus !== "saved") {
        yield* removeAnswered(input.threadId, item);
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
    },
    answerLock.withPermits(1),
    (effect, input, _display) =>
      effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if ("pin" in input.answer && input.answer.pin) Redacted.wipeUnsafe(input.answer.pin);
          }),
        ),
      ),
  );

  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(
    function* (input) {
      if (
        input.answer.type !== "vault_gmail_display" &&
        input.answer.type !== "vault_service_display"
      ) {
        yield* recordAnswer(input, undefined);
        return undefined;
      }
      const ref = yield* refFor(input.threadId, input.turnItemId);
      const reply = yield* Deferred.make<PrivateResult, SecretRequestError>();
      return yield* recordAnswer(input, { ref, reply }).pipe(
        Effect.andThen(
          Deferred.await(reply).pipe(
            Effect.timeoutOrElse({
              duration: PRIVATE_APPROVAL_TTL_MS,
              orElse: () => Effect.fail(new SecretRequestError({ reason: "ref_expired" })),
            }),
          ),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            if (privateApprovals.get(ref)?.reply === reply) privateApprovals.delete(ref);
            return Deferred.fail(reply, new SecretRequestError({ reason: "agent_stopped" }));
          }),
        ),
      );
    },
  );

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = yield* refFor(input.threadId, input.turnItemId);
      if (privateApprovals.has(ref)) return Option.some(ref);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // Serialize get/remove so concurrent consumers cannot read the same one-use ref.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  const readStored = Effect.fn("SecretRequests.readStored")(function* (ref: SecretRef) {
    if (!REF_PATTERN.test(ref)) return yield* new SecretRequestError({ reason: "invalid_ref" });
    const bytes = yield* store
      .get(storeName(ref))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
    const decoded = Option.flatMap(bytes, (value) => decodeStored(new TextDecoder().decode(value)));
    if (Option.isNone(decoded)) return yield* new SecretRequestError({ reason: "ref_unavailable" });
    return decoded.value;
  });

  const consumePrivate: SpendPrivate<PrivateOperation> = Effect.fn("SecretRequests.consumePrivate")(
    function* (input, currentSession) {
      const display = privateApprovals.get(input.ref);
      if (
        !display ||
        display.claimed ||
        display.approval.threadId !== input.threadId ||
        !sameOperation(display.approval.operation, input.operation)
      )
        return yield* new SecretRequestError({ reason: "ref_unavailable" });
      display.claimed = true;
      const approval = display.approval;
      const operation = approval.operation;
      const denied = new SecretRequestError({
        reason: "folder" in operation ? "vault_gmail_approval" : "vault_service_approval",
      });
      const checkApproval = Effect.gen(function* () {
        const live = yield* requireLivePrivateCard(input.threadId, approval, "saved");
        if (live.projectId !== approval.projectId)
          return yield* new SecretRequestError({ reason: "vault_tag_unavailable" });
        if ((yield* Clock.currentTimeMillis) - approval.savedAt >= PRIVATE_APPROVAL_TTL_MS) {
          return yield* new SecretRequestError({ reason: "ref_expired" });
        }
        if (!(yield* currentSession) || privateApprovals.get(input.ref) !== display)
          return yield* new SecretRequestError({ reason: "agent_stopped" });
        const record = yield* readVaultRecord(store, approval.name);
        // Writers change the epoch before editing a credential. Check it after reading the entry.
        const policy = yield* vaultSecuritySummary(store).pipe(
          Effect.mapError(() => new SecretRequestError({ reason: "vault_access_denied" })),
        );
        if (
          !record ||
          policy.epoch !== approval.vaultEpoch ||
          live.label !== vaultMentionLabel(record.title)
        )
          return yield* new SecretRequestError({ reason: "vault_access_denied" });
        if ("folder" in operation) {
          if (
            record.kind === "service" ||
            !record.gmailGrant ||
            !record.gmailClient ||
            record.gmailGrant.account !== approval.account ||
            record.gmailClient.revision !== approval.revision
          )
            return yield* denied;
          return {
            kind: "gmail" as const,
            operation,
            grant: record.gmailGrant,
            client: record.gmailClient,
          };
        }
        const connection = record.serviceConnection;
        if (
          record.kind !== "service" ||
          connection?.service !== operation.service ||
          connection.account !== approval.account ||
          connection.revision !== approval.revision
        )
          return yield* denied;
        return { kind: "service" as const, operation, connection };
      });
      const read = Effect.gen(function* () {
        const approved = yield* checkApproval;
        let result: PrivateResult;
        if (approved.kind === "gmail") {
          result = {
            messages: yield* listRecentGmail(approved.grant, approved.operation, approved.client),
          };
        } else {
          result = {
            items: yield* listConnectedItems(approved.connection, approved.operation).pipe(
              Effect.mapError(() => denied),
            ),
          };
        }
        // A slow upstream must not deliver private data into a cancelled or superseded operation.
        yield* checkApproval;
        return result;
      });
      return yield* Effect.gen(function* () {
        const result = yield* Effect.raceFirst(read, Deferred.await(display.reply));
        if (!(yield* Deferred.succeed(display.reply, result)))
          return yield* new SecretRequestError({ reason: "agent_stopped" });
        return {
          status: "displayed" as const,
          count: "items" in result ? result.items.length : result.messages.length,
        };
      }).pipe(Effect.onError(() => Deferred.fail(display.reply, denied)));
    },
  );

  /** A live ref's value, left in the store. */
  const readRef = Effect.fn("SecretRequests.readRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
    readonly targetUrl?: string;
  }) {
    const decoded = yield* readStored(input.ref);
    if (decoded.projectId !== input.projectId) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    if ((yield* Clock.currentTimeMillis) - decoded.savedAt > SECRET_REF_TTL_MS) {
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    if (decoded.vaultEpoch !== undefined) {
      const policy = yield* vaultSecuritySummary(store).pipe(
        Effect.mapError(() => new SecretRequestError({ reason: "vault_access_denied" })),
      );
      if (policy.epoch !== decoded.vaultEpoch)
        return yield* new SecretRequestError({ reason: "vault_access_denied" });
    }
    if (decoded.origin !== undefined) {
      const target = secretRequestPageUrl(input.targetUrl ?? "");
      if (
        !target ||
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.origin !== decoded.origin
      )
        return yield* new SecretRequestError({ reason: "vault_origin_mismatch" });
    }
    return decoded.value;
  });

  const consumeRef = Effect.fn("SecretRequests.consumeRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
    readonly targetUrl?: string;
  }) {
    const value = yield* readRef(input);
    // One use: the value moves into whatever consumed it. If it cannot be
    // deleted, it is not handed out, so a ref is never used twice.
    if (!(yield* removeLogged(storeName(input.ref)))) {
      return yield* new SecretRequestError({ reason: "consume_failed" });
    }
    return value;
  });

  const writeSecretFile = (dir: string, file: string, value: string) => {
    const partial = `${file}.partial`;
    return fileSystem.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.chmod(dir, 0o700)),
      Effect.andThen(fileSystem.remove(partial, { force: true })),
      // `wx` never follows or replaces an existing path.
      Effect.andThen(
        fileSystem.writeFile(partial, new TextEncoder().encode(value), {
          flag: "wx",
          mode: 0o600,
        }),
      ),
      Effect.andThen(fileSystem.rename(partial, file)),
      Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
    );
  };

  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may write it out.
    if (
      item?.type !== "secret_request" ||
      item.taggedVault !== undefined ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const projectId = records.thread.projectId;
    const deliver = Effect.fn("SecretRequests.deliverFile")(function* (field: FieldName) {
      const ref = yield* refFor(input.threadId, item.id, field);
      const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
      // One use: the file counts as delivered only once the stored copy is gone. A retry with the
      // same clientRequestId gets the file the first call wrote and finishes that removal.
      const removeStored = removeLogged(storeName(ref)).pipe(
        Effect.flatMap((removed) =>
          removed ? Effect.succeed(file) : new SecretRequestError({ reason: "consume_failed" }),
        ),
      );
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        return yield* removeStored;
      }
      // The stored value goes only after the file is complete, so a failed write can retry.
      const value = yield* readRef({
        ref,
        projectId,
        ...(item.url === undefined ? {} : { targetUrl: item.url }),
      });
      yield* writeSecretFile(filesDir, file, value);
      return yield* removeStored;
    });
    const { fields } = item;
    return yield* Effect.gen(function* () {
      if (fields === undefined) return { file: yield* deliver(undefined) };
      const files: Record<string, string> = {};
      for (const field of fields) files[field.name] = yield* deliver(field.name);
      return { files };
    }).pipe(consumeLock.withPermits(1));
  });

  const savePasted: SecretRequests["Service"]["savePasted"] = Effect.fn(
    "SecretRequests.savePasted",
  )(function* (input) {
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const ref = yield* refFor(
      input.threadId,
      `pasted\u0000${input.requestNamespace}\u0000${input.requestKey}`,
    );
    const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
    // A retry with the same clientRequestId gets the file the first call wrote, unchanged, so a
    // command already holding that path never reads another value.
    return yield* Effect.gen(function* () {
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) return file;
      yield* writeSecretFile(filesDir, file, input.value);
      return file;
    }).pipe(consumeLock.withPermits(1));
  });

  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS)) continue;
      yield* fileSystem.remove(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({
    answer,
    resolveTaggedEntry,
    resolveGmailEntry,
    resolveServiceEntry,
    consumeGmail: Effect.fn("SecretRequests.consumeGmail")((input, session) =>
      isGmailReadOperation(input.operation) && !("service" in input.operation)
        ? consumePrivate(input, session)
        : Effect.fail(new SecretRequestError({ reason: "ref_unavailable" })),
    ),
    consumeService: Effect.fn("SecretRequests.consumeService")((input, session) =>
      isVaultServiceRead(input.operation) && !("folder" in input.operation)
        ? consumePrivate(input, session)
        : Effect.fail(new SecretRequestError({ reason: "ref_unavailable" })),
    ),
    cancelPrivateDisplay: Effect.fn("SecretRequests.cancelPrivateDisplay")(
      function* (threadId, turnItemId) {
        const ref = yield* refFor(threadId, turnItemId);
        const display = privateApprovals.get(ref);
        if (!display) return;
        privateApprovals.delete(ref);
        yield* Deferred.fail(display.reply, new SecretRequestError({ reason: "agent_stopped" }));
      },
    ),
    savedRef,
    consume,
    saveToFile,
    savePasted,
  });
});

export const layer = Layer.effect(SecretRequests, make);
