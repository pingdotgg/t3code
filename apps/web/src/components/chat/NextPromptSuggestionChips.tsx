// Custom build: next-prompt suggestion buttons above the composer.
import type {
  EnvironmentId,
  OrchestrationV2NextPromptCommand,
  RunId,
  ServerProvider,
} from "@t3tools/contracts";
import { isNextPromptInDraft } from "@t3tools/client-runtime/next-prompt-draft";
import { useState, useSyncExternalStore } from "react";

import type { Thread } from "../../types";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Kbd } from "../ui/kbd";

export interface NextPromptChip {
  readonly kind: "prompt" | "skill" | "command";
  /** The suggestion as shown: a sentence, or a skill or command name. */
  readonly label: string;
  /** What a click adds to the composer. */
  readonly insertText: string;
}

const MAX_CHIPS = 4;

// Dismissed runs, keyed by environment and run, shared by every mounted composer.
let dismissedKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readDismissed = () => dismissedKeys;
const dismissKey = (environmentId: EnvironmentId, runId: RunId) => `${environmentId}\u0000${runId}`;

const chipFor = (kind: NextPromptChip["kind"], text: string): NextPromptChip => ({
  kind,
  label: text,
  insertText: kind === "skill" ? `$${text} ` : kind === "command" ? `/${text} ` : text,
});

function offeredCommands(
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
 * Up to four next prompts for the thread's latest completed run: the provider's own prediction
 * first when there is one, then the ones a small model picks, which may name a skill or command.
 */
export function useNextPromptChips(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: Thread | undefined;
  readonly builtInSuggestion: string | null;
  readonly skills: ServerProvider["skills"];
  readonly slashCommands: ServerProvider["slashCommands"];
}): { readonly chips: ReadonlyArray<NextPromptChip>; readonly dismiss: () => void } {
  const { environmentId, thread } = input;
  const enabled = useServerConfigs().get(environmentId)?.settings.promptSuggestionsEnabled === true;
  const latestRun = thread?.latestRun;
  const completedRunId =
    latestRun !== undefined && latestRun !== null && latestRun.status === "completed"
      ? latestRun.runId
      : null;

  // Freeze the command list per run: a workspace rescan must not ask the model again.
  const [frozen, setFrozen] = useState<{
    readonly runId: RunId;
    readonly commands: ReadonlyArray<OrchestrationV2NextPromptCommand>;
  } | null>(null);
  if (completedRunId !== null && frozen?.runId !== completedRunId) {
    setFrozen({
      runId: completedRunId,
      commands: offeredCommands(input.skills, input.slashCommands),
    });
  }
  const commands = frozen !== null && frozen.runId === completedRunId ? frozen.commands : null;

  const { data } = useEnvironmentQuery(
    // Asked even with the Labs switch off: a reply's own `options` block needs no model.
    thread !== undefined && completedRunId !== null && commands !== null
      ? orchestrationEnvironment.v2.nextPromptSuggestions({
          environmentId,
          input: { threadId: thread.id, runId: completedRunId, commands },
        })
      : null,
  );
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed);

  const dismiss = () => {
    if (completedRunId === null) return;
    dismissedKeys = new Set(dismissedKeys).add(dismissKey(environmentId, completedRunId));
    for (const listener of listeners) listener();
  };
  const runData = data !== null && data.runId === completedRunId ? data : null;
  // The reply's own options replace every guess; without them the buttons are a Labs feature.
  const fromReply = runData?.fromReply === true;
  if (
    (!enabled && !fromReply) ||
    completedRunId === null ||
    dismissed.has(dismissKey(environmentId, completedRunId))
  ) {
    return { chips: [], dismiss };
  }

  const chips: Array<NextPromptChip> = [];
  const seen = new Set<string>();
  const add = (chip: NextPromptChip) => {
    // "Use React." and "Use React" are the same suggestion.
    const key = chip.insertText
      .trim()
      .toLowerCase()
      .replace(/[.!?…]+$/, "");
    if (key.length === 0 || seen.has(key) || chips.length >= MAX_CHIPS) return;
    seen.add(key);
    chips.push(chip);
  };
  if (!fromReply && input.builtInSuggestion !== null) {
    add(chipFor("prompt", input.builtInSuggestion));
  }
  if (runData !== null) {
    for (const suggestion of runData.suggestions) add(chipFor(suggestion.kind, suggestion.text));
  }
  return { chips, dismiss };
}

/**
 * Sits above the composer inside its overlay, so the measured composer height includes the
 * buttons and the conversation leaves room for them instead of being covered.
 */
export function NextPromptSuggestionChips(props: {
  readonly chips: ReadonlyArray<NextPromptChip>;
  readonly showTabHint: boolean;
  /** The chip whose text is in the composer unchanged, or -1. */
  readonly activeIndex?: number;
  /** The composer text, to mark the chips already added to it. */
  readonly draft: string;
  readonly onPick: (chip: NextPromptChip) => void;
}) {
  if (props.chips.length === 0) return null;
  const activeIndex = props.activeIndex ?? -1;
  // The hint sits on the chip the next Tab puts in the composer.
  const tabTargetIndex =
    activeIndex === -1 ? 0 : props.chips.length > 1 ? (activeIndex + 1) % props.chips.length : -1;
  const picked = props.chips.map((chip) => isNextPromptInDraft(props.draft, chip.insertText));
  return (
    <div data-next-prompt-suggestions="true" role="group" aria-label="Add to your message">
      <div className="mb-2 flex flex-wrap justify-start gap-1.5 px-1">
        {props.chips.map((chip, index) => (
          <button
            key={`${chip.kind}:${chip.label}`}
            type="button"
            aria-label={chip.kind === "prompt" ? chip.label : chip.insertText.trim()}
            aria-pressed={picked[index]}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onPick(chip)}
            className={`${
              chip.kind === "prompt"
                ? "inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-border bg-popover px-3 py-1 text-xs text-popover-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                : "inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-primary/60 bg-popover px-3 py-1 text-xs text-primary shadow-sm transition-colors hover:bg-accent"
            }${picked[index] ? " bg-accent ring-1 ring-primary" : ""}`}
          >
            {chip.kind === "prompt" ? null : (
              <span className="font-mono opacity-70">{chip.kind === "skill" ? "$" : "/"}</span>
            )}
            <span className="truncate">{chip.label}</span>
            {props.showTabHint && index === tabTargetIndex ? (
              <Kbd
                variant="outline"
                className="ml-0.5 hidden [@media(any-pointer:fine)]:inline-flex"
              >
                ⇥ Tab
              </Kbd>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
