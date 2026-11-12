import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  buildBoundedThreadProjection,
  deferWorkHistoryRows,
  boundedTimelineEncodedBytes,
  computeLatestLocalTurnOrdinal,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  projectedRowBoundedSnapshotEncodedBytes,
  projectedRowEncodedBytes,
  selectHistoryPageFromCursor,
  selectDeferredWorkPage,
  selectRecentTimelineWindow,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD = ThreadId.make("thread-1");
const RUN = RunId.make("run-interrupt-1");
const NODE = NodeId.make("node-interrupt-1");

function makeRow(
  index: number,
  options?: { readonly outputBytes?: number },
): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`item-${index}`);
  const output =
    options?.outputBytes !== undefined ? "x".repeat(options.outputBytes) : `output-${index}`;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: THREAD,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function makeTurnStart(
  index: number,
  createdBy: "user" | "agent",
): OrchestrationV2ProjectedTurnItem {
  const row = makeRow(index);
  return {
    ...row,
    item: {
      ...row.item,
      type: "user_message",
      createdBy,
      creationSource: "provider",
      inputIntent: "turn_start",
      messageId: MessageId.make(`prompt-${index}`),
      text: `Prompt ${index}`,
      attachments: [],
    },
  } as OrchestrationV2ProjectedTurnItem;
}

function interruptItem(
  id: string,
  type: "run_interrupt_request" | "run_interrupt_result",
  ordinal: number,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    type,
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: type,
    message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  } as OrchestrationV2TurnItem;
}

function interruptRow(
  index: number,
  type: "run_interrupt_request" | "run_interrupt_result",
): OrchestrationV2ProjectedTurnItem {
  const item = interruptItem(
    type === "run_interrupt_request" ? "interrupt-req" : "interrupt-res",
    type,
    index + 1,
  );
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: item.id,
    item,
  };
}

