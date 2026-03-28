import fs from "node:fs";
import path from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ProviderKind,
  ThreadId,
  ModelSelection,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  gitRefExists,
  gitShowFileAtRef,
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);

const PROJECT_ID = asProjectId("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const FIXTURE_TURN_ID = "fixture-turn";
const APPROVAL_REQUEST_ID = asApprovalRequestId("req-approval-1");
type IntegrationProvider = ProviderKind;

function nowIso() {
  return new Date().toISOString();
}

class IntegrationWaitTimeoutError extends Schema.TaggedErrorClass<IntegrationWaitTimeoutError>()(
  "IntegrationWaitTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitForSync<A>(
  read: () => A,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 3000,
): Effect.Effect<A, never> {
  return Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const value = read();
      if (predicate(value)) {
        return value;
      }
      if (Date.now() >= deadline) {
        return yield* Effect.die(new IntegrationWaitTimeoutError({ description }));
      }
      yield* Effect.sleep(10);
    }
  });
}

function runtimeBase(eventId: string, createdAt: string, provider: IntegrationProvider = "codex") {
  return {
    eventId: asEventId(eventId),
    provider,
    createdAt,
  };
}

function withHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
  provider: IntegrationProvider = "codex",
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

function withRealCodexHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: "codex", realCodex: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const provider = harness.adapterHarness?.provider ?? "codex";
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider];

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Integration Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: {
        provider,
        model: defaultModel,
      },
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Integration Thread",
      modelSelection: {
        provider,
        model: defaultModel,
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

const startTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly modelSelection?: ModelSelection;
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: asMessageId(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    ...(input.modelSelection !== undefined
      ? {
          modelSelection: input.modelSelection,
        }
      : {}),
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: nowIso(),
  });

it.live("runs a single turn end-to-end and persists checkpoint state in sqlite + git", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      const turnResponse: TestTurnResponse = {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-single-1", "2026-02-24T10:00:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-single-2", "2026-02-24T10:00:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Single turn response.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-single-3", "2026-02-24T10:00:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      };

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-single",
        messageId: "msg-user-single",
        text: "Say hello",
      });
      const finalizedReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );
      if (finalizedReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(finalizedReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.messages.some(
            (message) => message.role === "assistant" && message.streaming === false,
          ) &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.checkpoints[0]?.status, "ready");
      assert.equal(thread.checkpoints[0]?.checkpointTurnCount, 1);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.equal(checkpointRows.length, 1);
      assert.equal(checkpointRows[0]?.checkpointTurnCount, 1);
      assert.equal(checkpointRows[0]?.status, "ready");
      assert.deepEqual(checkpointRows[0]?.files, []);

      const ref0 = checkpointRefForThreadTurn(THREAD_ID, 0);
      const ref1 = checkpointRefForThreadTurn(THREAD_ID, 1);
      assert.equal(gitRefExists(harness.workspaceDir, ref0), true);
      assert.equal(gitRefExists(harness.workspaceDir, ref1), true);
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref0, "README.md"), "v1\n");
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref1, "README.md"), "v1\n");
    }),
  ),
);

it.live.skipIf(!process.env.CODEX_BINARY_PATH)(
  "keeps the same Codex provider thread across runtime mode switches",
  () =>
    withRealCodexHarness((harness) =>
      Effect.gen(function* () {
        const createdAt = nowIso();

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-real-codex"),
          projectId: PROJECT_ID,
          title: "Integration Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-real-codex"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Integration Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-real-codex-1"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-1"),
            role: "user",
            text: "Reply with exactly ALPHA.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: nowIso(),
        });

        const firstThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.streaming === false,
            ),
          180_000,
        );
        assert.equal(firstThread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-real-codex-2"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-2"),
            role: "user",
            text: "Reply with exactly BETA.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });

        const secondThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.session.runtimeMode === "approval-required" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text.includes("BETA"),
            ),
          180_000,
        );
        assert.equal(secondThread.session?.threadId, "thread-1");
      }),
    ),
);

