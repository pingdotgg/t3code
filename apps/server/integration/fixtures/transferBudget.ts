import { EventId, ProviderDriverKind } from "@t3tools/contracts";

import type {
  FixtureProviderRuntimeEvent,
  TestTurnResponse,
} from "../TestProviderAdapter.integration.ts";

const FIXTURE_THREAD_ID = "transfer-budget-thread";
const FIXTURE_TURN_ID = "transfer-budget-turn";

const sourceModules = [
  "connection/session.ts",
  "connection/supervisor.ts",
  "rpc/client.ts",
  "rpc/protocol.ts",
  "state/shell.ts",
  "state/threads.ts",
  "state/threadReducer.ts",
  "state/shellReducer.ts",
  "state/threadSnapshotHttp.ts",
  "state/shellSnapshotHttp.ts",
  "orchestration/http.ts",
  "orchestration/Normalizer.ts",
  "orchestration/ActivityPayloadProjection.ts",
  "provider/ProviderService.ts",
  "provider/ProviderRuntimeIngestion.ts",
  "persistence/ProjectionSnapshotQuery.ts",
  "persistence/OrchestrationEventStore.ts",
  "checkpointing/CheckpointStore.ts",
  "checkpointing/CheckpointDiffQuery.ts",
  "server.ts",
] as const;

function fixtureTimestamp(turnIndex: number, eventIndex: number): string {
  const minute = String(turnIndex).padStart(2, "0");
  const second = String(eventIndex).padStart(2, "0");
  return `2026-06-01T00:${minute}:${second}.000Z`;
}

function diagnosticOutput(provider: ProviderDriverKind, turnIndex: number): string {
  return sourceModules
    .map((modulePath, index) => {
      const transferred = 1_024 + turnIndex * 137 + index * 83;
      const frames = 2 + ((turnIndex + index) % 7);
      const status = index % 5 === 0 ? "reviewed" : index % 3 === 0 ? "updated" : "unchanged";
      return [
        `[${String(index + 1).padStart(2, "0")}] ${modulePath}`,
        `provider=${provider} turn=${turnIndex + 1} status=${status}`,
        `decodedBytes=${transferred * 3} compressedBytes=${transferred} frames=${frames}`,
        `observation=subscription cursor remained monotonic after ${modulePath} emitted its update`,
      ].join("\n");
    })
    .join("\n\n");
}

function assistantChunks(provider: ProviderDriverKind, turnIndex: number): ReadonlyArray<string> {
  const providerName = provider === "codex" ? "Codex" : "Claude";
  return [
    `I traced the ${providerName} request through the environment connection and orchestration layers. `,
    `The transfer sample for turn ${turnIndex + 1} includes a command lifecycle, a projected activity, `,
    "a checkpoint diff, and the final assistant message. ",
    "The shell subscription receives only the latest thread shell while the thread subscription receives ",
    "incremental detail events. The existing conversation is not replayed over the socket.\n\n",
    "The focused verification keeps snapshot data on gzip-compressed HTTP and resumes both subscriptions ",
    "from the returned sequence. This response is intentionally split into the same small canonical text ",
    "deltas seen in real provider streams, while orchestration persists one completed assistant message.\n",
  ];
}

function unifiedDiff(provider: ProviderDriverKind, turnIndex: number): string {
  const lines = sourceModules
    .slice(0, 8)
    .flatMap((modulePath, index) => [
      `diff --git a/${modulePath} b/${modulePath}`,
      `--- a/${modulePath}`,
      `+++ b/${modulePath}`,
      `@@ -${index + 1},2 +${index + 1},3 @@`,
      ` const provider = "${provider}";`,
      `+const transferTurn = ${turnIndex + 1};`,
      `+const transferSample = ${1_500 + index * 97};`,
    ]);
  return lines.join("\n");
}

