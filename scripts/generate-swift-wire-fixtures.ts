import * as Crypto from "effect/Crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { mergeOlderHistoryIntoProjection } from "@t3tools/client-runtime/state/thread-history-merge";
import {
  OrchestrationV2Command,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadStreamItem,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const check = process.argv.includes("--check");
const timestamp = "2026-08-07T12:00:00.000Z";
const later = "2026-08-07T12:01:00.000Z";
const fixtures = new Map<string, string>();
const serializeFixture = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Round-trip the same JSON codec as RPC/HTTP so DateTimeUtc is encoded on the wire. */
function addFixture<A, I>(name: string, schema: Schema.Codec<A, I>, input: unknown): A {
  const codec = Schema.toCodecJson(schema);
  const decoded = Schema.decodeUnknownSync(codec)(input, { onExcessProperty: "error" });
  fixtures.set(`${name}.json`, serializeFixture(Schema.encodeSync(codec)(decoded)));
  return decoded;
}

addFixture("hub-reset-credit-input", ProviderConsumeResetCreditInput, {
  sourceId: "hub-fixture",
  accountId: "account-fixture",
  creditId: "credit-fixture",
});
addFixture("hub-reset-credit-result", ProviderConsumeResetCreditResult, {
  outcome: "reset",
  warning: "Could not clear the hub cooldown.",
});
addFixture("hub-reset-credits", ServerProviderResetCredits, {
  availableCount: 1,
  nextCreditId: "credit-fixture",
  nextExpiresAt: timestamp,
});

// Match orchestrationV2TestFixtures.ts's minimal projection, then populate linked
// control state and timeline rows. V1 samples are frozen separately below.
const modelSelection = { instanceId: "codex", model: "gpt-5.4" };
const project = {
  id: "project-v2",
  title: "Native wire fixtures",
  workspaceRoot: "/workspace/fixture",
  repositoryIdentity: null,
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const thread = {
  id: "thread-v2",
  projectId: project.id,
  title: "Verify native V2 support",
  providerInstanceId: "codex",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  activeProviderThreadId: "provider-thread-v2",
  lineage: { rootThreadId: "thread-v2", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "mobile",
  activeOrderKey: "nm",
  autoSettleDisabledAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const image = {
  type: "image",
  id: "attachment-v2-image",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 128,
};
const file = {
  type: "file",
  id: "attachment-v2-file",
  name: "requirements.txt",
  mimeType: "text/plain",
  sizeBytes: 256,
  source: { _tag: "pasted-text" },
};
const attachments = [image, file];
const activeRun = {
  id: "run-v2-active",
  threadId: thread.id,
  ordinal: 2,
  providerInstanceId: "codex",
  modelSelection,
  providerThreadId: thread.activeProviderThreadId,
  userMessageId: "message-v2-user",
  rootNodeId: "node-v2-root",
  activeAttemptId: "attempt-v2",
  status: "waiting",
  requestedAt: timestamp,
  startedAt: timestamp,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const queuedRun = {
  ...activeRun,
  id: "run-v2-queued",
  ordinal: 3,
  userMessageId: "message-v2-queued",
  rootNodeId: null,
  activeAttemptId: null,
  status: "queued",
  queuePosition: 1,
  queueHeld: true,
  startedAt: null,
};
const historicalRun = {
  ...activeRun,
  id: "run-v2-history",
  ordinal: 1,
  userMessageId: "message-v2-history-user",
  rootNodeId: "node-v2-history",
  activeAttemptId: null,
  status: "completed",
  checkpointId: "checkpoint-v2",
  completedAt: timestamp,
};
const rootNode = {
  id: activeRun.rootNodeId,
  threadId: thread.id,
  runId: activeRun.id,
  parentNodeId: null,
  rootNodeId: activeRun.rootNodeId,
  kind: "root_turn",
  status: "waiting",
  countsForRun: true,
  providerThreadId: thread.activeProviderThreadId,
  providerTurnId: "provider-turn-v2",
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: "scope-v2-active",
  startedAt: timestamp,
  completedAt: null,
};
const approvalRequest = {
  id: "request-v2-approval",
  nodeId: "node-v2-approval",
  providerTurnId: rootNode.providerTurnId,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "live", providerSessionId: "provider-session-v2" },
  createdAt: timestamp,
  resolvedAt: null,
};
const inputRequest = {
  ...approvalRequest,
  id: "request-v2-input",
  nodeId: "node-v2-input",
  kind: "user_input",
};
const userMessage = {
  id: activeRun.userMessageId,
  threadId: thread.id,
  runId: activeRun.id,
  nodeId: null,
  role: "user",
  text: "Verify the native wire contract with these attachments.",
  attachments,
  streaming: false,
  createdBy: "user",
  creationSource: "mobile",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const assistantMessage = {
  ...userMessage,
  id: "message-v2-assistant",
  nodeId: activeRun.rootNodeId,
  role: "assistant",
  text: "I checked the contracts.",
  attachments: [],
  streaming: true,
  createdBy: "agent",
  creationSource: "provider",
};
const queuedMessage = {
  ...userMessage,
  id: queuedRun.userMessageId,
  runId: queuedRun.id,
  text: "Also verify the history page.",
  attachments: [file],
};
const itemBase = {
  threadId: thread.id,
  runId: activeRun.id,
  nodeId: activeRun.rootNodeId,
  providerThreadId: thread.activeProviderThreadId,
  providerTurnId: rootNode.providerTurnId,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed",
  title: null,
  startedAt: timestamp,
  completedAt: timestamp,
  updatedAt: timestamp,
};
const userItem = {
  ...itemBase,
  id: "item-v2-user",
  ordinal: 10,
  nodeId: null,
  type: "user_message",
  messageId: userMessage.id,
  inputIntent: "turn_start",
  createdBy: "user",
  creationSource: "mobile",
  text: userMessage.text,
  attachments,
};
const reasoningItem = {
  ...itemBase,
  id: "item-v2-reasoning",
  ordinal: 11,
  type: "reasoning",
  text: "Check the snapshot, then apply incremental events.",
  streaming: false,
};
const toolItem = {
  ...itemBase,
  id: "item-v2-tool",
  ordinal: 12,
  type: "command_execution",
  title: "Read contracts",
  input: "cat packages/contracts/src/orchestrationV2.ts",
  output: "export const OrchestrationV2ThreadProjection = Schema.Struct({...});",
  exitCode: 0,
};
const assistantItem = {
  ...itemBase,
  id: "item-v2-assistant",
  ordinal: 13,
  type: "assistant_message",
  messageId: assistantMessage.id,
  text: assistantMessage.text,
  streaming: true,
  status: "running",
  completedAt: null,
};
const approvalItem = {
  ...itemBase,
  id: "item-v2-approval",
  nodeId: approvalRequest.nodeId,
  ordinal: 14,
  type: "approval_request",
  requestId: approvalRequest.id,
  requestKind: "command",
  prompt: "Run the focused wire fixture checks?",
  options: [
    { decision: "accept", label: "Allow once" },
    { decision: "decline", label: "Decline" },
  ],
  status: "waiting",
  completedAt: null,
};
const inputItem = {
  ...itemBase,
  id: "item-v2-input",
  nodeId: inputRequest.nodeId,
  ordinal: 15,
  type: "user_input_request",
  requestId: inputRequest.id,
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which clients should be checked?",
      options: [
        { label: "SwiftUI mobile", description: "Check the native iOS client.", value: "swift" },
      ],
      allowCustomAnswer: true,
      multiSelect: false,
      required: true,
    },
  ],
  status: "waiting",
  completedAt: null,
};
const plan = {
  id: "plan-v2",
  threadId: thread.id,
  runId: activeRun.id,
  nodeId: "node-v2-plan",
  kind: "todo_list",
  status: "active",
  steps: [
    { id: "read", text: "Read contracts", status: "completed", durationMs: 250 },
    { id: "verify", text: "Verify Swift fixtures", status: "running", durationAnchorAt: timestamp },
  ],
};
const planItem = {
  ...itemBase,
  id: "item-v2-plan",
  ordinal: 16,
  nodeId: plan.nodeId,
  type: "todo_list",
  planId: plan.id,
  steps: plan.steps,
  status: "running",
  completedAt: null,
};
const queuedItem = {
  ...userItem,
  id: "item-v2-queued",
  ordinal: 17,
  runId: queuedRun.id,
  messageId: queuedMessage.id,
  inputIntent: "queued_turn",
  text: queuedMessage.text,
  attachments: queuedMessage.attachments,
  status: "pending",
  startedAt: null,
  completedAt: null,
};
const turnItems = [
  userItem,
  reasoningItem,
  toolItem,
  assistantItem,
  approvalItem,
  inputItem,
  planItem,
  queuedItem,
];
const visibleTurnItems = turnItems.map((item, position) => ({
  position,
  visibility: "local",
  sourceThreadId: thread.id,
  sourceItemId: item.id,
  item,
}));
const checkpointScope = {
  id: "scope-v2",
  threadId: thread.id,
  runId: historicalRun.id,
  nodeId: historicalRun.rootNodeId,
  parentScopeId: null,
  providerThreadId: thread.activeProviderThreadId,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd: project.workspaceRoot,
  createdAt: timestamp,
};
const providerSession = {
  id: "provider-session-v2",
  driver: "codex",
  providerInstanceId: "codex",
  status: "waiting",
  cwd: project.workspaceRoot,
  model: modelSelection.model,
  // An explicit capability snapshot also catches native decoders that mistake
  // provider sessions for V1 thread sessions.
  capabilities: {
    sessions: {
      supportsMultipleProviderThreadsPerSession: true,
      supportsModelSwitchInSession: true,
      supportsProviderSwitchingViaHandoff: true,
      supportsRuntimeModeSwitchInSession: true,
      pendingRequestsSurviveRestart: false,
    },
    threads: {
      canCreateEmptyThread: true,
      canReadThreadSnapshot: true,
      canRollbackThread: true,
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
      supportsActiveSteering: true,
      supportsSteeringByInterruptRestart: true,
      supportsQueuedMessages: true,
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
      supportsDynamicToolCallbacks: true,
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
      supportsSubagents: true,
      exposesSubagentThreadIds: true,
      emitsSubagentLifecycle: true,
      canWaitForSubagents: true,
      canCloseSubagents: true,
      canForkSubagentThread: false,
    },
    context: {
      acceptsSystemContext: true,
      acceptsDeveloperContext: true,
      acceptsSyntheticUserContext: true,
      canGenerateSummaries: true,
      canConsumeHandoffSummaries: true,
      supportsDeltaHandoff: true,
      supportsFullThreadHandoff: true,
      maxRecommendedHandoffChars: null,
    },
    checkpointing: {
      appCanCheckpointFilesystem: true,
      supportsNestedCheckpointScopes: true,
      providerCanRollbackConversation: true,
      providerRollbackReturnsSnapshot: true,
      providerCanReadConversationSnapshot: true,
    },
    identity: {
      nativeThreadIds: "strong",
      nativeTurnIds: "strong",
      nativeItemIds: "strong",
      nativeRequestIds: "strong",
    },
    runtimePolicy: { enforcement: "native" },
  },
  createdAt: timestamp,
  updatedAt: timestamp,
  lastError: null,
};
const projection = {
  thread,
  runs: [historicalRun, activeRun, queuedRun],
  attempts: [
    {
      id: activeRun.activeAttemptId,
      runId: activeRun.id,
      attemptOrdinal: 1,
      rootNodeId: activeRun.rootNodeId,
      providerInstanceId: "codex",
      providerThreadId: thread.activeProviderThreadId,
      providerTurnId: rootNode.providerTurnId,
      reason: "initial",
      status: "running",
      startedAt: timestamp,
      completedAt: null,
    },
  ],
  nodes: [
    rootNode,
    {
      ...rootNode,
      id: historicalRun.rootNodeId,
      runId: historicalRun.id,
      rootNodeId: historicalRun.rootNodeId,
      checkpointScopeId: checkpointScope.id,
      providerTurnId: null,
      status: "completed",
      completedAt: timestamp,
    },
    ...[approvalRequest, inputRequest].map((request) => ({
      ...rootNode,
      id: request.nodeId,
      parentNodeId: rootNode.id,
      kind: request.kind === "command" ? "approval_request" : "user_input_request",
      runtimeRequestId: request.id,
    })),
    {
      ...rootNode,
      id: plan.nodeId,
      parentNodeId: rootNode.id,
      kind: "todo_list",
      status: "running",
    },
  ],
  subagents: [],
  providerSessions: [providerSession],
  providerThreads: [
    {
      id: thread.activeProviderThreadId,
      driver: "codex",
      providerInstanceId: "codex",
      providerSessionId: providerSession.id,
      appThreadId: thread.id,
      ownerNodeId: null,
      nativeThreadRef: { driver: "codex", nativeId: "native-thread-v2", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  providerTurns: [
    {
      id: rootNode.providerTurnId,
      providerThreadId: thread.activeProviderThreadId,
      nodeId: rootNode.id,
      runAttemptId: activeRun.activeAttemptId,
      nativeTurnRef: { driver: "codex", nativeId: "native-turn-v2", strength: "strong" },
      ordinal: 2,
      status: "running",
      startedAt: timestamp,
      completedAt: null,
      tokenUsage: {
        usedTokens: 1280,
        maxTokens: 128000,
        inputTokens: 1200,
        outputTokens: 80,
        updatedAt: timestamp,
      },
    },
  ],
  runtimeRequests: [approvalRequest, inputRequest],
  messages: [userMessage, assistantMessage, queuedMessage],
  plans: [plan],
  turnItems,
  checkpointScopes: [
    checkpointScope,
    { ...checkpointScope, id: "scope-v2-active", runId: activeRun.id, nodeId: rootNode.id },
  ],
  checkpoints: [
    {
      id: "checkpoint-v2",
      threadId: thread.id,
      scopeId: checkpointScope.id,
      runId: historicalRun.id,
      nodeId: historicalRun.rootNodeId,
      parentCheckpointId: null,
      ordinalWithinScope: 0,
      appRunOrdinal: 1,
      ref: "refs/t3/checkpoints/fixture-v2",
      status: "ready",
      files: [{ path: "Sources/Core/Wire.swift", kind: "modified", additions: 8, deletions: 2 }],
      capturedAt: timestamp,
    },
  ],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems,
  updatedAt: timestamp,
};
const shellThread = {
  ...thread,
  latestRunId: queuedRun.id,
  latestRunRequestedAt: queuedRun.requestedAt,
  latestRunStartedAt: null,
  latestRunCompletedAt: null,
  activeRunId: activeRun.id,
  activityRunStartedAt: activeRun.startedAt,
  activityRunStatus: "waiting",
  status: "waiting",
  pendingRuntimeRequest: {
    id: approvalRequest.id,
    kind: approvalRequest.kind,
    createdAt: timestamp,
  },
  latestVisibleMessage: {
    id: queuedMessage.id,
    role: "user",
    text: queuedMessage.text,
    updatedAt: timestamp,
  },
  latestUserMessageAt: timestamp,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: ["codex"],
  itemCount: turnItems.length + 2,
  visibleItemCount: visibleTurnItems.length + 2,
};
const shellInput = {
  schemaVersion: 1,
  snapshotSequence: 100,
  projects: [project],
  threads: [shellThread],
  archivedThreads: [],
};
addFixture("v2-shell-snapshot", OrchestrationV2ShellSnapshot, shellInput);
addFixture("v2-shell-stream-snapshot", OrchestrationV2ShellStreamItem, {
  kind: "snapshot",
  snapshot: shellInput,
});
addFixture("v2-shell-stream-updates", Schema.Array(OrchestrationV2ShellStreamItem), [
  { kind: "synchronized" },
  {
    kind: "project.updated",
    sequence: 101,
    project: { ...project, title: "Updated fixture project", updatedAt: later },
  },
  {
    kind: "thread.updated",
    sequence: 102,
    location: "active",
    thread: { ...shellThread, title: "Updated fixture thread", updatedAt: later },
  },
  { kind: "thread.removed", sequence: 103, location: "active", threadId: thread.id },
  {
    kind: "thread.updated",
    sequence: 104,
    location: "archive",
    thread: { ...shellThread, archivedAt: later, updatedAt: later },
  },
]);
const boundedInput = {
  snapshotSequence: 100,
  projection,
  historyCursor: "fixture-v2-before-10",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 17,
};
const bounded = addFixture(
  "v2-thread-bounded-snapshot",
  OrchestrationV2ThreadBoundedSnapshot,
  boundedInput,
);
addFixture("v2-thread-stream-snapshot", OrchestrationV2ThreadStreamItem, {
  kind: "snapshot",
  ...boundedInput,
});

const historicalUserItem = {
  ...userItem,
  id: "item-v2-history-user",
  ordinal: 0,
  runId: historicalRun.id,
  providerTurnId: null,
  messageId: historicalRun.userMessageId,
  text: "Check the initial contract.",
  attachments: [],
};
const historicalAssistantItem = {
  ...assistantItem,
  id: "item-v2-history-assistant",
  ordinal: 1,
  runId: historicalRun.id,
  nodeId: historicalRun.rootNodeId,
  providerTurnId: null,
  messageId: "message-v2-history-assistant",
  text: "The initial contract is valid.",
  streaming: false,
  status: "completed",
  completedAt: timestamp,
};
// A stale overlapping assistant row proves that loading history cannot replace
// fresher streamed text. The real merger deduplicates by source thread/item ID.
const history = addFixture("v2-thread-older-history", OrchestrationV2ThreadHistoryPage, {
  snapshotSequence: 100,
  items: [
    historicalUserItem,
    historicalAssistantItem,
    userItem,
    reasoningItem,
    toolItem,
    assistantItem,
  ].map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: thread.id,
    sourceItemId: item.id,
    item,
  })),
  nextCursor: null,
  hasMoreHistory: false,
});
const finalText = "The native wire contract and attachments are valid.";
const resolvedApproval = {
  ...approvalRequest,
  status: "resolved",
  resolvedAt: later,
  decision: "accept",
};
const eventInputs = [
  {
    type: "message.updated",
    payload: { ...assistantMessage, text: finalText, streaming: false, updatedAt: later },
  },
  {
    type: "turn-item.updated",
    payload: {
      ...assistantItem,
      text: finalText,
      streaming: false,
      status: "completed",
      completedAt: later,
      updatedAt: later,
    },
  },
  { type: "runtime-request.updated", payload: resolvedApproval },
  {
    type: "turn-item.updated",
    payload: { ...approvalItem, status: "completed", completedAt: later, updatedAt: later },
  },
  {
    type: "run.updated",
    payload: { ...queuedRun, status: "cancelled", queuePosition: null, completedAt: later },
  },
  {
    type: "provider-session.updated",
    payload: {
      ...providerSession,
      lastError: "Provider connection closed.",
      status: "error",
      updatedAt: later,
    },
  },
  {
    type: "provider-session.detached",
    payload: {
      providerSessionId: providerSession.id,
      detachedAt: later,
      reason: "Connection closed",
    },
  },
  // Updating an unloaded historical row must not add it to a bounded window.
  { type: "turn-item.updated", payload: { ...historicalAssistantItem, updatedAt: later } },
  {
    type: "turn-item.updated",
    payload: {
      ...itemBase,
      id: "item-v2-notice",
      ordinal: 18,
      type: "system_notice",
      message: "Provider disconnected. Reconnect to continue.",
      updatedAt: later,
    },
  },
];
const stream = addFixture(
  "v2-thread-stream-events",
  Schema.Array(OrchestrationV2ThreadStreamItem),
  [
    ...eventInputs.map((event, index) => ({
      kind: "event",
      sequence: 101 + index,
      event: { id: `event-v2-${index + 1}`, threadId: thread.id, occurredAt: later, ...event },
    })),
    { kind: "synchronized" },
  ],
);
let afterEvents = bounded.projection;
for (const item of stream) {
  if (item.kind !== "event") continue;
  const next = applyOrchestrationV2ProjectionEvent(afterEvents, item.event, {
    partialTimeline: true,
    latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
  });
  if (next === null) throw new Error(`Fixture event ${item.event.id} lost the thread projection.`);
  afterEvents = next;
}
const encodeBounded = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot));
fixtures.set(
  "v2-thread-after-events-snapshot.json",
  serializeFixture(
    encodeBounded({
      ...bounded,
      snapshotSequence: 109,
      projection: afterEvents,
      latestLocalTurnOrdinal: 18,
    }),
  ),
);
fixtures.set(
  "v2-thread-with-history-snapshot.json",
  serializeFixture(
    encodeBounded({
      ...bounded,
      snapshotSequence: 109,
      latestLocalTurnOrdinal: 18,
      projection: mergeOlderHistoryIntoProjection(afterEvents, history.items),
      historyCursor: history.nextCursor,
      hasMoreHistory: history.hasMoreHistory,
    }),
  ),
);

const send = {
  type: "message.dispatch",
  commandId: "command-v2-send",
  threadId: thread.id,
  messageId: "message-v2-send",
  text: userMessage.text,
  attachments,
  createdBy: "user",
  creationSource: "mobile",
  modelSelection,
  dispatchMode: { type: "start_immediately" },
  deliveryIntent: "auto",
};
addFixture("v2-send-command", OrchestrationV2Command, send);
addFixture("v2-steer-command", OrchestrationV2Command, {
  ...send,
  commandId: "command-v2-steer",
  messageId: "message-v2-steer",
  deliveryIntent: "steer",
  dispatchMode: { type: "steer_active", targetRunId: activeRun.id },
});
addFixture("v2-queue-send-command", OrchestrationV2Command, {
  ...send,
  commandId: "command-v2-queue-send",
  messageId: queuedMessage.id,
  dispatchMode: { type: "queue_after_active" },
  text: queuedMessage.text,
});
addFixture("v2-launch-input", OrchestrationV2ThreadLaunchInput, {
  commandId: "command-v2-launch",
  threadId: "thread-v2-new",
  projectId: project.id,
  creationSource: "mobile",
  title: "New native thread",
  generateTitle: true,
  modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  workspaceStrategy: {
    type: "worktree",
    baseRef: "main",
    branch: "native-fixture",
    startFromOrigin: true,
  },
  initialMessage: { messageId: "message-v2-launch", text: userMessage.text, attachments },
});
const commandBase = { threadId: thread.id };
const commands = [
  [
    "approval",
    { type: "runtime-request.respond", requestId: approvalRequest.id, decision: "accept" },
  ],
  [
    "question-attachment",
    {
      type: "runtime-request.respond",
      requestId: inputRequest.id,
      answers: { scope: "SwiftUI mobile" },
      attachmentsByQuestionId: { scope: attachments },
    },
  ],
  ["question-dismiss", { type: "thread.user-input.dismiss", requestId: inputRequest.id }],
  ["interrupt", { type: "run.interrupt", runId: activeRun.id, holdQueue: true }],
  ["queue-resume", { type: "queue.resume" }],
  ["queue-reorder", { type: "queued-run.reorder", runId: queuedRun.id, beforeRunId: null }],
  ["queue-cancel", { type: "queued-run.cancel", runId: queuedRun.id }],
  [
    "queue-edit",
    {
      type: "queued-run.edit",
      runId: queuedRun.id,
      text: "Verify both history pages.",
      attachments,
    },
  ],
  [
    "queue-promote",
    {
      type: "queued-message.promote-to-steer",
      queuedRunId: queuedRun.id,
      targetRunId: activeRun.id,
    },
  ],
  [
    "rollback",
    {
      type: "checkpoint.rollback",
      scopeId: checkpointScope.id,
      checkpointId: "checkpoint-v2",
      restoreFiles: true,
    },
  ],
] as const;
for (const [name, command] of commands) {
  addFixture(`v2-${name}-command`, OrchestrationV2Command, {
    ...commandBase,
    commandId: `command-v2-${name}`,
    ...command,
  });
}

const FrozenV1Manifest = Schema.Struct({
  baseline: Schema.String,
  sha256: Schema.Record(Schema.String, Schema.String),
});
const decodeFrozenV1Manifest = Schema.decodeUnknownEffect(Schema.fromJsonString(FrozenV1Manifest));
class StaleWireFixturesError extends Schema.TaggedError<StaleWireFixturesError>()(
  "StaleWireFixturesError",
  { staleFixtures: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return "Regenerate current fixtures with `node scripts/generate-swift-wire-fixtures.ts`. Restore frozen V1 samples from the manifest baseline; do not regenerate them with V2 contracts.";
  }
}
const generateSwiftWireFixtures = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputDirectory = path.resolve(
    import.meta.dirname,
    "../apps/swift-ios/Tests/Fixtures/Wire",
  );

  // The V1 contracts were removed from main. Keep the exact shipped wire bytes
  // as compatibility samples instead of copying the old orchestration schema.
  const manifest = yield* decodeFrozenV1Manifest(
    yield* fs.readFileString(path.resolve(outputDirectory, "frozen-v1-manifest.json")),
  );
  const crypto = yield* Crypto.Crypto;
  const staleFixtures: string[] = [];
  for (const [name, digest] of Object.entries(manifest.sha256)) {
    const contents = yield* fs
      .readFileString(path.resolve(outputDirectory, name))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (
      contents === undefined ||
      Array.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(contents)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("") !== digest
    ) {
      yield* Effect.logError(
        `[swift-wire-fixtures] frozen V1 sample changed: ${name} (restore from ${manifest.baseline})`,
      );
      staleFixtures.push(name);
    }
  }
  if (staleFixtures.length > 0) return yield* new StaleWireFixturesError({ staleFixtures });

  for (const [name, contents] of fixtures) {
    const filePath = path.resolve(outputDirectory, name);
    if (check) {
      const current = yield* fs
        .readFileString(filePath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (current !== contents) {
        yield* Effect.logError(`[swift-wire-fixtures] stale: ${name}`);
        staleFixtures.push(name);
      }
    } else {
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, contents);
      yield* Effect.log(`[swift-wire-fixtures] wrote ${name}`);
    }
  }
  if (staleFixtures.length > 0) return yield* new StaleWireFixturesError({ staleFixtures });
});
generateSwiftWireFixtures.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
