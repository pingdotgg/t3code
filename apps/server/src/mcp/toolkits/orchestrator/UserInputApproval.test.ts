import {
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  ORCHESTRATOR_APPROVAL_BODY_SUFFIX,
  ORCHESTRATOR_APPROVAL_OPTIONS,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2StoredEvent,
  type OrchestratorApprovalReceiptInput,
  orchestratorApprovalQuestion,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";

import { EnvironmentSigningKey } from "../../../cloud/environmentKeys.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorToolkit } from "./tools.ts";
import { buildApprovalReceiptPayload, receiptResult } from "./UserInputApproval.ts";

const NOW = DateTime.makeUnsafe("2026-11-26T03:00:00.000Z");
const OPENED_AT = DateTime.makeUnsafe("2026-11-26T02:58:00.000Z");
const ANSWERED_AT = DateTime.makeUnsafe("2026-11-26T02:59:00.000Z");
const THREAD_ID = ThreadId.make("thread:approval-test");
const REQUEST_ID = RuntimeRequestId.make("request:approval-test");
const NODE_ID = NodeId.make("node:approval-test");
const QUESTION_ID = "approval";
const QUESTION = ORCHESTRATOR_APPROVAL_OPTIONS[0];
const DEFAULT = ORCHESTRATOR_APPROVAL_OPTIONS[1];
const BODY = "Please accept the exact evidence gap for this head.";
const PUBLIC_KEY = "test-environment-public-key";
const HEAD = "a".repeat(40);
const REVIEW_DIGEST = "b".repeat(64);
const SCOPE = {
  review_digest: REVIEW_DIGEST,
  category: "evidence",
  reason: "The exact residual is bounded by the linked evidence.",
  production_boundary: "No production write.",
  evidence: ["https://github.com/ArmorerLabs/Armorer-Platform/pull/3079"],
  findings: [],
  evidence_gaps: ["Range source provenance"],
};

const input = (
  overrides: Partial<OrchestratorApprovalReceiptInput> = {},
): OrchestratorApprovalReceiptInput => ({
  action: "receipt",
  threadId: THREAD_ID,
  requestId: REQUEST_ID,
  repository: "ArmorerLabs/Armorer-Platform",
  pullRequest: 3079,
  head: HEAD,
  reviewDigest: REVIEW_DIGEST,
  kind: "disposition",
  scopeEnvironment: "non_production",
  scope: SCOPE,
  body: BODY,
  ...overrides,
});

const question = (receipt = input()) =>
  orchestratorApprovalQuestion({
    repository: receipt.repository,
    pullRequest: receipt.pullRequest,
    head: receipt.head,
    reviewDigest: receipt.reviewDigest,
    kind: receipt.kind,
    scopeEnvironment: receipt.scopeEnvironment,
    scope: receipt.scope,
    body: receipt.body,
  });

const options = [
  { label: QUESTION, description: "Approve the exact scope." },
  { label: DEFAULT, description: "Use the timeout default." },
];

const event = (
  sequence: number,
  payload: OrchestrationV2StoredEvent["event"],
  options: {
    readonly commandId?: CommandId;
    readonly origin?: { readonly surface: "web" | "cli" };
  } = {},
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: options.commandId ?? null,
  ...(options.origin === undefined ? {} : { origin: options.origin }),
  event: payload,
});