function baseEvent(
  provider: ProviderDriverKind,
  turnIndex: number,
  eventIndex: number,
): Pick<FixtureProviderRuntimeEvent, "eventId" | "provider" | "createdAt" | "threadId"> {
  return {
    eventId: EventId.make(`recorded:${provider}:${turnIndex}:${eventIndex}`),
    provider,
    createdAt: fixtureTimestamp(turnIndex, eventIndex),
    threadId: FIXTURE_THREAD_ID,
  };
}

/**
 * Canonical provider events shaped from real Codex and Claude event logs. The
 * content is synthetic so the fixture is safe to commit, while event ordering,
 * delta chunking, tool payloads, usage, and diff sizes remain representative.
 */
export function makeRecordedTransferTurn(
  provider: ProviderDriverKind,
  turnIndex: number,
): TestTurnResponse {
  const chunks = assistantChunks(provider, turnIndex);
  const events: FixtureProviderRuntimeEvent[] = [
    {
      type: "turn.started",
      ...baseEvent(provider, turnIndex, 0),
      turnId: FIXTURE_TURN_ID,
      payload: {
        model: provider === "codex" ? "gpt-5.4" : "claude-opus-4-1",
        effort: provider === "codex" ? "high" : "default",
      },
    },
    {
      type: "item.started",
      ...baseEvent(provider, turnIndex, 1),
      turnId: FIXTURE_TURN_ID,
      itemId: `tool-${turnIndex + 1}`,
      payload: {
        itemType: provider === "codex" ? "command_execution" : "file_change",
        status: "inProgress",
        title: provider === "codex" ? "Inspect transfer paths" : "Review transfer paths",
        detail: "Inspecting the HTTP snapshot and WebSocket projection boundaries.",
      },
    },
    {
      type: "item.completed",
      ...baseEvent(provider, turnIndex, 2),
      turnId: FIXTURE_TURN_ID,
      itemId: `tool-${turnIndex + 1}`,
      payload: {
        itemType: provider === "codex" ? "command_execution" : "file_change",
        status: "completed",
        title: provider === "codex" ? "Inspected transfer paths" : "Reviewed transfer paths",
        detail: "Collected a representative multi-module transfer diagnostic.",
        data: {
          command: provider === "codex" ? "vp test transfer-budget" : "review transfer budget",
          exitCode: 0,
          aggregatedOutput: diagnosticOutput(provider, turnIndex),
        },
      },
    },
    ...chunks.map(
      (delta, chunkIndex): FixtureProviderRuntimeEvent => ({
        type: "content.delta",
        ...baseEvent(provider, turnIndex, chunkIndex + 3),
        turnId: FIXTURE_TURN_ID,
        itemId: `assistant-${turnIndex + 1}`,
        payload: {
          streamKind: "assistant_text",
          delta,
          contentIndex: chunkIndex,
        },
      }),
    ),
    {
      type: "thread.token-usage.updated",
      ...baseEvent(provider, turnIndex, chunks.length + 3),
      turnId: FIXTURE_TURN_ID,
      payload: {
        usage: {
          usedTokens: 18_000 + turnIndex * 1_900,
          maxTokens: 200_000,
          inputTokens: 15_000 + turnIndex * 1_700,
          cachedInputTokens: 9_000 + turnIndex * 1_100,
          outputTokens: 3_000 + turnIndex * 200,
          toolUses: 1,
          durationMs: 4_000 + turnIndex * 250,
        },
      },
    },
    {
      type: "turn.diff.updated",
      ...baseEvent(provider, turnIndex, chunks.length + 4),
      turnId: FIXTURE_TURN_ID,
      payload: {
        unifiedDiff: unifiedDiff(provider, turnIndex),
      },
    },
    {
      type: "turn.completed",
      ...baseEvent(provider, turnIndex, chunks.length + 5),
      turnId: FIXTURE_TURN_ID,
      payload: {
        state: "completed",
        stopReason: "end_turn",
        usage: {
          inputTokens: 15_000 + turnIndex * 1_700,
          outputTokens: 3_000 + turnIndex * 200,
        },
      },
    },
  ];

  return { events };
}

export const TRANSFER_HISTORY_TURN_COUNT = 6;
