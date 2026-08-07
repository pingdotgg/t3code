import { EventId, ProviderDriverKind } from "@t3tools/contracts";

import type {
  FixtureProviderRuntimeEvent,
  TestTurnResponse,
} from "../TestProviderAdapter.integration.ts";

const FIXTURE_THREAD_ID = "transfer-budget-thread";
const FIXTURE_TURN_ID = "transfer-budget-turn";

export const TRANSFER_HISTORY_TURN_COUNT = 10;
export const TRANSFER_HISTORY_TOOLS_PER_TURN = 5;
export const TRANSFER_MEASURED_TOOLS = 20;
export const TRANSFER_HISTORY_MCP_RESULT_BYTES = 900_000;
export const TRANSFER_MEASURED_MCP_RESULT_BYTES = 1_100_000;

const sourceModules = [
  "connection/session.ts",
  "connection/supervisor.ts",
  "rpc/client.ts",
  "rpc/protocol.ts",
  "state/threads.ts",
  "state/threadReducer.ts",
  "state/threadSnapshotHttp.ts",
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
  const second = String(Math.floor(eventIndex / 1_000)).padStart(2, "0");
  const millisecond = String(eventIndex % 1_000).padStart(3, "0");
  return `2026-06-01T00:${minute}:${second}.${millisecond}Z`;
}

