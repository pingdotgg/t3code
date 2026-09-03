import {
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionThreadMessage } from "../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionTurnById } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";
import { continueProviderThreadAfterReauthentication } from "./providerThreadContinuation.ts";

const threadId = ThreadId.make("thread-claude-auth");
const instanceId = ProviderInstanceId.make("claude-work");
const failedTurnId = TurnId.make("turn-claude-auth");
const failedMessageId = MessageId.make("message-claude-auth");
const timestamp = "2026-09-02T12:00:00.000Z";
const attachment = {
  type: "image" as const,
  id: "claude-auth-image",
  name: "toy.png",
  mimeType: "image/png",
  sizeBytes: 4,
};
const failedMessage = {
  messageId: failedMessageId,
  threadId,
  turnId: null,
  role: "user",
  text: "Reply with exactly: auth restored.",
  attachments: [attachment],
  isStreaming: false,
  createdAt: timestamp,
  updatedAt: timestamp,
} satisfies ProjectionThreadMessage;
const failedTurn = {
  threadId,
  turnId: failedTurnId,
  pendingMessageId: failedMessageId,
  sourceProposedPlanThreadId: null,
  sourceProposedPlanId: null,
  assistantMessageId: null,
  state: "error",
  requestedAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
  checkpointTurnCount: null,
  checkpointRef: null,
  checkpointStatus: null,
  checkpointFiles: [],
} satisfies ProjectionTurnById;
const failedTurnReads = {
  getTurnByTurnId: () => Effect.succeed(Option.some(failedTurn)),
  getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
  getMessageById: () => Effect.succeed(Option.some(failedMessage)),
};

function makeThread(session: OrchestrationThread["session"]): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-claude-auth"),
    title: "Claude auth",
    modelSelection: ModelSelection.make({
      instanceId,
      model: "claude-sonnet-4-5",
    }),
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: failedTurnId,
      state: "error",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      assistantMessageId: null,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    deletedAt: null,
    messages: [
      {
        id: failedMessageId,
        role: "user",
        text: "Reply with exactly: auth restored.",
        attachments: [attachment],
        turnId: null,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session,
  };
}

describe("continueProviderThreadAfterReauthentication", () => {
  it.effect("continues the matching failed Claude thread with its original prompt", () =>
    Effect.gen(function* () {
      const sends: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      const sendTurn: ProviderServiceShape["sendTurn"] = (input) =>
        Effect.sync(() => {
          sends.push(input);
          return { threadId, turnId: TurnId.make("continued-turn") };
        });
      const continued = yield* continueProviderThreadAfterReauthentication({
        threadId,
        instanceId,
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some(
              makeThread({
                threadId,
                status: "error",
                providerName: "claudeAgent",
                providerInstanceId: instanceId,
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: "Authentication failed",
                lastErrorClass: "auth_error",
                updatedAt: timestamp,
              }),
            ),
          ),
        ...failedTurnReads,
        getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
        sendTurn,
      });

      assert.isTrue(continued);
      assert.deepEqual(sends[0], {
        threadId,
        input: "Reply with exactly: auth restored.",
        attachments: [attachment],
        interactionMode: "plan",
      });
    }),
  );

  it.effect("does not continue after the thread has moved beyond the authentication error", () =>
    Effect.gen(function* () {
      const sends: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      const sendTurn: ProviderServiceShape["sendTurn"] = (input) =>
        Effect.sync(() => {
          sends.push(input);
          return { threadId, turnId: TurnId.make("unexpected-turn") };
        });
      const continued = yield* continueProviderThreadAfterReauthentication({
        threadId,
        instanceId,
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some(
              makeThread({
                threadId,
                status: "running",
                providerName: "claudeAgent",
                providerInstanceId: instanceId,
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: timestamp,
              }),
            ),
          ),
        ...failedTurnReads,
        getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
        sendTurn,
      });

      assert.isFalse(continued);
      assert.equal(sends.length, 0);
    }),
  );

  it.effect("does not invent a generic turn when the failed user input is unavailable", () =>
    Effect.gen(function* () {
      const sends: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      const thread = makeThread({
        threadId,
        status: "error",
        providerName: "claudeAgent",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "Authentication failed",
        lastErrorClass: "auth_error",
        updatedAt: timestamp,
      });
      const continued = yield* continueProviderThreadAfterReauthentication({
        threadId,
        instanceId,
        getThreadDetailById: () => Effect.succeed(Option.some(thread)),
        ...failedTurnReads,
        getMessageById: () => Effect.succeed(Option.none()),
        getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
        sendTurn: (input) =>
          Effect.sync(() => {
            sends.push(input);
            return { threadId, turnId: TurnId.make("unexpected-turn") };
          }),
      });

      assert.isFalse(continued);
      assert.equal(sends.length, 0);
    }),
  );

  it.effect("does not replay the failed prompt after a newer turn was queued", () =>
    Effect.gen(function* () {
      const sends: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      const thread = makeThread({
        threadId,
        status: "error",
        providerName: "claudeAgent",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "Authentication failed",
        lastErrorClass: "auth_error",
        updatedAt: timestamp,
      });
      const continued = yield* continueProviderThreadAfterReauthentication({
        threadId,
        instanceId,
        getThreadDetailById: () => Effect.succeed(Option.some(thread)),
        ...failedTurnReads,
        getPendingTurnStartByThreadId: () =>
          Effect.succeed(
            Option.some({
              threadId,
              messageId: MessageId.make("newer-message"),
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              requestedAt: "2026-09-02T12:01:00.000Z",
            }),
          ),
        getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
        sendTurn: (input) =>
          Effect.sync(() => {
            sends.push(input);
            return { threadId, turnId: TurnId.make("unexpected-turn") };
          }),
      });

      assert.isFalse(continued);
      assert.equal(sends.length, 0);
    }),
  );
});