it.live("runs multi-turn file edits and persists checkpoint diffs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-1", "2026-02-24T10:01:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-multi-2", "2026-02-24T10:01:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-multi-3", "2026-02-24T10:01:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-4", "2026-02-24T10:01:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-5", "2026-02-24T10:01:00.400Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
          }),
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-multi-1",
        messageId: "msg-user-multi-1",
        text: "Make first edit",
      });
      yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.checkpoints.length === 1 && entry.session?.threadId === "thread-1",
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-6", "2026-02-24T10:02:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-7", "2026-02-24T10:02:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-8", "2026-02-24T10:02:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
          }),
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-multi-2",
        messageId: "msg-user-multi-2",
        text: "Make second edit",
      });
      const secondReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );
      if (secondReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(secondReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );

      const secondTurnThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn?.turnId === "turn-2" &&
          entry.checkpoints.length === 2 &&
          entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 2),
      );
      const secondCheckpoint = secondTurnThread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === 2,
      );
      assert.equal(
        secondCheckpoint?.files.some((file) => file.path === "README.md"),
        true,
      );

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.deepEqual(
        checkpointRows.map((row) => row.checkpointTurnCount),
        [1, 2],
      );

      const incrementalDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 1),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
      });
      assert.equal(incrementalDiff.includes("README.md"), true);

      const fullDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 0),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
      });
      assert.equal(fullDiff.includes("README.md"), true);

      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 1),
          "README.md",
        ),
        "v2\n",
      );
      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 2),
          "README.md",
        ),
        "v3\n",
      );
    }),
  ),
);

it.live("tracks approval requests and resolves pending approvals on user response", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-approval-1", "2026-02-24T10:03:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "approval.requested",
            ...runtimeBase("evt-approval-2", "2026-02-24T10:03:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            requestId: APPROVAL_REQUEST_ID,
            requestKind: "command",
            detail: "Approve command execution",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-approval-3", "2026-02-24T10:03:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-approval",
        messageId: "msg-user-approval",
        text: "Run command needing approval",
      });

      const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
        entry.activities.some((activity) => activity.kind === "approval.requested"),
      );
      assert.equal(
        thread.activities.some((activity) => activity.kind === "approval.requested"),
        true,
      );

      const pendingRow = yield* harness.waitForPendingApproval(
        "req-approval-1",
        (row) => row.status === "pending" && row.decision === null,
      );
      assert.equal(pendingRow.status, "pending");

      yield* harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: THREAD_ID,
        requestId: APPROVAL_REQUEST_ID,
        decision: "accept",
        createdAt: nowIso(),
      });

      const resolvedRow = yield* harness.waitForPendingApproval(
        "req-approval-1",
        (row) => row.status === "resolved" && row.decision === "accept",
      );
      assert.equal(resolvedRow.status, "resolved");
      assert.equal(resolvedRow.decision, "accept");

      const approvalResponses = yield* waitForSync(
        () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
        (responses) => responses.length === 1,
        "provider approval response",
      );
      assert.equal(approvalResponses.length, 1);
      assert.equal(approvalResponses[0]?.requestId, "req-approval-1");
      assert.equal(approvalResponses[0]?.decision, "accept");
    }),
  ),
);

it.live("records failed turn runtime state and checkpoint status as error", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-failure-1", "2026-02-24T10:04:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "content.delta",
            ...runtimeBase("evt-failure-2", "2026-02-24T10:04:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              streamKind: "assistant_text",
              delta: "Partial output before failure.\n",
            },
          },
          {
            type: "runtime.error",
            ...runtimeBase("evt-failure-3", "2026-02-24T10:04:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              message: "Sandbox command failed.",
            },
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-failure-4", "2026-02-24T10:04:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              state: "failed",
              errorMessage: "Sandbox command failed.",
            },
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-failure",
        messageId: "msg-user-failure",
        text: "Run risky command",
      });

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.lastError === "Sandbox command failed." &&
          entry.activities.some((activity) => activity.kind === "runtime.error") &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.session?.status, "error");
      assert.equal(thread.checkpoints[0]?.status, "error");

      const checkpointRow = yield* harness.checkpointRepository.getByThreadAndTurnCount({
        threadId: THREAD_ID,
        checkpointTurnCount: 1,
      });
      assert.equal(Option.isSome(checkpointRow), true);
      if (Option.isSome(checkpointRow)) {
        assert.equal(checkpointRow.value.status, "error");
      }
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
        true,
      );
    }),
  ),
);

