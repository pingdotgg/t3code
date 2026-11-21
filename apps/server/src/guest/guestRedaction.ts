import {
  type ModelSelection,
  ORCHESTRATION_V2_SESSION_OPEN_FAILURE_TITLE,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

// What the guest stream leaves out of the owner's thread: the profile, local paths, links to
// other work, and records the guest page never reads. The timeline itself is sent as is.
const GUEST_SESSION_OPEN_FAILURE_MESSAGE = "The agent could not start with this thread's settings.";
// The schema needs a path; the session's real one is the owner's checkout.
const GUEST_SESSION_CWD = ".";

function withoutProfile<S extends ModelSelection>(selection: S): S {
  if (selection.profileId === undefined) return selection;
  const { profileId: _profileId, ...rest } = selection;
  return rest as S;
}

function guestThread(thread: OrchestrationV2AppThread): OrchestrationV2AppThread {
  const {
    linkedPullRequest: _linkedPullRequest,
    pullRequests: _pullRequests,
    branchPullRequest: _branchPullRequest,
    issues: _issues,
    linkOrigin: _linkOrigin,
    delegatedFrom: _delegatedFrom,
    opens: _opens,
    tags: _tags,
    ...rest
  } = thread;
  return {
    ...rest,
    modelSelection: withoutProfile(thread.modelSelection),
    branch: null,
    worktreePath: null,
  };
}

function guestRun(run: OrchestrationV2Run): OrchestrationV2Run {
  const { workspacePreparation: _workspacePreparation, ...rest } = run;
  return { ...rest, modelSelection: withoutProfile(run.modelSelection) };
}

function guestSubagent(subagent: OrchestrationV2Subagent): OrchestrationV2Subagent {
  const { modelSelection, workflow } = subagent;
  // Workflow run handles name the owner's transcript folder and script file.
  const runId = workflow?.runHandles?.runId;
  return {
    ...subagent,
    ...(modelSelection === undefined ? {} : { modelSelection: withoutProfile(modelSelection) }),
    ...(workflow?.runHandles === undefined
      ? {}
      : { workflow: { ...workflow, runHandles: runId === undefined ? {} : { runId } } }),
  };
}

function guestProviderSession(
  session: OrchestrationV2ProviderSession,
): OrchestrationV2ProviderSession {
  const { extensionStatuses: _extensionStatuses, ...rest } = session;
  return { ...rest, cwd: GUEST_SESSION_CWD };
}

// A native id can be a local path, such as Pi's session file. The reference stays, since the
// reducer reads whether one exists.
function withoutNativeId<R extends OrchestrationV2ProviderRef | null | undefined>(ref: R): R {
  if (ref == null) return ref;
  const { fingerprint: _fingerprint, ...rest } = ref;
  return { ...rest, nativeId: null } as R;
}

// Native metadata holds the provider's own model selection and paths.
function guestProviderThread(thread: OrchestrationV2ProviderThread): OrchestrationV2ProviderThread {
  return {
    ...thread,
    nativeThreadRef: withoutNativeId(thread.nativeThreadRef),
    nativeConversationHeadRef: withoutNativeId(thread.nativeConversationHeadRef),
    nativeMetadata: null,
  };
}

function guestProviderTurn(turn: OrchestrationV2ProviderTurn): OrchestrationV2ProviderTurn {
  const { nativeThreadRef, ...rest } = turn;
  return {
    ...rest,
    nativeTurnRef: withoutNativeId(turn.nativeTurnRef),
    ...(nativeThreadRef === undefined ? {} : { nativeThreadRef: withoutNativeId(nativeThreadRef) }),
  };
}

function guestAttempt(attempt: OrchestrationV2RunAttempt): OrchestrationV2RunAttempt {
  const { nativeThreadId: _nativeThreadId, ...rest } = attempt;
  return rest;
}

export function guestTurnItem<I extends OrchestrationV2TurnItem>(item: I): I {
  switch (item.type) {
    case "error":
      return item.title === ORCHESTRATION_V2_SESSION_OPEN_FAILURE_TITLE
        ? { ...item, failure: { ...item.failure, message: GUEST_SESSION_OPEN_FAILURE_MESSAGE } }
        : item;
    case "user_message":
      return item.modelSwitch === undefined
        ? item
        : {
            ...item,
            modelSwitch: {
              from: withoutProfile(item.modelSwitch.from),
              to: withoutProfile(item.modelSwitch.to),
            },
          };
    case "handoff":
      return item.fromModelSelections === undefined
        ? item
        : { ...item, fromModelSelections: item.fromModelSelections.map(withoutProfile) };
    default:
      return item;
  }
}

function guestProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    thread: guestThread(projection.thread),
    runs: projection.runs.map(guestRun),
    attempts: projection.attempts.map(guestAttempt),
    subagents: projection.subagents.map(guestSubagent),
    providerSessions: projection.providerSessions.map(guestProviderSession),
    providerThreads: projection.providerThreads.map(guestProviderThread),
    providerTurns: projection.providerTurns.map(guestProviderTurn),
    turnItems: projection.turnItems.map(guestTurnItem),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: guestTurnItem(row.item),
    })),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
  };
}

/** The event as the guest gets it, or null for one the guest page has no use for. */
function guestEvent(event: OrchestrationV2DomainEvent): OrchestrationV2DomainEvent | null {
  switch (event.type) {
    case "thread.pull-request-link-updated":
    case "thread.visit-recorded":
    case "checkpoint-scope.created":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "context-handoff.updated":
    case "context-transfer.created":
    case "context-transfer.updated":
      return null;
    case "run.created":
    case "run.updated":
      return { ...event, payload: guestRun(event.payload) };
    case "subagent.updated":
      return { ...event, payload: guestSubagent(event.payload) };
    case "provider-session.attached":
    case "provider-session.updated":
      return { ...event, payload: guestProviderSession(event.payload) };
    case "provider-thread.updated":
      return { ...event, payload: guestProviderThread(event.payload) };
    case "turn-item.updated":
      return { ...event, payload: guestTurnItem(event.payload) };
    case "run-attempt.created":
    case "run-attempt.updated":
      return { ...event, payload: guestAttempt(event.payload) };
    case "provider-turn.updated":
      return { ...event, payload: guestProviderTurn(event.payload) };
    case "run.background-work-cancelled":
    case "node.updated":
    case "provider-session.detached":
    case "runtime-request.updated":
    case "message.updated":
    case "plan.updated":
      return event;
    default:
      // Every other event carries the thread record.
      return { ...event, payload: guestThread(event.payload) };
  }
}

export function guestSnapshot<S extends { readonly projection: OrchestrationV2ThreadProjection }>(
  snapshot: S,
): S {
  return { ...snapshot, projection: guestProjection(snapshot.projection) };
}

/** A thread stream item as the guest gets it, or null to skip it. */
export function guestStreamItem(
  item: OrchestrationV2ThreadStreamItem,
): OrchestrationV2ThreadStreamItem | null {
  switch (item.kind) {
    case "snapshot":
      return guestSnapshot(item);
    case "event": {
      const event = guestEvent(item.event);
      return event === null ? null : { ...item, event };
    }
    default:
      return item;
  }
}

export function guestHistoryPage(
  page: OrchestrationV2ThreadHistoryPage,
): OrchestrationV2ThreadHistoryPage {
  return {
    ...page,
    items: page.items.map((row) => ({ ...row, item: guestTurnItem(row.item) })),
    ...(page.subagents === undefined ? {} : { subagents: page.subagents.map(guestSubagent) }),
  };
}
