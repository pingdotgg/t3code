import {
  ORCHESTRATOR_APPROVAL_AUDIENCE,
  ORCHESTRATOR_APPROVAL_ISSUER,
  ORCHESTRATOR_APPROVAL_OPTIONS,
  type OrchestratorApprovalQuestionInput,
  type OrchestratorApprovalQuestionResult,
  type OrchestratorApprovalReceiptInput,
  type OrchestratorApprovalReceiptPayload,
  type OrchestratorApprovalReceiptResult,
  orchestratorApprovalQuestion,
  type OrchestrationV2StoredEvent,
  type ThreadId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { EnvironmentSigningKey } from "../../../cloud/environmentKeys.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const APPROVE = ORCHESTRATOR_APPROVAL_OPTIONS[0];
const DEFAULT = ORCHESTRATOR_APPROVAL_OPTIONS[1];
const HUMAN_SURFACES = new Set(["web", "desktop", "mobile"]);
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
const DISPOSITION_SCOPE_KEYS = new Set([
  "review_digest",
  "category",
  "reason",
  "production_boundary",
  "evidence",
  "findings",
  "evidence_gaps",
]);

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const require = (condition: unknown, message: string) =>
  condition ? Effect.void : Effect.fail(failure(message));

function canonicalJson(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalJson((value as Record<string, Schema.Json>)[key]!)]),
    );
  }
  return value;
}

function questionFor(input: OrchestratorApprovalQuestionInput | OrchestratorApprovalReceiptInput) {
  return orchestratorApprovalQuestion({
    ...input,
    scope: canonicalJson(input.scope),
  });
}

function validateScope(
  input: OrchestratorApprovalQuestionInput | OrchestratorApprovalReceiptInput,
) {
  if (input.kind === "receipt") {
    return require(typeof input.scope === "string" &&
      input.scope.trim().length > 0, "A receipt scope must be a non-empty string.");
  }
  return Effect.gen(function* () {
    yield* require(input.scope !== null &&
      typeof input.scope === "object" &&
      !Array.isArray(input.scope), "A disposition scope must be a JSON object.");
    const scope = input.scope as Record<string, unknown>;
    const keys = Object.keys(scope).sort();
    yield* require(keys.length === DISPOSITION_SCOPE_KEYS.size &&
      keys.every((key) =>
        DISPOSITION_SCOPE_KEYS.has(key),
      ), "A disposition scope must contain exactly the review_digest, category, reason, production_boundary, evidence, findings and evidence_gaps fields.");
    const evidence = scope.evidence;
    yield* require(Array.isArray(evidence) &&
      evidence.length > 0 &&
      evidence.every(
        (value) => typeof value === "string" && value.trim().length > 0,
      ), "A disposition scope needs at least one non-empty evidence string.");
  });
}

type ApprovalEventContext = {
  readonly environmentId: McpInvocationContext.McpInvocationScope["environmentId"];
  readonly threadLink: string;
};

type RuntimeRequestStoredEvent = OrchestrationV2StoredEvent & {
  readonly event: Extract<
    OrchestrationV2StoredEvent["event"],
    { readonly type: "runtime-request.updated" }
  >;
};

type UserInputRequestStoredEvent = OrchestrationV2StoredEvent & {
  readonly event: Extract<
    OrchestrationV2StoredEvent["event"],
    { readonly type: "turn-item.updated" }
  > & {
    readonly payload: Extract<
      Extract<
        OrchestrationV2StoredEvent["event"],
        { readonly type: "turn-item.updated" }
      >["payload"],
      { readonly type: "user_input_request" }
    >;
  };
};

function humanOrigin(origin: OrchestrationV2StoredEvent["origin"]) {
  return origin !== undefined && origin.surface !== undefined && HUMAN_SURFACES.has(origin.surface)
    ? origin
    : undefined;
}

