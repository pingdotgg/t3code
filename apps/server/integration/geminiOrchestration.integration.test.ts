import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);

const FIXTURE_TURN_ID = "fixture-turn";

function nowIso() {
  return new Date().toISOString();
}

function runtimeBase(eventId: string, createdAt: string, provider: "codex" | "gemini") {
  return {
    eventId: asEventId(eventId),
    provider,
    createdAt,
  };
}

function withGeminiHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: "gemini" }),
    use,
    (harness) => harness.dispose,
  );
}

it.live("runs a Gemini turn end-to-end and persists state", () =>
  withGeminiHarness(
    (harness) =>
      Effect.gen(function* () {
        const createdAt = nowIso();
        const projectId = asProjectId("project-gemini");
        const threadId = ThreadId.makeUnsafe("thread-gemini");

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-gemini"),
          projectId,
          title: "Gemini Integration Project",
          workspaceRoot: harness.workspaceDir,
          defaultModel: "gemini-2.5-pro",
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-gemini"),
          threadId,
          projectId,
          title: "Gemini Integration Thread",
          model: "gemini-2.5-pro",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt,
        });

        const turnResponse: TestTurnResponse = {
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-gemini-1", "2026-02-24T10:00:00.000Z", "gemini"),
              threadId,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-gemini-2", "2026-02-24T10:00:00.100Z", "gemini"),
              threadId,
              turnId: FIXTURE_TURN_ID,
              delta: "Gemini response.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-gemini-3", "2026-02-24T10:00:00.200Z", "gemini"),
              threadId,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        };

        yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse);

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-gemini"),
          threadId,
          message: {
            messageId: asMessageId("msg-user-gemini"),
            role: "user",
            text: "Hello Gemini",
            attachments: [],
          },
          provider: "gemini",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });

        const thread = yield* harness.waitForThread(
          threadId,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.streaming === false,
            ) &&
            entry.checkpoints.length === 1,
        );
        assert.equal(thread.session?.providerName, "gemini");
        assert.equal(thread.checkpoints.length, 1);
      }),
  ),
);

it.live("handles Gemini mid-turn user approval requests end-to-end", () =>
  withGeminiHarness(
    (harness) =>
      Effect.gen(function* () {
        const projectId = asProjectId("project-gemini-appr");
        const threadId = ThreadId.makeUnsafe("thread-gemini-appr");
        const approvalRequestId = asApprovalRequestId("req-gemini-approval-1");
        const createdAt = nowIso();

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-gemini-appr"),
          projectId,
          title: "Gemini Approval Project",
          workspaceRoot: harness.workspaceDir,
          defaultModel: "gemini-2.5-pro",
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-gemini-appr"),
          threadId,
          projectId,
          title: "Gemini Approval Thread",
          model: "gemini-2.5-pro",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt,
        });

        const approvalTurnResponse: TestTurnResponse = {
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-appr-1", "2026-02-24T10:00:00.000Z", "gemini"),
              threadId,
              turnId: "turn-1",
            },
            {
              type: "approval.requested",
              ...runtimeBase("evt-appr-2", "2026-02-24T10:00:00.100Z", "gemini"),
              threadId,
              turnId: "turn-1",
              requestId: approvalRequestId,
              requestKind: "command",
              detail: "ls -la",
            },
            {
              type: "approval.resolved",
              ...runtimeBase("evt-appr-3", "2026-02-24T10:00:05.000Z", "gemini"),
              threadId,
              turnId: "turn-1",
              requestId: approvalRequestId,
              requestKind: "command",
              decision: "accept",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-appr-4", "2026-02-24T10:00:05.100Z", "gemini"),
              threadId,
              turnId: "turn-1",
              status: "completed",
            },
          ],
        };

        yield* harness.adapterHarness!.queueTurnResponseForNextSession(approvalTurnResponse);
        
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-gemini-appr-start"),
          threadId,
          message: {
            messageId: asMessageId("msg-user-gemini-appr"),
            role: "user",
            text: "Run a command",
            attachments: [],
          },
          provider: "gemini",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });

        const pendingRow = yield* harness.waitForPendingApproval(
          String(approvalRequestId),
          (row) => row.status === "pending",
        );
        assert.equal(pendingRow.status, "pending");

        yield* harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-gemini-appr-respond"),
          threadId,
          requestId: approvalRequestId,
          decision: "accept",
          createdAt: nowIso(),
        });

        yield* harness.waitForPendingApproval(String(approvalRequestId), (row) => row.status === "resolved");

        const finalThread = yield* harness.waitForThread(
          threadId,
          (entry) => entry.session?.status === "ready" && entry.checkpoints.length === 1,
        );
        assert.equal(finalThread.checkpoints.length, 1);

        // Verify Provider response was called
        const approvalResponses = harness.adapterHarness!.getApprovalResponses(threadId);
        assert.equal(approvalResponses.length, 1);
        assert.equal(approvalResponses[0]?.requestId, approvalRequestId);
        assert.equal(approvalResponses[0]?.decision, "accept");
      }),
  ),
);