const events = (
  overrides: {
    readonly answerOrigin?: { readonly surface: "web" | "cli" } | null;
    readonly completionOrigin?: { readonly surface: "web" | "cli" } | null;
    readonly completionCommandId?: CommandId;
    readonly body?: string;
    readonly questionText?: string;
    readonly answer?: string;
  } = {},
): ReadonlyArray<OrchestrationV2StoredEvent> => {
  const commandId = CommandId.make("command:approval-test");
  const cardQuestion = {
    id: QUESTION_ID,
    header: "Approval",
    question: overrides.questionText ?? question(input({ body: overrides.body ?? BODY })),
    options,
    multiSelect: false,
    allowCustomAnswer: false,
    required: true,
  };
  const answer = overrides.answer ?? QUESTION;
  const answerOrigin =
    overrides.answerOrigin === null
      ? undefined
      : (overrides.answerOrigin ?? { surface: "web" as const });
  const completionOrigin =
    overrides.completionOrigin === null ? undefined : (overrides.completionOrigin ?? answerOrigin);
  return [
    event(1, {
      id: EventId.make("event:pending"),
      type: "runtime-request.updated",
      threadId: THREAD_ID,
      occurredAt: OPENED_AT,
      payload: {
        id: REQUEST_ID,
        nodeId: NODE_ID,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: OPENED_AT,
        resolvedAt: null,
      },
    }),
    event(2, {
      id: EventId.make("event:question"),
      type: "turn-item.updated",
      threadId: THREAD_ID,
      occurredAt: OPENED_AT,
      payload: {
        id: TurnItemId.make("item:approval-test"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: NODE_ID,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: OPENED_AT,
        completedAt: null,
        updatedAt: OPENED_AT,
        type: "user_input_request",
        requestId: REQUEST_ID,
        questions: [cardQuestion],
      },
    }),
    event(
      3,
      {
        id: EventId.make("event:answer"),
        type: "runtime-request.updated",
        threadId: THREAD_ID,
        occurredAt: ANSWERED_AT,
        payload: {
          id: REQUEST_ID,
          nodeId: NODE_ID,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "resolved",
          responseCapability: { type: "message" },
          createdAt: OPENED_AT,
          resolvedAt: ANSWERED_AT,
          answers: { [QUESTION_ID]: answer },
        },
      },
      {
        commandId,
        ...(answerOrigin === undefined ? {} : { origin: answerOrigin }),
      },
    ),
    event(
      4,
      {
        id: EventId.make("event:completed"),
        type: "turn-item.updated",
        threadId: THREAD_ID,
        occurredAt: ANSWERED_AT,
        payload: {
          id: TurnItemId.make("item:approval-test"),
          threadId: THREAD_ID,
          runId: null,
          nodeId: NODE_ID,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: OPENED_AT,
          completedAt: ANSWERED_AT,
          updatedAt: ANSWERED_AT,
          type: "user_input_request",
          requestId: REQUEST_ID,
          questions: [cardQuestion],
          questionAnswer: {
            requestId: REQUEST_ID,
            questionTextById: { [QUESTION_ID]: cardQuestion.question },
            answers: { [QUESTION_ID]: answer },
            attachmentsByQuestionId: {},
          },
        },
      },
      {
        commandId: overrides.completionCommandId ?? commandId,
        ...(completionOrigin === undefined ? {} : { origin: completionOrigin }),
      },
    ),
  ];
};

const context = {
  environmentId: EnvironmentId.make("environment:approval-test"),
  threadLink: "t3-thread://environment:approval-test/thread:approval-test",
};

const build = (receipt = input(), stored = events()) =>
  buildApprovalReceiptPayload(receipt, stored, context, NOW).pipe(
    Effect.provide(Digest.layerWebCrypto),
  );

it.effect("binds the exact body and human answer into a receipt payload", () =>
  Effect.gen(function* () {
    const payload = yield* build();

    assert.equal(payload.body, BODY);
    assert.equal(
      payload.bodySha256,
      "0f9ce93956fba0b1ce975acbf0ca2522020650247d2a426499daca1c5aebbd46",
    );
    assert.equal(payload.origin.surface, "web");
    assert.equal(payload.answer, QUESTION);
    assert.include(payload.question, BODY);
    assert.equal((payload as Record<string, unknown>).iss, "t3-environment");
    assert.equal((payload as Record<string, unknown>).aud, "claude-review-gate");
    assert.equal(
      (payload as Record<string, unknown>).iat,
      Math.floor(NOW.epochMilliseconds / 1_000),
    );
    assert.equal(
      (payload as Record<string, unknown>).exp,
      Math.floor(NOW.epochMilliseconds / 1_000) + 24 * 60 * 60,
    );
  }),
);

it.effect("keeps a body ending in a newline stable through question trimming", () =>
  Effect.gen(function* () {
    const body = `${BODY}\n`;
    const exactQuestion = question(input({ body }));
    assert.equal(exactQuestion.trim(), exactQuestion);
    assert.isTrue(exactQuestion.endsWith(ORCHESTRATOR_APPROVAL_BODY_SUFFIX));

    const payload = yield* build(input({ body }), events({ body }));
    assert.equal(payload.body, body);
    assert.equal(payload.question, exactQuestion);
  }),
);

it.effect("rejects a card answered through an agent-only client surface", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(build(input(), events({ answerOrigin: { surface: "cli" } })));
    assert.include(error.message, "human T3 client");
  }),
);

