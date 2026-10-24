import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ContextTransferId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
      const providerMessage = ContextHandoffService.providerMessageWithContextHandoff({
        handoff,
        userText: "Continue from there.",
      });
      assert.include(providerMessage, handoff.summaryText);
      assert.include(providerMessage, "User message:\nContinue from there.");
    }),
  );

  it.effect("retains the frozen main snapshot and side-local history when changing providers", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const initial = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("side"),
        targetRunId: RunId.make("side-first"),
        toProviderThreadId: ProviderThreadId.make("side-codex"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "snapshot",
            text: "FROZEN_MAIN_PARTIAL",
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });
      const snapshotHistory = {
        ...initial.history!,
        coverage: "Frozen snapshot of main; recover omitted items from main.",
      };
      const handoff = yield* service.prepareProviderHandoff({
        threadId: ThreadId.make("side"),
        targetRunId: RunId.make("side-next"),
        transferId: ContextTransferId.make("side-switch"),
        fromProviderThreadIds: [ProviderThreadId.make("side-codex")],
        toProviderThreadId: ProviderThreadId.make("side-claude"),
        fromProviderInstanceId: ProviderInstanceId.make("codex"),
        toProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "full_thread_summary",
        initialHistory: snapshotHistory,
        items: [
          importedItem({
            role: "user",
            id: "side-question",
            text: "SIDE_LOCAL_QUESTION",
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
      });
      assert.include(handoff.summaryText, "FROZEN_MAIN_PARTIAL");
      assert.include(handoff.summaryText, "SIDE_LOCAL_QUESTION");
      assert.include(handoff.history!.coverage, snapshotHistory.coverage);
      assert.deepEqual(snapshotHistory.messages, initial.history!.messages);
      const delta = yield* service.prepareProviderHandoff({
        ...handoff,
        transferId: handoff.transferId,
        strategy: "delta_since_target_last_seen",
        initialHistory: snapshotHistory,
        fromProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "new-question", text: "NEW_SIDE_QUESTION", ordinal: 2 }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-04T00:00:00.000Z"),
      });
      assert.include(delta.summaryText, "NEW_SIDE_QUESTION");
      assert.notInclude(delta.summaryText, "FROZEN_MAIN_PARTIAL");
      assert.notInclude(delta.history!.coverage, snapshotHistory.coverage);
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});
