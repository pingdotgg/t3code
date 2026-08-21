import type {
  ApplicationStoredEvent,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";

function upsertById<T extends { readonly id: string }>(
  target: Map<string, T>,
  values: ReadonlyArray<T>,
) {
  for (const value of values) target.set(value.id, value);
}

/** Add descendant agent rows to the root projection without copying their transcripts. */
export function mergeSubagentTreeProjection(
  root: OrchestrationV2ThreadProjection,
  descendants: ReadonlyArray<OrchestrationV2ThreadProjection>,
): OrchestrationV2ThreadProjection {
  if (descendants.length === 0) return root;

  const subagents = new Map(root.subagents.map((subagent) => [subagent.id, subagent]));
  const activations = new Map(
    root.subagentActivations.map((activation) => [activation.id, activation]),
  );
  for (const projection of descendants) {
    upsertById(subagents, projection.subagents);
    upsertById(activations, projection.subagentActivations);
  }
  return {
    ...root,
    subagents: Array.from(subagents.values()),
    subagentActivations: Array.from(activations.values()),
  };
}

export interface SubagentTreeStreamState {
  readonly rootThreadId: ThreadId;
  readonly threadIds: ReadonlySet<ThreadId>;
}

function withChildThread(
  state: SubagentTreeStreamState,
  childThreadId: ThreadId | null,
): SubagentTreeStreamState {
  if (childThreadId === null || state.threadIds.has(childThreadId)) return state;
  return { ...state, threadIds: new Set([...state.threadIds, childThreadId]) };
}

/**
 * Keep the root event stream complete while folding descendant subagent lifecycle
 * events into the same client-side fleet projection.
 */
export function routeSubagentTreeEvent(
  state: SubagentTreeStreamState,
  stored: ApplicationStoredEvent,
): readonly [SubagentTreeStreamState, ReadonlyArray<OrchestrationV2StoredEvent>] {
  if (!("event" in stored)) return [state, []];

  const event = stored.event;
  if (
    event.type === "thread.created" &&
    event.payload.lineage.relationshipToParent === "subagent" &&
    event.payload.lineage.parentThreadId !== null &&
    state.threadIds.has(event.payload.lineage.parentThreadId)
  ) {
    return [withChildThread(state, event.payload.id), []];
  }
  if (event.threadId === state.rootThreadId) {
    return [
      event.type === "subagent.updated"
        ? withChildThread(state, event.payload.childThreadId)
        : state,
      [stored],
    ];
  }
  if (!state.threadIds.has(event.threadId)) return [state, []];
  if (event.type !== "subagent.updated" && event.type !== "subagent-activation.updated") {
    return [state, []];
  }

  const next =
    event.type === "subagent.updated" ? withChildThread(state, event.payload.childThreadId) : state;
  return [
    next,
    [
      {
        ...stored,
        event: { ...event, threadId: state.rootThreadId },
      },
    ],
  ];
}
