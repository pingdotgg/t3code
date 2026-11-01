import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { recallComposerText as recallableComposerPrompt } from "@t3tools/shared/composerContextReferences";

export { recallableComposerPrompt };

type ComposerPromptHistoryMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly id: string;
  readonly context?: OrchestrationMessageContext | undefined;
};

/** Appends a rewound message's authored prompt after whatever the user already drafted. */
export function appendRewoundPrompt(
  currentPrompt: string,
  message: { readonly text: string; readonly context?: OrchestrationMessageContext | undefined },
): string {
  const restoredPrompt = recallableComposerPrompt(message.text, message.context);
  if (restoredPrompt.length === 0) return currentPrompt;
  return currentPrompt.length > 0 ? `${currentPrompt}\n\n${restoredPrompt}` : restoredPrompt;
}

interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

function findActive(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
}

export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    // Automations and other agents send user-role messages; recall only what the user typed.
    if (resolveUserMessagePresentation(message).attribution !== null) continue;
    const prompt = recallableComposerPrompt(message.text, message.context);
    if (prompt.length === 0) continue;
    const previous = entries[entries.length - 1];
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt };
      continue;
    }
    entries.push({ id: message.id, prompt });
  }
  return entries;
}

export function stepComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly position: ComposerPromptHistoryPosition | null;
  readonly currentPrompt: string;
}): ComposerPromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position && position.recalled === currentPrompt ? findActive(entries, position) : -1;

  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}