export const buildApprovalReceiptPayload = Effect.fn(
  "UserInputApproval.buildApprovalReceiptPayload",
)(function* (
  input: OrchestratorApprovalReceiptInput,
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
  context: ApprovalEventContext,
  now: DateTime.Utc,
): Effect.fn.Return<OrchestratorApprovalReceiptPayload, OrchestratorMcpFailure, Digest.Digest> {
  yield* validateScope(input);
  const question = questionFor(input);
  const ordered = events.toSorted((left, right) => left.sequence - right.sequence);

  const pendingRequests: Array<RuntimeRequestStoredEvent> = [];
  const resolvedRequests: Array<RuntimeRequestStoredEvent> = [];
  const initialItems: Array<UserInputRequestStoredEvent> = [];
  const completedItems: Array<UserInputRequestStoredEvent> = [];
  for (const stored of ordered) {
    const event = stored.event;
    if (
      event.type === "runtime-request.updated" &&
      event.payload.id === input.requestId &&
      event.payload.kind === "user_input"
    ) {
      const request = { ...stored, event } satisfies RuntimeRequestStoredEvent;
      if (event.payload.status === "pending") pendingRequests.push(request);
      if (event.payload.status === "resolved") resolvedRequests.push(request);
    }
    if (
      event.type === "turn-item.updated" &&
      event.payload.type === "user_input_request" &&
      event.payload.requestId === input.requestId
    ) {
      const item = { ...stored, event } as UserInputRequestStoredEvent;
      if (event.payload.status === "completed") completedItems.push(item);
      else if (event.payload.status !== "cancelled" && event.payload.questions.length > 0) {
        initialItems.push(item);
      }
    }
  }

  yield* require(pendingRequests.length === 1, "The T3 card has no single pending request event.");
  yield* require(resolvedRequests.length ===
    1, "The T3 card has no single resolved request event.");
  yield* require(initialItems.length > 0, "The T3 card has no question event.");
  yield* require(completedItems.length ===
    1, "The T3 card has no single completed question event.");

  const pending = pendingRequests[0]!;
  const resolved = resolvedRequests[0]!;
  const initial = initialItems[0]!;
  const completed = completedItems[0]!;

  yield* require(pending.sequence < initial.sequence &&
    initial.sequence < resolved.sequence &&
    resolved.sequence <
      completed.sequence, "The T3 card event order does not match one request and one answer.");
  yield* require(pending.event.payload.nodeId === resolved.event.payload.nodeId &&
    pending.event.payload.nodeId === initial.event.payload.nodeId &&
    pending.event.payload.providerTurnId === resolved.event.payload.providerTurnId &&
    pending.event.payload.providerTurnId ===
      initial.event.payload
        .providerTurnId, "The T3 card request, question and answer do not name the same node and provider turn.");
  yield* require((pending.event.runId ?? null) === initial.event.payload.runId &&
    (resolved.event.runId ?? null) ===
      completed.event.payload.runId, "The T3 card request and answer do not name the same run.");
  yield* require(Equal.equals(
    initial.event.payload.questions,
    completed.event.payload.questions,
  ), "The T3 card question changed before it was answered.");

  const questions = initial.event.payload.questions;
  yield* require(questions.length === 1, "The T3 card must contain exactly one question.");
  const cardQuestion = questions[0]!;
  yield* require(cardQuestion.question ===
    question, "The T3 card question does not bind the exact requested scope and body.");
  yield* require(cardQuestion.options.map((option) => option.label).join("\u0000") ===
    ORCHESTRATOR_APPROVAL_OPTIONS.join(
      "\u0000",
    ), "The T3 card options differ from the required approval options.");
  yield* require(cardQuestion.multiSelect !== true, "The T3 approval card must be single-select.");
  yield* require(cardQuestion.allowCustomAnswer !==
    true, "The T3 approval card must not allow a custom answer.");
  yield* require(cardQuestion.required !== false, "The T3 approval question must be required.");

  const answers = resolved.event.payload.answers;
  if (answers === undefined) return yield* failure("The T3 card has no recorded answer.");
  const answerEntries = Object.entries(answers);
  yield* require(answerEntries.length === 1, "The T3 card must contain exactly one answer.");
  const [answerKey, answer] = answerEntries[0]!;
  yield* require(answerKey === cardQuestion.id ||
    answerKey === cardQuestion.question, "The T3 answer does not name the stored question.");
  yield* require(answer === APPROVE, "The T3 card answer is not the explicit approval option.");
  yield* require(answer !== DEFAULT, "The T3 card selected the timeout default.");

  const questionAnswer = completed.event.payload.questionAnswer;
  if (questionAnswer === undefined) {
    return yield* failure("The completed T3 card has no recorded answer.");
  }
  yield* require(questionAnswer.requestId ===
    input.requestId, "The completed T3 card answer names another request.");
  yield* require(Equal.equals(
    questionAnswer.answers,
    answers,
  ), "The completed T3 card answer differs from the request answer.");
  const questionTextById = questionAnswer.questionTextById;
  if (questionTextById === undefined) {
    return yield* failure("The completed T3 card has no question text binding.");
  }
  yield* require(questionTextById[cardQuestion.id] === cardQuestion.question ||
    questionTextById[cardQuestion.question] ===
      cardQuestion.question, "The completed T3 card question text differs from the answered question.");

  const answerOrigin = humanOrigin(resolved.origin);
  const itemOrigin = humanOrigin(completed.origin);
  yield* require(answerOrigin !== undefined, "The T3 answer did not come from a human T3 client.");
  yield* require(itemOrigin !==
    undefined, "The completed T3 card did not come from a human T3 client.");
  yield* require(answerOrigin?.surface ===
    itemOrigin?.surface, "The T3 answer and completed card came from different client surfaces.");
  yield* require(resolved.commandId !== null &&
    resolved.commandId ===
      completed.commandId, "The T3 answer and completed card do not share one command.");

  const openedAt = DateTime.formatIso(pending.event.payload.createdAt);
  const answeredAt = resolved.event.payload.resolvedAt;
  const completedAt = completed.event.payload.completedAt;
  if (answeredAt === null) return yield* failure("The T3 card has no answer time.");
  if (completedAt === null) return yield* failure("The T3 card has no completion time.");
  const issuedAt = DateTime.formatIso(now);
  const expiresAt = DateTime.formatIso(DateTime.add(now, { milliseconds: RECEIPT_TTL_MS }));
  const answeredMillis = DateTime.toEpochMillis(answeredAt);
  const completedMillis = DateTime.toEpochMillis(completedAt);
  const issuedMillis = DateTime.toEpochMillis(now);
  yield* require(Number.isFinite(answeredMillis) &&
    Number.isFinite(completedMillis) &&
    answeredMillis <= completedMillis &&
    completedMillis <=
      issuedMillis, "The T3 card answer, completion and receipt times are out of order.");

  const bodySha256 = yield* (yield* Digest.Digest)
    .digestHex(Digest.sha256, new TextEncoder().encode(input.body))
    .pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The T3 environment could not hash the exact approval body.",
          }),
      ),
    );
  return {
    schema: "t3-user-input-approval/v1",
    iss: ORCHESTRATOR_APPROVAL_ISSUER,
    aud: ORCHESTRATOR_APPROVAL_AUDIENCE,
    iat: Math.floor(issuedMillis / 1_000),
    exp: Math.floor((issuedMillis + RECEIPT_TTL_MS) / 1_000),
    environmentId: context.environmentId,
    threadId: input.threadId,
    threadLink: context.threadLink,
    requestId: input.requestId,
    requestEventId: String(pending.event.id),
    requestSequence: pending.sequence,
    answerEventId: String(resolved.event.id),
    answerSequence: resolved.sequence,
    turnItemEventId: String(completed.event.id),
    turnItemSequence: completed.sequence,
    repository: input.repository,
    pullRequest: input.pullRequest,
    head: input.head,
    reviewDigest: input.reviewDigest,
    kind: input.kind,
    scopeEnvironment: input.scopeEnvironment,
    scope: canonicalJson(input.scope),
    body: input.body,
    bodySha256,
    question,
    options: [...ORCHESTRATOR_APPROVAL_OPTIONS],
    answer: APPROVE,
    answerSource: "explicit_nondefault",
    origin: answerOrigin!,
    openedAt,
    answeredAt: DateTime.formatIso(answeredAt),
    issuedAt,
    expiresAt,
  };
});

