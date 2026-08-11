import {
  type MessageId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { selectEnvironmentState, type AppState, type EnvironmentState } from "./store";
import { type ChatMessage, type Project, type Thread } from "./types";
import {
  getThreadCoreFromEnvironmentState,
  getThreadFromEnvironmentState,
  selectThreadMessageIds,
  selectThreadMessages,
} from "./threadDerivation";

export function createProjectSelectorByRef(
  ref: ScopedProjectRef | null | undefined,
): (state: AppState) => Project | undefined {
  return (state) =>
    ref ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId] : undefined;
}

function createScopedThreadCoreSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (
      previousThread &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId
    ) {
      return previousThread;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousThread = getThreadCoreFromEnvironmentState(environmentState, ref.threadId);
    return previousThread;
  };
}

function createScopedThreadMessagesSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => ChatMessage[] {
  const emptyMessages: ChatMessage[] = [];
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousMessages: ChatMessage[] | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return emptyMessages;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const messages = selectThreadMessages(environmentState, ref.threadId);
    if (
      previousMessages &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId &&
      previousMessages === messages
    ) {
      return previousMessages;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousMessages = messages;
    return messages;
  };
}

function createScopedThreadMessageIdsSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => readonly MessageId[] {
  const emptyMessageIds: MessageId[] = [];
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousMessageIds: readonly MessageId[] | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return emptyMessageIds;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const messageIds = selectThreadMessageIds(environmentState, ref.threadId);
    if (
      previousMessageIds &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId &&
      previousMessageIds === messageIds
    ) {
      return previousMessageIds;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousMessageIds = messageIds;
    return messageIds;
  };
}

function createScopedThreadSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (
      previousThread &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId
    ) {
      return previousThread;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousThread = getThreadFromEnvironmentState(environmentState, ref.threadId);
    return previousThread;
  };
}

export function createThreadSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector(() => ref);
}

export function createThreadCoreSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadCoreSelector(() => ref);
}

export function createThreadMessagesSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ChatMessage[] {
  return createScopedThreadMessagesSelector(() => ref);
}

export function createThreadMessageIdsSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => readonly MessageId[] {
  return createScopedThreadMessageIdsSelector(() => ref);
}

export function createThreadSelectorAcrossEnvironments(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector((state) => {
    if (!threadId) {
      return undefined;
    }

    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[ScopedThreadRef["environmentId"], EnvironmentState]>) {
      if (environmentState.threadShellById[threadId]) {
        return {
          environmentId,
          threadId,
        };
      }
    }
    return undefined;
  });
}