it.effect("rejects an agent dispatch that has no human client origin", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      build(input(), events({ answerOrigin: null, completionOrigin: null })),
    );
    assert.include(error.message, "human T3 client");
  }),
);

it.effect("offers the receipt tool to goal chats and hides it from outside clients", () =>
  Effect.gen(function* () {
    const enabled = Context.getOrUndefined(
      OrchestratorToolkit.tools.t3_user_input_approval.annotations,
      McpSchema.EnabledWhen,
    );
    assert.isDefined(enabled);
    assert.strictEqual(enabled, McpInvocationContext.hiddenFromOutsideClients);
    const scope = (thread: McpInvocationContext.McpInvocationScope["thread"]) =>
      Effect.sync(McpInvocationContext.hiddenFromOutsideClients).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: context.environmentId,
          capabilities: new Set(["orchestration"] as const),
          issuedAt: 1,
          requestNamespace: "approval-tool-visibility",
          thread,
          client: undefined,
        }),
      );

    assert.isTrue(
      yield* scope({
        threadId: THREAD_ID,
        providerSessionId: "session:approval-test",
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    );
    assert.isFalse(yield* scope(undefined));
  }),
);

it.effect("rejects a receipt when the approved head changed", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(build(input({ head: "c".repeat(40) })));
    assert.include(error.message, "exact requested scope and body");
  }),
);

it.effect("rejects a receipt when the comment body changed", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(build(input({ body: `${BODY} changed` })));
    assert.include(error.message, "exact requested scope and body");
  }),
);

it.effect("rejects an answer and completion from different commands", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      build(input(), events({ completionCommandId: CommandId.make("command:other") })),
    );
    assert.include(error.message, "share one command");
  }),
);

it.effect("rejects the timeout default as an approval", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(build(input(), events({ answer: DEFAULT })));
    assert.include(error.message, "explicit approval option");
  }),
);

it.effect("signs a receipt with the environment key", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW.epochMilliseconds);
    const signingKey = EnvironmentSigningKey.of({
      publicKey: PUBLIC_KEY,
      sign: () => Effect.succeed("signed-token"),
    });
    const store = Layer.mock(EventStore.EventStoreV2)({
      read: (readInput) =>
        Stream.fromIterable(
          events().filter(
            (stored) =>
              readInput?.eventType === undefined || stored.event.type === readInput.eventType,
          ),
        ),
    });
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: context.environmentId,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
      requestNamespace: "approval-test",
      thread: {
        threadId: THREAD_ID,
        providerSessionId: "session:approval-test",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
    };
    const result = yield* receiptResult(input()).pipe(
      Effect.provide(Layer.merge(store, Digest.layerWebCrypto)),
      Effect.provideService(EnvironmentSigningKey, signingKey),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );

    assert.equal(result.token, "signed-token");
    assert.equal(result.publicKey, PUBLIC_KEY);
    assert.lengthOf(result.keyFingerprint, 64);
    assert.equal(result.payload.body, BODY);
  }),
);

it.effect("fails closed when the environment signing key is unavailable", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW.epochMilliseconds);
    const store = Layer.mock(EventStore.EventStoreV2)({
      read: (readInput) =>
        Stream.fromIterable(
          events().filter(
            (stored) =>
              readInput?.eventType === undefined || stored.event.type === readInput.eventType,
          ),
        ),
    });
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: context.environmentId,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
      requestNamespace: "approval-test",
      thread: {
        threadId: THREAD_ID,
        providerSessionId: "session:approval-test",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
    };
    const error = yield* Effect.flip(
      receiptResult(input()).pipe(
        Effect.provide(Layer.merge(store, Digest.layerWebCrypto)),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      ),
    );
    assert.include(error.message, "signing key is unavailable");
  }),
);