function mix(value: number): number {
  let mixed = value | 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function digest(seed: number): string {
  return [0, 1, 2, 3]
    .map((offset) =>
      mix(seed + offset * 0x9e3779b9)
        .toString(16)
        .padStart(8, "0"),
    )
    .join("");
}

/** Produces safe, deterministic output with enough entropy to exercise gzip. */
function diagnosticOutput(input: {
  readonly provider: ProviderDriverKind;
  readonly turnIndex: number;
  readonly toolIndex: number;
  readonly targetBytes: number;
}): string {
  const chunks: string[] = [];
  const providerSeed = input.provider === "codex" ? 0x43_4f_44_45 : 0x43_4c_41_55;
  let length = 0;
  let lineIndex = 0;

  while (length < input.targetBytes) {
    const modulePath = sourceModules[(input.toolIndex + lineIndex) % sourceModules.length];
    const seed =
      providerSeed + input.turnIndex * 100_003 + input.toolIndex * 10_007 + lineIndex * 101;
    const line =
      `${String(lineIndex + 1).padStart(6, "0")} ${modulePath} ` +
      `operation=project-transfer-${input.turnIndex + 1}-${input.toolIndex + 1} ` +
      `cursor=${mix(seed)} digest=${digest(seed)} status=completed\n`;
    chunks.push(line);
    length += line.length;
    lineIndex += 1;
  }

  return chunks.join("").slice(0, input.targetBytes);
}

function assistantChunks(provider: ProviderDriverKind, turnIndex: number): ReadonlyArray<string> {
  const providerName = provider === "codex" ? "Codex" : "Claude";
  const paragraphs: string[] = [
    `I traced the ${providerName} request through the environment connection and orchestration layers. `,
  ];
  let paragraphIndex = 0;
  while (paragraphs.join("").length < 4_096) {
    const modulePath = sourceModules[paragraphIndex % sourceModules.length];
    paragraphs.push(
      `Pass ${paragraphIndex + 1} reviewed ${modulePath} for turn ${turnIndex + 1}. ` +
        "The shell cursor stayed monotonic, the thread snapshot remained resumable, and the client received only incremental events. ",
    );
    paragraphIndex += 1;
  }
  const text = paragraphs.join("").slice(0, 4_096);
  return Array.from({ length: Math.ceil(text.length / 256) }, (_, index) =>
    text.slice(index * 256, (index + 1) * 256),
  );
}

export function expectedRecordedAssistantText(
  provider: ProviderDriverKind,
  turnIndex: number,
): string {
  return assistantChunks(provider, turnIndex).join("");
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
 * Synthetic canonical events calibrated from heavy local Codex and Claude
 * threads. Ten historical turns produce 9 MB of retained MCP results without
 * committing user content. Command output is intentionally modest because the
 * client projection strips it.
 */
export function makeRecordedTransferTurn(
  provider: ProviderDriverKind,
  turnIndex: number,
): TestTurnResponse {
  const measuredTurn = turnIndex >= TRANSFER_HISTORY_TURN_COUNT;
  const toolCount = measuredTurn ? TRANSFER_MEASURED_TOOLS : TRANSFER_HISTORY_TOOLS_PER_TURN;
  const turnId = `${FIXTURE_TURN_ID}-${turnIndex + 1}`;
  const events: FixtureProviderRuntimeEvent[] = [];
  let eventIndex = 0;

  events.push({
    type: "turn.started",
    ...baseEvent(provider, turnIndex, eventIndex++),
    turnId,
    payload: {
      model: provider === "codex" ? "gpt-5.4" : "claude-opus-4-1",
      effort: provider === "codex" ? "high" : "default",
    },
  });

  for (let toolIndex = 0; toolIndex < toolCount; toolIndex += 1) {
    const itemId = `tool-${turnIndex + 1}-${toolIndex + 1}`;
    const command =
      provider === "codex"
        ? `vp test transfer-budget-${toolIndex + 1}`
        : `review transfer budget ${toolIndex + 1}`;
    events.push(
      {
        type: "item.started",
        ...baseEvent(provider, turnIndex, eventIndex++),
        turnId,
        itemId,
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: `Inspect transfer path ${toolIndex + 1}`,
          detail: "Inspecting the HTTP snapshot and WebSocket projection boundaries.",
          data: {
            threadId: FIXTURE_THREAD_ID,
            turnId,
            startedAtMs: turnIndex * 60_000 + eventIndex,
            item: {
              id: itemId,
              type: "commandExecution",
              command,
              cwd: "/workspace/transfer-budget",
              processId: String(toolIndex + 1),
              status: "inProgress",
              commandActions: [],
              aggregatedOutput: "",
            },
          },
        },
      },
      {
        type: "item.completed",
        ...baseEvent(provider, turnIndex, eventIndex++),
        turnId,
        itemId,
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: `Inspected transfer path ${toolIndex + 1}`,
          detail: "Collected a deterministic multi-module transfer diagnostic.",
          data: {
            threadId: FIXTURE_THREAD_ID,
            turnId,
            completedAtMs: turnIndex * 60_000 + eventIndex,
            item: {
              id: itemId,
              type: "commandExecution",
              command,
              cwd: "/workspace/transfer-budget",
              processId: String(toolIndex + 1),
              status: "completed",
              commandActions: [],
              aggregatedOutput: diagnosticOutput({
                provider,
                turnIndex,
                toolIndex,
                targetBytes: 1_000,
              }),
              exitCode: 0,
              durationMs: 500 + toolIndex,
            },
          },
        },
      },
    );
  }

  const mcpItemId = `mcp-${turnIndex + 1}`;
  const mcpResultBytes = measuredTurn
    ? TRANSFER_MEASURED_MCP_RESULT_BYTES
    : TRANSFER_HISTORY_MCP_RESULT_BYTES;
  events.push(
    {
      type: "item.started",
      ...baseEvent(provider, turnIndex, eventIndex++),
      turnId,
      itemId: mcpItemId,
      payload: {
        itemType: "mcp_tool_call",
        status: "inProgress",
        title: "fixture-history · inspect_transfer_log",
        detail: "Reading a retained diagnostic result from the provider history.",
        data: {
          startedAtMs: turnIndex * 60_000 + eventIndex,
          threadId: FIXTURE_THREAD_ID,
          turnId,
          item: {
            type: "mcpToolCall",
            id: mcpItemId,
            server: "fixture-history",
            tool: "inspect_transfer_log",
            arguments: { turn: turnIndex + 1 },
            status: "inProgress",
          },
        },
      },
    },
    {
      type: "item.completed",
      ...baseEvent(provider, turnIndex, eventIndex++),
      turnId,
      itemId: mcpItemId,
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "fixture-history · inspect_transfer_log",
        detail: "Retained a deterministic diagnostic result in the thread history.",
        data: {
          completedAtMs: turnIndex * 60_000 + eventIndex,
          threadId: FIXTURE_THREAD_ID,
          turnId,
          item: {
            type: "mcpToolCall",
            id: mcpItemId,
            server: "fixture-history",
            tool: "inspect_transfer_log",
            arguments: { turn: turnIndex + 1 },
            durationMs: 1_000 + turnIndex,
            error: null,
            result: {
              content: [
                {
                  type: "text",
                  text: diagnosticOutput({
                    provider,
                    turnIndex,
                    toolIndex: toolCount,
                    targetBytes: mcpResultBytes,
                  }),
                },
              ],
            },
            status: "completed",
          },
        },
      },
    },
  );

  const chunks = assistantChunks(provider, turnIndex);
  for (const [contentIndex, delta] of chunks.entries()) {
    events.push({
      type: "content.delta",
      ...baseEvent(provider, turnIndex, eventIndex++),
      turnId,
      itemId: `assistant-${turnIndex + 1}`,
      payload: {
        streamKind: "assistant_text",
        delta,
        contentIndex,
      },
    });
  }

  events.push(
    {
      type: "thread.token-usage.updated",
      ...baseEvent(provider, turnIndex, eventIndex++),
      turnId,
      payload: {
        usage: {
          usedTokens: 18_000 + turnIndex * 1_900,
          maxTokens: 200_000,
          inputTokens: 15_000 + turnIndex * 1_700,
          cachedInputTokens: 9_000 + turnIndex * 1_100,
          outputTokens: 3_000 + turnIndex * 200,
          toolUses: toolCount,
          durationMs: 4_000 + turnIndex * 250,
        },
      },
    },
    {
      type: "turn.diff.updated",
      ...baseEvent(provider, turnIndex, eventIndex++),
      turnId,
      payload: {
        unifiedDiff: unifiedDiff(provider, turnIndex),
      },
    },
    {
      type: "turn.completed",
      ...baseEvent(provider, turnIndex, eventIndex),
      turnId,
      payload: {
        state: "completed",
        stopReason: "end_turn",
        usage: {
          inputTokens: 15_000 + turnIndex * 1_700,
          outputTokens: 3_000 + turnIndex * 200,
        },
      },
    },
  );

  return { events };
}
