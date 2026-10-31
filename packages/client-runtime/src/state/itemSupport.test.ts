import {
  EnvironmentId,
  ThreadId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ProviderCapabilities,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";
import { canForkProjectedAssistantItem } from "./threadWorkflows.ts";
import { createV2ItemCapabilitiesAtom, resolveV2ItemSupport } from "./itemSupport.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const runId = RunId.make("run-1");
const nodeId = NodeId.make("node-1");
const itemId = TurnItemId.make("item-1");
const requestId = RuntimeRequestId.make("request-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread-1");
const providerTurnId = ProviderTurnId.make("provider-turn-1");

const commandItem: OrchestrationV2TurnItem = {
  id: itemId,
  threadId: v2ThreadId,
  runId,
  nodeId,
  providerThreadId,
  providerTurnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running",
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "command_execution",
  input: "vp check",
};

const providerThread = {
  id: providerThreadId,
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId,
  providerSessionId: null,
  appThreadId: v2ThreadId,
  ownerNodeId: nodeId,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "active" as const,
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};

describe("resolveV2ItemSupport", () => {
  it("retains identity while linking a turn item to its execution and provider entities", () => {
    const run = {
      id: runId,
      threadId: v2ThreadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      providerThreadId,
      userMessageId: "message-1" as never,
      rootNodeId: nodeId,
      activeAttemptId: RunAttemptId.make("attempt-2"),
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const attempts = [
      {
        id: RunAttemptId.make("attempt-1"),
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial" as const,
        status: "superseded" as const,
        startedAt: now,
        completedAt: now,
      },
      {
        id: RunAttemptId.make("attempt-2"),
        runId,
        attemptOrdinal: 2,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "steering_restart" as const,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      },
    ];
    const node = {
      id: nodeId,
      threadId: v2ThreadId,
      runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "tool_call" as const,
      status: "running" as const,
      countsForRun: true,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const providerTurn = {
      id: providerTurnId,
      providerThreadId,
      nodeId,
      runAttemptId: attempts[1]!.id,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
    };
    const runtimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId,
      nativeRequestRef: null,
      kind: "dynamic_tool_call" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: ProviderSessionId.make("session-1"),
      },
      createdAt: now,
      resolvedAt: null,
    };
    const projection = {
      ...v2Projection,
      runs: [run],
      attempts,
      nodes: [node],
      providerThreads: [providerThread],
      providerTurns: [providerTurn],
      runtimeRequests: [runtimeRequest],
      turnItems: [commandItem],
    };

    const support = resolveV2ItemSupport(projection, itemId);
    expect(support.item).toBe(commandItem);
    expect(support.run).toBe(run);
    expect(support.attempts).toEqual(attempts);
    expect(support.attempts[0]).toBe(attempts[0]);
    expect(support.node).toBe(node);
    expect(support.providerThread).toBe(providerThread);
    expect(support.providerTurn).toBe(providerTurn);
    expect(support.runtimeRequest).toBe(runtimeRequest);
  });

  it("resolves synthetic items from the authoritative visible sequence", () => {
    const projection = {
      ...v2Projection,
      visibleTurnItems: [
        {
          position: 0,
          visibility: "synthetic" as const,
          sourceThreadId: v2ThreadId,
          sourceItemId: itemId,
          item: commandItem,
        },
      ],
    };
    expect(resolveV2ItemSupport(projection, itemId).item).toBe(commandItem);
  });
});

const capabilities: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "client-boundary" },
};

const session = {
  id: ProviderSessionId.make("session-1"),
  driver: providerThread.driver,
  providerInstanceId,
  status: "ready" as const,
  cwd: "/workspace/project",
  model: "gpt-5.4",
  capabilities,
  createdAt: now,
  updatedAt: now,
  lastError: null,
};
const completedAssistant: OrchestrationV2TurnItem = {
  ...commandItem,
  type: "assistant_message",
  messageId: MessageId.make("assistant"),
  text: "Completed response",
  streaming: false,
  status: "completed",
  completedAt: now,
};
const forkProjection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  turnItems: [completedAssistant],
  providerThreads: [{ ...providerThread, providerSessionId: session.id }],
  providerSessions: [session],
};

const sourceRef = { environmentId: EnvironmentId.make("env"), threadId: v2ThreadId };

