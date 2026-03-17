import type { ChatMessage, Project, Thread } from "./types";

export interface ComposerPromptHistoryNavigationState {
  draftPrompt: string;
  historyIndex: number;
}

interface ResolveComposerPromptHistoryEntriesInput {
  currentProjectId: Project["id"] | null | undefined;
  currentThreadMessages: ChatMessage[];
  projects: Project[];
  threads: Thread[];
  ignoredMessageTexts?: readonly string[];
}

interface ComposerPromptHistoryCandidate {
  createdAt: string;
  sequence: number;
  text: string;
}

interface NavigateComposerPromptHistoryInput {
  currentPrompt: string;
  direction: "up" | "down";
  entries: string[];
  navigationState: ComposerPromptHistoryNavigationState | null;
}

interface NavigateComposerPromptHistoryResult {
  handled: boolean;
  nextNavigationState: ComposerPromptHistoryNavigationState | null;
  nextPrompt: string;
}

function isRecallableUserMessage(
  message: ChatMessage,
  ignoredMessageTexts: ReadonlySet<string>,
): boolean {
  return message.role === "user" && !ignoredMessageTexts.has(message.text);
}

function collectThreadPromptHistoryEntries(
  messages: ChatMessage[],
  ignoredMessageTexts: ReadonlySet<string>,
): string[] {
  const entries: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isRecallableUserMessage(message, ignoredMessageTexts)) {
      entries.push(message.text);
    }
  }
  return entries;
}

function comparePromptHistoryCandidates(
  left: ComposerPromptHistoryCandidate,
  right: ComposerPromptHistoryCandidate,
): number {
  const leftCreatedAtMs = Date.parse(left.createdAt);
  const rightCreatedAtMs = Date.parse(right.createdAt);
  const leftHasTimestamp = Number.isFinite(leftCreatedAtMs);
  const rightHasTimestamp = Number.isFinite(rightCreatedAtMs);

  if (leftHasTimestamp && rightHasTimestamp && leftCreatedAtMs !== rightCreatedAtMs) {
    return rightCreatedAtMs - leftCreatedAtMs;
  }
  if (leftHasTimestamp !== rightHasTimestamp) {
    return leftHasTimestamp ? -1 : 1;
  }
  return right.sequence - left.sequence;
}

export function resolveComposerPromptHistoryEntries(
  input: ResolveComposerPromptHistoryEntriesInput,
): string[] {
  const ignoredMessageTexts = new Set(input.ignoredMessageTexts ?? []);
  const currentThreadEntries = collectThreadPromptHistoryEntries(
    input.currentThreadMessages,
    ignoredMessageTexts,
  );
  if (currentThreadEntries.length > 0) {
    return currentThreadEntries;
  }

  const currentProject = input.projects.find((project) => project.id === input.currentProjectId);
  if (!currentProject) {
    return [];
  }

  const projectCwdById = new Map(input.projects.map((project) => [project.id, project.cwd] as const));
  const candidates: ComposerPromptHistoryCandidate[] = [];
  let sequence = 0;

  for (const thread of input.threads) {
    if (projectCwdById.get(thread.projectId) !== currentProject.cwd) {
      continue;
    }
    for (const message of thread.messages) {
      if (!isRecallableUserMessage(message, ignoredMessageTexts)) {
        continue;
      }
      candidates.push({
        createdAt: message.createdAt,
        sequence,
        text: message.text,
      });
      sequence += 1;
    }
  }

  return candidates.toSorted(comparePromptHistoryCandidates).map((candidate) => candidate.text);
}

export function resolveComposerPromptRecall(
  input: ResolveComposerPromptHistoryEntriesInput,
): string | null {
  return resolveComposerPromptHistoryEntries(input)[0] ?? null;
}

export function navigateComposerPromptHistory(
  input: NavigateComposerPromptHistoryInput,
): NavigateComposerPromptHistoryResult {
  if (input.entries.length === 0) {
    return {
      handled: false,
      nextNavigationState: input.navigationState,
      nextPrompt: input.currentPrompt,
    };
  }

  if (input.direction === "up") {
    if (!input.navigationState) {
      return {
        handled: true,
        nextNavigationState: {
          draftPrompt: input.currentPrompt,
          historyIndex: 0,
        },
        nextPrompt: input.entries[0] ?? input.currentPrompt,
      };
    }

    if (input.navigationState.historyIndex >= input.entries.length - 1) {
      return {
        handled: false,
        nextNavigationState: input.navigationState,
        nextPrompt: input.currentPrompt,
      };
    }

    const nextIndex = Math.min(input.navigationState.historyIndex + 1, input.entries.length - 1);
    return {
      handled: true,
      nextNavigationState: {
        ...input.navigationState,
        historyIndex: nextIndex,
      },
      nextPrompt: input.entries[nextIndex] ?? input.currentPrompt,
    };
  }

  if (!input.navigationState) {
    return {
      handled: false,
      nextNavigationState: null,
      nextPrompt: input.currentPrompt,
    };
  }

  const nextIndex = input.navigationState.historyIndex - 1;
  if (nextIndex < 0) {
    return {
      handled: true,
      nextNavigationState: null,
      nextPrompt: input.navigationState.draftPrompt,
    };
  }

  return {
    handled: true,
    nextNavigationState: {
      ...input.navigationState,
      historyIndex: nextIndex,
    },
    nextPrompt: input.entries[nextIndex] ?? input.currentPrompt,
  };
}