function makeProjection(visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) {
  return {
    thread: {
      id: THREAD,
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [{ id: "run-1" }],
    attempts: [{ id: "attempt-1" }],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [{ id: "req-1" }],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as Parameters<typeof buildBoundedThreadProjection>[0]["projection"];
}



describe("threadHistoryPaging", () => {
  it("retains an out-of-window run_interrupt_request needed by a visible result", () => {
    const request = interruptRow(0, "run_interrupt_request");
    const filler = makeRow(1);
    const result = interruptRow(2, "run_interrupt_result");
    const full = makeProjection([request, filler, result]);
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 3,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "interrupt-res",
    ]);
    expect(bounded.projection.turnItems.map((item) => String(item.id)).sort()).toEqual([
      "interrupt-req",
      "interrupt-res",
    ]);
    expect(bounded.hasMoreHistory).toBe(true);
  });
  it("charges local row.item duplication when measuring bounded timeline bytes", () => {
    const rows = Array.from({ length: 8 }, (_, index) => makeRow(index, { outputBytes: 2_000 }));
    const full = makeProjection(rows);
    const maxEncodedBytes = 12_000;
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });

    const contribution = boundedTimelineEncodedBytes({
      visibleTurnItems: bounded.projection.visibleTurnItems,
      turnItems: bounded.projection.turnItems,
    });
    expect(contribution).toBeLessThanOrEqual(maxEncodedBytes);
    expect(bounded.projection.visibleTurnItems.length).toBeGreaterThan(0);
    expect(bounded.projection.visibleTurnItems.length).toBeLessThan(rows.length);

    const historyPage = selectRecentTimelineWindow({
      items: rows,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });
    const historyBytes = historyPage.items.reduce(
      (sum, row) => sum + projectedRowEncodedBytes(row),
      0,
    );
    expect(historyBytes).toBeLessThanOrEqual(maxEncodedBytes);
    expect(historyPage.items.length).toBeGreaterThan(bounded.projection.visibleTurnItems.length);

    const sample = rows[0]!;
    expect(projectedRowBoundedSnapshotEncodedBytes(sample, THREAD)).toBeGreaterThan(
      projectedRowEncodedBytes(sample),
    );
  });
  it("does not carry the full duplicated message table into a bounded snapshot", () => {
    const projection = makeProjection(Array.from({ length: 120 }, (_, index) => makeRow(index)));
    const full = {
      ...projection,
      messages: Array.from({ length: 2_000 }, (_, index) => ({
        id: MessageId.make(`message-${index}`),
        threadId: THREAD,
        runId: RunId.make(`old-run-${index}`),
        nodeId: null,
        role: "assistant" as const,
        text: "x".repeat(1_000),
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 9,
    });

    expect(bounded.projection.messages).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(bounded.projection), "utf8")).toBeLessThan(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes + 100_000,
    );
  });
  it("keeps a workflow coordinator's script outside the bounded window", () => {
    const projection = makeProjection(Array.from({ length: 120 }, (_, index) => makeRow(index)));
    const message = (index: number, workflowScript?: boolean) => ({
      id: MessageId.make(`message-${index}`),
      threadId: THREAD,
      runId: RunId.make(`old-run-${index}`),
      nodeId: null,
      role: "user" as const,
      text: `message ${index}`,
      attachments: [],
      streaming: false,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
      createdAt: NOW,
      updatedAt: NOW,
      ...(workflowScript === undefined ? {} : { workflowScript }),
    });
    const full = {
      ...projection,
      messages: [message(0, true), message(1, false), message(2)],
    } as typeof projection;

    const bounded = buildBoundedThreadProjection({ projection: full, snapshotSequence: 9 });

    expect(bounded.projection.messages.map((retained) => retained.id)).toEqual([
      MessageId.make("message-0"),
    ]);
  });
  it("omits historical control details that remain available from history items", () => {
    const projection = makeProjection(Array.from({ length: 200 }, (_, index) => makeRow(index)));
    const populated = {
      ...projection,
      plans: Array.from({ length: 120 }, (_, index) => ({
        id: `plan-${index}`,
        threadId: THREAD,
        runId: null,
        nodeId: `node-${index}`,
        status: "completed",
        kind: "proposed_plan",
        markdown: "p".repeat(2_097_152),
      })),
      contextHandoffs: Array.from({ length: 120 }, (_, index) => ({
        id: `handoff-${index}`,
        threadId: THREAD,
        targetRunId: "run-1",
        fromProviderThreadIds: [],
        toProviderThreadId: "provider-thread-1",
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context",
        status: "superseded",
        summaryMessageId: null,
        summaryText: "h".repeat(2_097_152),
        createdByProviderInstanceId: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: projectThreadProjectionForWire(populated),
      snapshotSequence: 9,
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(bounded.projection), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);
    expect(bounded.projection.plans).toEqual([]);
    expect(bounded.projection.contextHandoffs).toEqual([]);
    expect(populated.plans).toHaveLength(120);
    expect(
      populated.plans[0]?.kind === "proposed_plan" ? populated.plans[0].markdown.length : 0,
    ).toBe(2_097_152);
  });
  it("preserves oversized actionable state", () => {
    const projection = makeProjection([makeRow(0)]);
    const actionable = {
      ...projection,
      plans: [
        {
          id: "plan-actionable",
          threadId: THREAD,
          runId: null,
          nodeId: "node-actionable",
          status: "active",
          kind: "proposed_plan",
          markdown: "a".repeat(2_097_152),
        },
      ],
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({ projection: actionable, snapshotSequence: 9 });

    expect(bounded.projection.plans[0]).toEqual(actionable.plans[0]);
    expect(bounded.projection.visibleTurnItems).toEqual(actionable.visibleTurnItems);
  });
  it("keeps agent-only turns visible when checkpoint file lists fill the byte budget", () => {
    const items = Array.from({ length: 3 }, (_, turn) => {
      const first = makeRow(turn * 5);
      const prompt = {
        ...first,
        item: {
          ...first.item,
          type: "user_message" as const,
          createdBy: "agent" as const,
          creationSource: "provider" as const,
          inputIntent: "turn_start" as const,
          messageId: MessageId.make(`agent-prompt-${turn}`),
          text: `Step ${turn}`,
          attachments: [],
        },
      } as OrchestrationV2ProjectedTurnItem;
      return [prompt, ...Array.from({ length: 4 }, (_, index) => makeRow(turn * 5 + index + 1))];
    }).flat();
    const files = Array.from(
      { length: 15_000 },
      (_, index) =>
        `work/ws-${index % 40}/.jj/repo/store/extra/${index.toString(16).padStart(40, "0")}`,
    );
    const projection = {
      ...makeProjection(items),
      checkpoints: [{ id: "checkpoint-1", files }],
    } as unknown as ReturnType<typeof makeProjection>;

    const bounded = buildBoundedThreadProjection({ projection, snapshotSequence: 1 });

    expect(bounded.projection.visibleTurnItems).toHaveLength(items.length);
    expect(bounded.hasMoreHistory).toBe(false);
  });
  it("keeps paged historical plan detail in the turn item and only status in its artifact", () => {
    const detail = "Implement the historical plan exactly.\n".repeat(1_000);
    const item = {
      ...makeRow(0).item,
      type: "proposed_plan",
      planId: "plan-historical-visible",
      markdown: detail,
      streaming: false,
    } as OrchestrationV2TurnItem;
    const row = {
      ...makeRow(0),
      sourceItemId: item.id,
      item,
    } as OrchestrationV2ProjectedTurnItem;
    const base = makeProjection([row]);
    const projection = {
      ...base,
      plans: [
        {
          id: "plan-historical-visible",
          threadId: THREAD,
          runId: null,
          nodeId: "node-historical-visible",
          status: "completed",
          kind: "proposed_plan",
          markdown: detail,
        },
      ],
    } as unknown as typeof base;

    const bounded = buildBoundedThreadProjection({ projection, snapshotSequence: 9 });

    expect(bounded.projection.visibleTurnItems[0]?.item).toMatchObject({
      type: "proposed_plan",
      markdown: detail,
    });
    expect(bounded.projection.plans[0]).toMatchObject({
      status: "completed",
      markdown: "",
      detailInTurnItem: true,
    });
  });
});