function setupCapabilities(initial: OrchestrationV2ThreadProjection | null) {
  const key = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);
  const states = Atom.family((stateKey: string) =>
    Atom.make(
      AsyncResult.success({
        ...EMPTY_ENVIRONMENT_THREAD_STATE,
        data: Option.fromNullishOr(stateKey === key(sourceRef) ? initial : null),
      }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms((environmentId, threadId) =>
    states(key({ environmentId, threadId })),
  );
  const registry = AtomRegistry.make();
  const select = (ref: ScopedThreadRef, targetItemId = itemId) => {
    const atom = createV2ItemCapabilitiesAtom(details, ref, targetItemId);
    registry.mount(atom);
    return () => registry.get(atom);
  };
  return {
    read: select(sourceRef),
    select,
    push: (projection: OrchestrationV2ThreadProjection | null, ref = sourceRef) =>
      registry.set(
        states(key(ref)),
        AsyncResult.success({
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          data: Option.fromNullishOr(projection),
        }),
      ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("item capabilities atom", () => {
  it.each(["assistant_message", "reasoning"] as const)(
    "does not rescan completed history or relationships when %s text streams",
    (type) => {
      let itemReads = 0;
      let relationshipReads = 0;
      const history = Array.from({ length: 100 }, (_, index) => ({
        ...completedAssistant,
        get id() {
          itemReads++;
          return index === 99 ? itemId : TurnItemId.make(`history-${index}`);
        },
      }));
      const streaming: OrchestrationV2TurnItem = {
        ...completedAssistant,
        id: TurnItemId.make("streaming"),
        type,
        text: "First",
        streaming: true,
        status: "running",
        completedAt: null,
      };
      const initial = {
        ...forkProjection,
        turnItems: [...history, streaming],
        visibleTurnItems: [...history, streaming].map((item, position) => ({
          position,
          visibility: "local" as const,
          sourceThreadId: v2ThreadId,
          sourceItemId: item.id,
          item,
        })),
        nodes: [
          {
            get id() {
              relationshipReads++;
              return nodeId;
            },
            threadId: v2ThreadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "tool_call" as const,
            status: "completed" as const,
            countsForRun: true,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: now,
          },
        ],
      };
      using harness = setupCapabilities(initial);
      expect(harness.read()).toBe(capabilities);
      itemReads = 0;
      relationshipReads = 0;
      for (let index = 0; index < 10; index++) {
        const nextItem = { ...streaming, text: `Chunk ${index}` };
        harness.push({
          ...initial,
          turnItems: [...history, nextItem],
          visibleTurnItems: [
            ...initial.visibleTurnItems.slice(0, -1),
            { ...initial.visibleTurnItems.at(-1)!, item: nextItem },
          ],
        });
        expect(harness.read()).toBe(capabilities);
      }
      expect({ itemReads, relationshipReads }).toEqual({ itemReads: 0, relationshipReads: 0 });
    },
  );
});

it("follows session capabilities, provider reassignment, missing evidence, and source resets", () => {
  const incapable = {
    ...capabilities,
    threads: { ...capabilities.threads, canForkThread: false },
  };
  const portable = {
    ...incapable,
    context: { ...incapable.context, supportsFullThreadHandoff: true },
  };
  const otherSession = {
    ...session,
    id: ProviderSessionId.make("other-session"),
    capabilities: incapable,
  };
  const otherProvider = {
    ...forkProjection.providerThreads[0]!,
    id: ProviderThreadId.make("other-provider"),
    providerSessionId: otherSession.id,
  };
  const projectedItem = {
    position: 0,
    visibility: "inherited" as const,
    sourceThreadId: v2ThreadId,
    sourceItemId: itemId,
    item: {
      ...completedAssistant,
      id: TurnItemId.make("projected-copy"),
      providerThreadId: otherProvider.id,
    },
  };
  using harness = setupCapabilities(null);
  // Older payloads can omit this field even though the current contract requires it.
  const legacyItem = { ...completedAssistant };
  Reflect.deleteProperty(legacyItem, "providerThreadId");
  const snapshots: ReadonlyArray<readonly [OrchestrationV2ThreadProjection | null, boolean]> = [
    [null, true],
    [forkProjection, true],
    [{ ...forkProjection, providerSessions: [{ ...session, capabilities: incapable }] }, false],
    [
      {
        ...forkProjection,
        providerSessions: [
          {
            ...session,
            capabilities: {
              ...capabilities,
              threads: { ...capabilities.threads, canForkFromTurn: false },
            },
          },
        ],
      },
      false,
    ],
    [
      {
        ...forkProjection,
        providerSessions: [
          {
            ...session,
            capabilities: {
              ...capabilities,
              identity: { ...capabilities.identity, nativeThreadIds: "weak" },
            },
          },
        ],
      },
      false,
    ],
    [{ ...forkProjection, providerSessions: [{ ...session, capabilities: portable }] }, true],
    [
      {
        ...forkProjection,
        providerThreads: [
          { ...forkProjection.providerThreads[0]!, providerSessionId: otherSession.id },
        ],
        providerSessions: [session, otherSession],
      },
      false,
    ],
    [
      {
        ...forkProjection,
        turnItems: [{ ...completedAssistant, providerThreadId: otherProvider.id }],
        providerThreads: [...forkProjection.providerThreads, otherProvider],
        providerSessions: [session, otherSession],
      },
      false,
    ],
    [{ ...forkProjection, turnItems: [{ ...completedAssistant, providerThreadId: null }] }, true],
    [{ ...forkProjection, turnItems: [legacyItem] }, true],
    [{ ...forkProjection, providerThreads: [] }, true],
    [
      { ...forkProjection, providerThreads: [{ ...providerThread, providerSessionId: null }] },
      true,
    ],
    [{ ...forkProjection, providerSessions: [] }, true],
    [{ ...forkProjection, turnItems: [] }, true],
    [null, true],
    [{ ...forkProjection, providerSessions: [{ ...session, capabilities: incapable }] }, false],
  ];
  for (const [projection, expectedCanFork] of snapshots) {
    harness.push(projection);
    const expected =
      projection === null
        ? undefined
        : resolveV2ItemSupport(projection, itemId).providerSession?.capabilities;
    expect(harness.read()).toBe(expected);
    expect(canForkProjectedAssistantItem({ projectedItem, capabilities: harness.read() })).toBe(
      expectedCanFork,
    );
  }
  expect(
    canForkProjectedAssistantItem({
      projectedItem: { ...projectedItem, item: { ...completedAssistant, status: "running" } },
      capabilities,
    }),
  ).toBe(false);
  expect(
    canForkProjectedAssistantItem({
      projectedItem: { ...projectedItem, item: { ...completedAssistant, runId: null } },
      capabilities,
    }),
  ).toBe(false);
});

it("keeps source item lookup precedence for inherited and synthetic projected identities", () => {
  using harness = setupCapabilities(forkProjection);
  const incapable = {
    ...capabilities,
    threads: { ...capabilities.threads, canForkFromTurn: false },
  };
  const otherSession = {
    ...session,
    id: ProviderSessionId.make("projected-session"),
    capabilities: incapable,
  };
  const otherProvider = {
    ...providerThread,
    id: ProviderThreadId.make("projected-provider"),
    providerSessionId: otherSession.id,
  };
  const row = {
    position: 0,
    visibility: "synthetic" as const,
    sourceThreadId: v2ThreadId,
    sourceItemId: itemId,
    item: {
      ...completedAssistant,
      id: TurnItemId.make("synthetic-copy"),
      providerThreadId: otherProvider.id,
    },
  };
  const projection = {
    ...forkProjection,
    visibleTurnItems: [row],
    providerThreads: [...forkProjection.providerThreads, otherProvider],
    providerSessions: [session, otherSession],
  };
  harness.push(projection);
  expect(harness.read()).toBe(capabilities);
  const synthetic = { ...projection, turnItems: [] };
  harness.push(synthetic);
  expect(harness.read()).toBe(incapable);
  expect(harness.read()).toBe(
    resolveV2ItemSupport(synthetic, itemId).providerSession?.capabilities,
  );
  expect(harness.select(sourceRef, row.item.id)()).toBeUndefined();
  harness.push({ ...synthetic, visibleTurnItems: [] });
  expect(harness.read()).toBeUndefined();
});

it("scopes inherited source capabilities to their environment and thread", () => {
  using harness = setupCapabilities(forkProjection);
  const otherRef = { ...sourceRef, threadId: ThreadId.make("viewing-thread") };
  const otherEnvironmentRef = { ...sourceRef, environmentId: EnvironmentId.make("other-env") };
  const otherThreadRead = harness.select(otherRef);
  const otherEnvironmentRead = harness.select(otherEnvironmentRef);
  expect(otherThreadRead()).toBeUndefined();
  expect(otherEnvironmentRead()).toBeUndefined();
  const incapable = { ...capabilities, threads: { ...capabilities.threads, canForkThread: false } };
  const other = { ...forkProjection, providerSessions: [{ ...session, capabilities: incapable }] };
  harness.push(other, otherRef);
  harness.push(other, otherEnvironmentRef);
  expect(otherThreadRead()).toBe(incapable);
  expect(otherEnvironmentRead()).toBe(incapable);
  expect(harness.read()).toBe(capabilities);
  harness.push(null);
  expect(harness.read()).toBeUndefined();
  expect(otherThreadRead()).toBe(incapable);
});