export const questionResult = (
  input: OrchestratorApprovalQuestionInput,
): Effect.Effect<OrchestratorApprovalQuestionResult, OrchestratorMcpFailure> =>
  validateScope(input).pipe(
    Effect.as({
      action: "question" as const,
      question: questionFor(input),
      options: [...ORCHESTRATOR_APPROVAL_OPTIONS],
    }),
  );

const readApprovalEvents = Effect.fn("readApprovalEvents")(function* (threadId: ThreadId) {
  const store = yield* Effect.serviceOption(EventStore.EventStoreV2);
  if (Option.isNone(store)) {
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "The T3 event store is unavailable for this approval receipt.",
    });
  }
  const read = (eventType: "runtime-request.updated" | "turn-item.updated") =>
    store.value.read({ threadId, eventType }).pipe(
      Stream.runCollect,
      Effect.map((events) => Array.from(events)),
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Could not read the T3 card event chain.",
          }),
      ),
    );
  const [requests, items] = yield* Effect.all([
    read("runtime-request.updated"),
    read("turn-item.updated"),
  ]);
  return [...requests, ...items];
});

export const receiptResult = Effect.fn("UserInputApproval.receiptResult")(function* (
  input: OrchestratorApprovalReceiptInput,
): Effect.fn.Return<
  OrchestratorApprovalReceiptResult,
  OrchestratorMcpFailure,
  McpInvocationContext.McpInvocationContext | Digest.Digest
> {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const events = yield* readApprovalEvents(input.threadId);
  const now = yield* DateTime.now;
  const payload = yield* buildApprovalReceiptPayload(
    input,
    events,
    {
      environmentId: scope.environmentId,
      threadLink: McpInvocationContext.threadLinkFor(scope, input.threadId),
    },
    now,
  );
  const signingKey = yield* Effect.serviceOption(EnvironmentSigningKey);
  if (Option.isNone(signingKey)) {
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "The T3 environment signing key is unavailable for this approval receipt.",
    });
  }
  const token = yield* signingKey.value.sign({ typ: "t3-user-input-approval+jwt", payload }).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The T3 environment could not sign the approval receipt.",
        }),
    ),
  );
  const publicKey = signingKey.value.publicKey;
  const keyFingerprint = yield* (yield* Digest.Digest)
    .digestHex(Digest.sha256, new TextEncoder().encode(publicKey))
    .pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The T3 environment could not fingerprint its public key.",
          }),
      ),
    );
  return {
    action: "receipt",
    token,
    publicKey,
    keyFingerprint,
    payload,
  };
});
