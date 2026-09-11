import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
  RunId,
  MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection, v2Now } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "./threadHistoryMerge.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import type { EnvironmentThreadState } from "./threads.ts";

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-detail"),
  threadId: ThreadId.make(v2Projection.thread.id),
};

function threadState(
  partial: Pick<EnvironmentThreadState, "data" | "status" | "error"> &
    Partial<Pick<EnvironmentThreadState, "history">>,
): EnvironmentThreadState {
  return { ...partial, history: partial.history ?? EMPTY_THREAD_HISTORY_META };
}

describe("createEnvironmentThreadDetailAtoms", () => {
  it("adds environment scope while preserving the pristine projection", () => {
    const initial: AsyncResult.AsyncResult<EnvironmentThreadState, never> = AsyncResult.success(
      threadState({
        data: Option.some(v2Projection),
        status: "cached",
        error: Option.none(),
      }),
    );
    const sourceAtom = Atom.make(initial);
    const details = createEnvironmentThreadDetailAtoms(() => sourceAtom);
    const registry = AtomRegistry.make();

    const thread = registry.get(details.threadAtom(ref));
    expect(thread).toEqual({ environmentId: ref.environmentId, projection: v2Projection });
    expect(thread?.projection).toBe(v2Projection);
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
    expect(registry.get(details.statusAtom(ref))).toBe("cached");
    expect(registry.get(details.historyAtom(ref))).toBe(EMPTY_THREAD_HISTORY_META);

    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.some(v2Projection),
          status: "synchronizing",
          error: Option.none(),
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBe(thread);
    expect(registry.get(details.statusAtom(ref))).toBe("synchronizing");

    const progressiveHistory = {
      ...EMPTY_THREAD_HISTORY_META,
      historyCursor: "cursor-1",
      hasMoreHistory: true,
    };
    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.some(v2Projection),
          status: "live",
          error: Option.some("Stream interrupted."),
          history: progressiveHistory,
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBe(thread);
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
    expect(registry.get(details.statusAtom(ref))).toBe("live");
    expect(registry.get(details.errorAtom(ref))).toBe("Stream interrupted.");
    expect(registry.get(details.historyAtom(ref))).toBe(progressiveHistory);

    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.none(),
          status: "deleted",
          error: Option.none(),
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBeNull();
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toEqual([]);
    expect(registry.get(details.statusAtom(ref))).toBe("deleted");
    expect(registry.get(details.errorAtom(ref))).toBeNull();
    expect(registry.get(details.historyAtom(ref))).toBe(EMPTY_THREAD_HISTORY_META);
    registry.dispose();
  });
});

it("does not notify queue consumers for streaming text or execution nodes", () => {
  const projection = {
    ...v2Projection,
    runs: [
      {
        id: RunId.make("queued-run"),
        threadId: v2Projection.thread.id,
        ordinal: 1,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("queued-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued" as const,
        requestedAt: v2Now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
  };
  const source = Atom.make(
    AsyncResult.success(
      threadState({ data: Option.some(projection), status: "live", error: Option.none() }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.queueWorkflowAtom(ref));
  const before = registry.get(details.queueWorkflowAtom(ref));
  const disposeCount = registry.mount(details.queuedCountAtom(ref));
  expect(registry.get(details.queuedCountAtom(ref))).toBe(1);
  registry.set(
    source,
    AsyncResult.success(
      threadState({
        data: Option.some({
          ...projection,
          nodes: [...v2Projection.nodes],
          turnItems: [...v2Projection.turnItems],
        }),
        status: "live",
        error: Option.none(),
      }),
    ),
  );
  expect(registry.get(details.queueWorkflowAtom(ref))).toBe(before);
  expect(registry.get(details.queuedCountAtom(ref))).toBe(1);
  registry.set(
    source,
    AsyncResult.success(
      threadState({ data: Option.none(), status: "deleted", error: Option.none() }),
    ),
  );
  expect(registry.get(details.queueWorkflowAtom(ref))).toBeNull();
  expect(registry.get(details.queuedCountAtom(ref))).toBe(0);
  disposeCount();
  dispose();
  registry.dispose();
});

it("keeps worktree and pending requests stable during output updates, then reflects resolution", () => {
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, worktreePath: "/workspace/task" },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("approval"),
        nodeId: NodeId.make("approval-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Provider exited" },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
  };
  const source = Atom.make(
    AsyncResult.success(
      threadState({ data: Option.some(projection), status: "live", error: Option.none() }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.pendingRequestsAtom(ref));
  const before = registry.get(details.pendingRequestsAtom(ref));
  expect(before?.approvals).toHaveLength(1);
  const streaming: OrchestrationV2ThreadProjection = {
    ...projection,
    turnItems: [
      {
        id: TurnItemId.make("output"),
        threadId: projection.thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        type: "command_execution",
        input: "pwd",
        output: "new output",
        exitCode: undefined,
      },
    ],
  };
  registry.set(
    source,
    AsyncResult.success(
      threadState({ data: Option.some(streaming), status: "live", error: Option.none() }),
    ),
  );
  expect(registry.get(details.pendingRequestsAtom(ref))).toBe(before);
  expect(registry.get(details.worktreePathAtom(ref))).toBe("/workspace/task");
  registry.set(
    source,
    AsyncResult.success(
      threadState({
        data: Option.some({
          ...streaming,
          thread: { ...projection.thread, worktreePath: "/workspace/moved" },
          runtimeRequests: projection.runtimeRequests.map((request) => ({
            ...request,
            status: "resolved",
            resolvedAt: v2Now,
          })),
        }),
        status: "live",
        error: Option.none(),
      }),
    ),
  );
  expect(registry.get(details.pendingRequestsAtom(ref))?.approvals).toEqual([]);
  expect(registry.get(details.worktreePathAtom(ref))).toBe("/workspace/moved");
  dispose();
  registry.dispose();
});
