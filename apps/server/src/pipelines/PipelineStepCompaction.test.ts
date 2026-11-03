import { assert, it } from "@effect/vitest";

import {
  PIPELINE_COMPACTION_MIN_TOKENS,
  pipelineCompactionTarget,
  type PipelineCompactionRecords,
} from "./PipelineStepCompaction.ts";

const NOW = "2026-10-28T10:00:00.000Z";

const records = (
  overrides: {
    readonly thread?: Record<string, unknown>;
    readonly run?: Record<string, unknown>;
    readonly text?: string;
    readonly usedTokens?: number | null;
    readonly pendingRequest?: boolean;
    readonly backgroundTask?: boolean;
    readonly mergeBack?: boolean;
  } = {},
) =>
  ({
    thread: {
      id: "thread-1",
      providerInstanceId: "claudeAgent",
      activeProviderThreadId: "provider-thread-1",
      deletedAt: null,
      archivedAt: null,
      ...overrides.thread,
    },
    runs: [
      {
        id: "run-1",
        ordinal: 1,
        status: "completed",
        userMessageId: "message-1",
        providerThreadId: "provider-thread-1",
        providerInstanceId: "claudeAgent",
        ...overrides.run,
      },
    ],
    messages: [
      {
        id: "message-1",
        role: "user",
        text: overrides.text ?? "Build it",
        attachments: [],
      },
    ],
    providerThreads: [
      {
        id: "provider-thread-1",
        providerInstanceId: "claudeAgent",
        pendingBackgroundTasks: overrides.backgroundTask === true ? [{ taskId: "bg-1" }] : [],
      },
    ],
    providerTurns:
      overrides.usedTokens === null
        ? []
        : [
            {
              providerThreadId: "provider-thread-1",
              tokenUsage: { usedTokens: overrides.usedTokens ?? 80_000, updatedAt: NOW },
            },
          ],
    runtimeRequests: overrides.pendingRequest === true ? [{ status: "pending" }] : [],
    turnItems: [],
    contextTransfers:
      overrides.mergeBack === true
        ? [{ type: "merge_back", targetThreadId: "thread-1", status: "pending" }]
        : [],
  }) as unknown as PipelineCompactionRecords;

const ready = { providerCanCompact: true, instanceEnabled: true };

it("compacts a settled step, whatever its lineage or cache window", () => {
  assert.deepStrictEqual(pipelineCompactionTarget(records(), ready), { runId: "run-1" });
});

it("compacts when usage was never reported, and at exactly the threshold", () => {
  assert.isNotNull(pipelineCompactionTarget(records({ usedTokens: null }), ready));
  assert.isNotNull(
    pipelineCompactionTarget(records({ usedTokens: PIPELINE_COMPACTION_MIN_TOKENS }), ready),
  );
  assert.isNull(
    pipelineCompactionTarget(records({ usedTokens: PIPELINE_COMPACTION_MIN_TOKENS - 1 }), ready),
  );
});

it.each([
  ["deleted", records({ thread: { deletedAt: NOW } }), ready],
  ["archived", records({ thread: { archivedAt: NOW } }), ready],
  ["latest run still running", records({ run: { status: "running" } }), ready],
  ["latest run failed", records({ run: { status: "failed" } }), ready],
  ["latest run is a compaction", records({ text: " /Compact " }), ready],
  ["pending request", records({ pendingRequest: true }), ready],
  ["pending background work", records({ backgroundTask: true }), ready],
  ["pending merge-back", records({ mergeBack: true }), ready],
  ["no active provider thread", records({ thread: { activeProviderThreadId: null } }), ready],
  ["run on another provider thread", records({ run: { providerThreadId: "other" } }), ready],
  ["thread moved to another instance", records({ thread: { providerInstanceId: "codex" } }), ready],
  ["provider cannot compact", records(), { ...ready, providerCanCompact: false }],
  ["instance disabled", records(), { ...ready, instanceEnabled: false }],
] as const)("leaves the thread alone: %s", (_name, input, environment) => {
  assert.isNull(pipelineCompactionTarget(input, environment));
});