it.live("reverts to an earlier checkpoint and trims checkpoint projections + git refs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-1", "2026-02-24T10:05:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-1-tool-started", "2026-02-24T10:05:00.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-1-tool-completed", "2026-02-24T10:05:00.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-1a", "2026-02-24T10:05:00.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-2", "2026-02-24T10:05:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
          }),
      });
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-revert-1",
        messageId: "msg-user-revert-1",
        text: "First edit",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.session?.threadId === "thread-1" && entry.checkpoints.length === 1,
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-3", "2026-02-24T10:05:01.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-3-tool-started", "2026-02-24T10:05:01.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-3-tool-completed", "2026-02-24T10:05:01.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-3a", "2026-02-24T10:05:01.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-4", "2026-02-24T10:05:01.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
          }),
      });
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-revert-2",
        messageId: "msg-user-revert-2",
        text: "Second edit",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn?.turnId === "turn-2" &&
          entry.checkpoints.length === 2 &&
          entry.activities.some((activity) => activity.turnId === "turn-2"),
        8000,
      );

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-checkpoint-revert"),
        threadId: THREAD_ID,
        turnCount: 1,
        createdAt: nowIso(),
      });

      yield* harness.waitForDomainEvent((event) => event.type === "thread.reverted");
      const revertedThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
      );
      assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
      assert.deepEqual(
        revertedThread.messages.map((message) => ({ role: message.role, text: message.text })),
        [
          { role: "user", text: "First edit" },
          { role: "assistant", text: "Updated README to v2.\n" },
        ],
      );
      assert.equal(
        revertedThread.activities.some((activity) => activity.turnId === "turn-2"),
        false,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === "turn-1" && activity.kind === "tool.started",
        ),
        true,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === "turn-1" && activity.kind === "tool.completed",
        ),
        true,
      );
      assert.equal(fs.readFileSync(path.join(harness.workspaceDir, "README.md"), "utf8"), "v2\n");
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
        false,
      );
      assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.equal(checkpointRows.length, 1);
    }),
  ),
);

it.live(
  "appends checkpoint.revert.failed activity when revert is requested without an active session",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("cmd-checkpoint-revert-no-session"),
          threadId: THREAD_ID,
          turnCount: 0,
          createdAt: nowIso(),
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some(
            (activity) =>
              activity.kind === "checkpoint.revert.failed" &&
              typeof activity.payload === "object" &&
              activity.payload !== null,
          ),
        );
        const failureActivity = thread.activities.find(
          (activity) => activity.kind === "checkpoint.revert.failed",
        );
        assert.equal(failureActivity !== undefined, true);
        assert.equal(
          String(
            (failureActivity?.payload as { readonly detail?: string } | undefined)?.detail,
          ).includes("No active provider session"),
          true,
        );
      }),
    ),
);

it.live("starts a claudeAgent session on first turn when provider is requested", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-start-1", "2026-02-24T10:10:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-start-2", "2026-02-24T10:10:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Claude first turn.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-start-3", "2026-02-24T10:10:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-initial",
          messageId: "msg-user-claude-initial",
          text: "Use Claude",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.session.status === "ready" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text === "Claude first turn.\n",
            ),
        );
        assert.equal(thread.session?.providerName, "claudeAgent");
      }),
    "claudeAgent",
  ),
);

