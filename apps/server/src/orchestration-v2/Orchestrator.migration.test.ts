import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  ContextHandoffId,
  OrchestrationV2Command,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";

import {
  appendContextHandoffId,
  canReplayCommandReceipt,
  isLegacyImportCovered,
  shouldPrepareLegacyImportHandoff,
} from "./Orchestrator.ts";

it("prepares imported context only for a v1 import without a completed V2 run", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

it("records a reissued legacy handoff on an existing provider thread", () => {
  const existingHandoffId = ContextHandoffId.make("handoff:legacy-import:existing");
  const retryHandoffId = ContextHandoffId.make("handoff:legacy-import:retry");

  assert.deepEqual(appendContextHandoffId([existingHandoffId], retryHandoffId), [
    existingHandoffId,
    retryHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], existingHandoffId), [
    existingHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], null), [existingHandoffId]);
});

it("only replays a command receipt for the thread it was recorded against", () => {
  const threadA = ThreadId.make("thread-a");
  const threadB = ThreadId.make("thread-b");

  assert.strictEqual(canReplayCommandReceipt(threadA, threadA), true);
  // A reused command id aimed at another thread must not report the first
  // thread's success as this thread's (v1 #5246).
  assert.strictEqual(canReplayCommandReceipt(threadA, threadB), false);
});

it("links and unlinks a pull request through thread.metadata.update (#8160)", () => {
  // The fold is exercised through the schema: a command carrying the link
  // must round-trip, and one without it must leave the field untouched.
  const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
  const linked = decode({
    type: "thread.metadata.update",
    commandId: "command-link",
    threadId: "thread-1",
    linkedPullRequest: {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 8160,
      url: "https://github.com/pingdotgg/t3code/pull/8160",
    },
  });
  assert.deepStrictEqual(
    (linked as Extract<typeof linked, { type: "thread.metadata.update" }>).linkedPullRequest,
    {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 8160,
      url: "https://github.com/pingdotgg/t3code/pull/8160",
    },
  );
  const unlinked = decode({
    type: "thread.metadata.update",
    commandId: "command-unlink",
    threadId: "thread-1",
    linkedPullRequest: null,
  });
  assert.strictEqual(
    (unlinked as Extract<typeof unlinked, { type: "thread.metadata.update" }>).linkedPullRequest,
    null,
  );
});

it("does not reissue imported context into a native thread that already has it", () => {
  const now = DateTime.makeUnsafe("2026-10-04T00:00:00Z");
  const threadId = ThreadId.make("import:claudeAgent:session");
  const codex = ProviderDriverKind.make("codex");
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread:provider:codex:native-thread:pending%3Arun%3A3"),
    driver: codex,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: codex, nativeId: "native:codex", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 3,
    lastRunOrdinal: 3,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const run3 = RunId.make("run:3");
  const legacy: OrchestrationV2ContextHandoff = {
    id: ContextHandoffId.make(
      "context-handoff:thread:import%3AclaudeAgent%3Asession:from-provider-instance:legacy:to-provider-instance:codex:1",
    ),
    transferId: null,
    threadId,
    targetRunId: run3,
    fromProviderThreadIds: [],
    toProviderThreadId: providerThread.id,
    coveredRunOrdinals: { from: 1, to: 1 },
    strategy: "manual_context",
    status: "ready",
    summaryMessageId: null,
    summaryText: "Imported conversation history",
    createdByProviderInstanceId: null,
    createdAt: now,
    updatedAt: now,
  };
  const delivered = (nativeThreadId: string, status: "injected") => ({
    ...legacy,
    delivery: { nativeThreadId, status, itemIds: [] },
  });
  const cancelled = [{ id: run3, status: "cancelled" as const }];

  // The only run was cancelled by a restart after its handoff was injected.
  assert.isTrue(
    isLegacyImportCovered({
      providerThread,
      contextHandoffs: [delivered("native:codex", "injected")],
      runs: cancelled,
    }),
  );
  // A replaced native thread still needs it.
  assert.isFalse(
    isLegacyImportCovered({
      providerThread,
      contextHandoffs: [delivered("native:old", "injected")],
      runs: cancelled,
    }),
  );
  // Undelivered: turn start redelivers it after a failed run, not after a cancelled one.
  assert.isTrue(
    isLegacyImportCovered({
      providerThread,
      contextHandoffs: [legacy],
      runs: [{ id: run3, status: "failed" }],
    }),
  );
  assert.isFalse(
    isLegacyImportCovered({ providerThread, contextHandoffs: [legacy], runs: cancelled }),
  );
});
