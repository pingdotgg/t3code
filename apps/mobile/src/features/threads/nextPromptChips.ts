// Custom build: next-prompt suggestion buttons above the composer, as on desktop
// (apps/web/src/components/chat/NextPromptSuggestionChips.tsx).
import type {
  OrchestrationV2NextPromptCommand,
  OrchestrationV2NextPromptSuggestions,
  RunId,
  ServerProvider,
} from "@t3tools/contracts";

export interface NextPromptChip {
  readonly kind: "prompt" | "skill" | "command";
  /** The suggestion as shown: a sentence, or `$skill` / `/command`. */
  readonly label: string;
  /** What a tap puts in the empty composer. */
  readonly insertText: string;
}

const MAX_CHIPS = 4;

export function nextPromptChipFor(kind: NextPromptChip["kind"], text: string): NextPromptChip {
  const insertText = kind === "skill" ? `$${text} ` : kind === "command" ? `/${text} ` : text;
  return { kind, label: kind === "prompt" ? text : insertText.trim(), insertText };
}

/** The skills and commands a person could type, which the model may suggest. */
export function offeredNextPromptCommands(
  skills: ServerProvider["skills"],
  slashCommands: ServerProvider["slashCommands"],
): ReadonlyArray<OrchestrationV2NextPromptCommand> {
  const commands: Array<OrchestrationV2NextPromptCommand> = [];
  for (const skill of skills) {
    // Agent-only skills have no command a person could type.
    if (!skill.enabled || skill.userInvocable === false) continue;
    const description = skill.shortDescription ?? skill.description;
    commands.push({
      name: skill.name,
      kind: "skill",
      ...(description === undefined ? {} : { description }),
    });
  }
  for (const command of slashCommands) {
    commands.push({
      name: command.name,
      kind: "command",
      ...(command.description === undefined ? {} : { description: command.description }),
    });
  }
  return commands;
}

/**
 * The command list to freeze for a run, or null to wait. The server caches suggestions per run,
 * so freezing `[]` before the server config arrives (a thread opened cold from a notification)
 * would leave that run without skills or commands everywhere. Once the config has loaded, a
 * missing provider still freezes `[]`, so a reply's own `options` block shows.
 */
export function nextPromptCommandsToFreeze(input: {
  readonly configLoaded: boolean;
  readonly provider: Pick<ServerProvider, "skills" | "slashCommands"> | null;
}): ReadonlyArray<OrchestrationV2NextPromptCommand> | null {
  if (!input.configLoaded) return null;
  if (input.provider === null) return [];
  return offeredNextPromptCommands(input.provider.skills, input.provider.slashCommands);
}

/**
 * Up to four buttons for the latest completed run. A reply's own `options` block shows even
 * with the Labs switch off and replaces every guess; otherwise (switch on) the provider's own
 * predicted prompt comes first, then the small model's picks, as on desktop. Suggestions that differ only by
 * case or trailing punctuation ("Use React." and "Use React") show once.
 */
export function buildNextPromptChips(input: {
  readonly enabled: boolean;
  readonly completedRunId: RunId | null;
  readonly data: OrchestrationV2NextPromptSuggestions | null;
  /** The provider's predicted next prompt for this run, if any. */
  readonly builtInSuggestion?: string | null;
}): ReadonlyArray<NextPromptChip> {
  const { completedRunId } = input;
  if (completedRunId === null) return [];
  const data = input.data !== null && input.data.runId === completedRunId ? input.data : null;
  const fromReply = data?.fromReply === true;
  if (!input.enabled && !fromReply) return [];
  const chips: Array<NextPromptChip> = [];
  const seen = new Set<string>();
  const add = (chip: NextPromptChip) => {
    const key = chip.insertText
      .trim()
      .toLowerCase()
      .replace(/[.!?…]+$/, "");
    if (key.length === 0 || seen.has(key) || chips.length >= MAX_CHIPS) return;
    seen.add(key);
    chips.push(chip);
  };
  const builtIn = input.builtInSuggestion ?? null;
  if (!fromReply && builtIn !== null) add(nextPromptChipFor("prompt", builtIn));
  for (const suggestion of data?.suggestions ?? []) {
    add(nextPromptChipFor(suggestion.kind, suggestion.text));
  }
  return chips;
}

/**
 * Whether an empty composer is waiting for the next message: never over a pending question,
 * approval or plan, and never while a queued message waits for the server (the thread reads
 * busy only once the new run starts, so the row would flash back after every send).
 */
export function nextPromptChipsAllowed(input: {
  readonly isDraft: boolean;
  /** A message was sent after the latest run, so its buttons are spent. */
  readonly sentSinceLatestRun: boolean;
  readonly canOperateThread: boolean;
  readonly threadBusy: boolean;
  readonly queuedMessageCount: number;
  readonly editingQueuedMessage: boolean;
  readonly submissionLocked: boolean;
  readonly voiceInputPresented: boolean;
  readonly modelUnavailable: boolean;
  readonly attachmentCount: number;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
}): boolean {
  return (
    !input.isDraft &&
    !input.sentSinceLatestRun &&
    input.canOperateThread &&
    !input.threadBusy &&
    input.queuedMessageCount === 0 &&
    !input.editingQueuedMessage &&
    !input.submissionLocked &&
    !input.voiceInputPresented &&
    !input.modelUnavailable &&
    input.attachmentCount === 0 &&
    !input.hasPendingApprovals &&
    !input.hasPendingUserInput &&
    !input.hasActionableProposedPlan
  );
}

/** The buttons stay while the composer is empty or holds one of them unchanged; any edit hides them. */
export function visibleNextPromptChips(
  chips: ReadonlyArray<NextPromptChip>,
  draftText: string,
): { readonly chips: ReadonlyArray<NextPromptChip>; readonly activeIndex: number } {
  const activeIndex = chips.findIndex((chip) => chip.insertText === draftText);
  return draftText.length === 0 || activeIndex !== -1
    ? { chips, activeIndex }
    : { chips: [], activeIndex: -1 };
}

/** The composer text after a tap, or null when the person's own text is there. */
export function nextPromptChipDraft(
  chips: ReadonlyArray<NextPromptChip>,
  draftText: string,
  chip: NextPromptChip,
): string | null {
  if (draftText.length > 0 && !chips.some((candidate) => candidate.insertText === draftText)) {
    return null;
  }
  return chip.insertText;
}