it.live("recovers claudeAgent sessions after provider stopAll using persisted resume state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-recover-1", "2026-02-24T10:11:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-recover-2", "2026-02-24T10:11:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn before restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-recover-3", "2026-02-24T10:11:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-1",
          messageId: "msg-user-claude-recover-1",
          text: "Before restart",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.adapter.stopAll();
        yield* waitForSync(
          () => harness.adapterHarness!.listActiveSessionIds(),
          (sessionIds) => sessionIds.length === 0,
          "provider stopAll",
        );

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-recover-4", "2026-02-24T10:11:01.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-recover-5", "2026-02-24T10:11:01.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn after restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-recover-6", "2026-02-24T10:11:01.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-2",
          messageId: "msg-user-claude-recover-2",
          text: "After restart",
        });
        yield* waitForSync(
          () => harness.adapterHarness!.getStartCount(),
          (count) => count === 2,
          "claude provider recovery start",
        );

        const recoveredThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.messages.some(
              (message) => message.role === "user" && message.text === "After restart",
            ) &&
            !entry.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        );
        assert.equal(recoveredThread.session?.providerName, "claudeAgent");
        assert.equal(recoveredThread.session?.threadId, "thread-1");
      }),
    "claudeAgent",
  ),
);

it.live("forwards claudeAgent approval responses to the provider session", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-approval-1", "2026-02-24T10:12:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "approval.requested",
              ...runtimeBase("evt-claude-approval-2", "2026-02-24T10:12:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              requestId: APPROVAL_REQUEST_ID,
              requestKind: "command",
              detail: "Approve Claude tool call",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-approval-3", "2026-02-24T10:12:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-approval",
          messageId: "msg-user-claude-approval",
          text: "Need approval",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some((activity) => activity.kind === "approval.requested"),
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-claude-approval-respond"),
          threadId: THREAD_ID,
          requestId: APPROVAL_REQUEST_ID,
          decision: "accept",
          createdAt: nowIso(),
        });

        yield* harness.waitForPendingApproval(
          "req-approval-1",
          (row) => row.status === "resolved" && row.decision === "accept",
        );

        const approvalResponses = yield* waitForSync(
          () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
          (responses) => responses.length === 1,
          "claude provider approval response",
        );
        assert.equal(approvalResponses[0]?.decision, "accept");
      }),
    "claudeAgent",
  ),
);

it.live("forwards thread.turn.interrupt to claudeAgent provider sessions", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-interrupt-1", "2026-02-24T10:13:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-interrupt-2", "2026-02-24T10:13:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Long running output.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-interrupt-3", "2026-02-24T10:13:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-interrupt",
          messageId: "msg-user-claude-interrupt",
          text: "Start long turn",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) => entry.session?.threadId === "thread-1",
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-turn-interrupt-claude"),
          threadId: THREAD_ID,
          createdAt: nowIso(),
        });
        yield* harness.waitForDomainEvent(
          (event) => event.type === "thread.turn-interrupt-requested",
        );

        const interruptCalls = yield* waitForSync(
          () => harness.adapterHarness!.getInterruptCalls(THREAD_ID),
          (calls) => calls.length === 1,
          "claude provider interrupt call",
        );
        assert.equal(interruptCalls.length, 1);
      }),
    "claudeAgent",
  ),
);

it.live("reverts claudeAgent turns and rolls back provider conversation state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-revert-1", "2026-02-24T10:14:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-revert-2", "2026-02-24T10:14:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v2\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-revert-3", "2026-02-24T10:14:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-1",
          messageId: "msg-user-claude-revert-1",
          text: "First Claude edit",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-revert-4", "2026-02-24T10:14:01.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-revert-5", "2026-02-24T10:14:01.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v3\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-revert-6", "2026-02-24T10:14:01.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-2",
          messageId: "msg-user-claude-revert-2",
          text: "Second Claude edit",
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-2" &&
            entry.checkpoints.length === 2 &&
            entry.session?.providerName === "claudeAgent",
        );

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("cmd-checkpoint-revert-claude"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: nowIso(),
        });

        const revertedThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
        );
        assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
          true,
        );
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
          false,
        );
        assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);
      }),
    "claudeAgent",
  ),
);
