import {
  ContextHandoffId,
  ContextTransferId,
  OrchestrationV2ThreadStreamItem,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";

import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";

const NOW = DateTime.makeUnsafe("2026-09-08T00:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-stream-test");

function timelineProjection(itemCount: number): OrchestrationV2ThreadProjection {
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = Array.from(
    { length: itemCount },
    (_, index) => {
      const id = TurnItemId.make(`item-${index}`);
      const item = {
        id,
        type: "command_execution",
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 1,
        status: "completed",
        title: `Command ${index}`,
        input: `command-${index}`,
        output: `output-${index}`,
        exitCode: 0,
        startedAt: NOW,
        completedAt: NOW,
        updatedAt: NOW,
      } satisfies OrchestrationV2TurnItem;
      return {
        position: index,
        visibility: "local",
        sourceThreadId: THREAD_ID,
        sourceItemId: id,
        item,
      };
    },
  );
  return {
    thread: {
      id: THREAD_ID,
      projectId: "project-stream-test",
      title: "Thread stream test",
      providerInstanceId: "codex",
      modelSelection: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD_ID,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as OrchestrationV2ThreadProjection;
}

describe("buildBoundedThreadStreamSnapshot", () => {
  it("builds socket fallback snapshots with a bounded timeline and history cursor", () => {
    const projection = timelineProjection(80);
    // A delivered side chat digest stays "ready", which bounded snapshots keep.
    const sideChatHandoff = {
      id: ContextHandoffId.make("side-chat-handoff"),
      transferId: ContextTransferId.make("side-chat-transfer"),
      threadId: THREAD_ID,
      targetRunId: RunId.make("side-chat-run"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("side-chat-provider-thread"),
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "manual_context",
      status: "ready",
      summaryMessageId: null,
      summaryText: "x".repeat(8_000),
      delivery: { nativeThreadId: "native", status: "inline", itemIds: [] },
      createdByProviderInstanceId: null,
      createdAt: NOW,
      updatedAt: NOW,
    } satisfies OrchestrationV2ContextHandoff;
    const snapshot = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 44,
      projection: { ...projection, contextHandoffs: [sideChatHandoff] },
    });

    expect(snapshot.projection.contextHandoffs.map((handoff) => handoff.summaryText)).toEqual([""]);
    expect(snapshot.kind).toBe("snapshot");
    expect(snapshot.snapshotSequence).toBe(44);
    expect(snapshot.projection.visibleTurnItems).toHaveLength(75);
    expect(snapshot.projection.turnItems).toHaveLength(75);
    expect(snapshot.historyCursor).not.toBeNull();
    expect(snapshot.hasMoreHistory).toBe(true);
    expect(snapshot.latestLocalTurnOrdinal).toBe(80);
  });
});

describe("compact bounded snapshots", () => {
  const FORK_PARENT = ThreadId.make("thread-stream-parent");
  const decodeStreamItem = Schema.decodeUnknownSync(
    Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
  );
  const encodeStreamItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

  function forkProjection(): OrchestrationV2ThreadProjection {
    const base = timelineProjection(6);
    const local = base.visibleTurnItems.slice(3).map((row, index) => ({ ...row, position: index }));
    const inherited = base.visibleTurnItems.slice(0, 3).map((row, index) => {
      const item = { ...row.item, id: TurnItemId.make(`parent-${index}`), threadId: FORK_PARENT };
      return {
        position: index,
        visibility: "inherited" as const,
        sourceThreadId: FORK_PARENT,
        sourceItemId: item.id,
        item,
      };
    });
    const request = {
      ...base.turnItems[0]!,
      id: TurnItemId.make("interrupt-request"),
      type: "run_interrupt_request",
      ordinal: 0,
      message: "Stop",
    } as unknown as OrchestrationV2TurnItem;
    return {
      ...base,
      turnItems: [request, ...local.map((row) => row.item)],
      visibleTurnItems: [...inherited, ...local].map((row, position) => ({ ...row, position })),
    };
  }

  it.each([
    ["linear", () => timelineProjection(80)],
    ["fork with retained interrupt request", forkProjection],
  ])("restores the exact opted-out snapshot for %s threads", (_, makeProjection) => {
    const base = makeProjection();
    const projection = {
      ...base,
      thread: { ...base.thread, modelSelection: { instanceId: "codex", model: "gpt-5" } },
    } as OrchestrationV2ThreadProjection;
    const full = buildBoundedThreadStreamSnapshot({ snapshotSequence: 44, projection });
    const compact = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 44,
      projection,
      compactTurnItems: true,
    });

    expect("turnItemsOmitLocalVisible" in full).toBe(false);
    expect(compact.turnItemsOmitLocalVisible).toBe(true);
    expect(compact.projection.turnItems.length).toBeLessThan(full.projection.turnItems.length);
    const { turnItemsOmitLocalVisible: _marker, ...compactFields } = compact;
    expect({ ...compactFields, projection: full.projection }).toEqual(full);

    const decodedFull = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(full))));
    const decodedCompact = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(compact))));
    if (decodedFull.kind !== "snapshot" || decodedCompact.kind !== "snapshot") {
      throw new Error("Expected snapshots");
    }
    expect(boundedSnapshotProjection(decodedCompact)).toEqual(decodedFull.projection);
  });
});
