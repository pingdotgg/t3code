import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import {
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandPopover";

/** Built-in commands the composer offers on top of the provider's own list. */
export type ComposerBuiltInCommand = "model" | "plan" | "default";

/** The slice of a provider snapshot the trigger menu reads. */
export interface ComposerTriggerMenuProvider {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

export interface ComposerTriggerMenuPathEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

const BUILT_IN_COMMAND_DESCRIPTIONS: Record<ComposerBuiltInCommand, string> = {
  model: "Switch model",
  plan: "Switch to plan mode",
  default: "Switch to default mode",
};

const SKILL_MENU_LIMIT = 20;

function skillItem(skill: ServerProviderSkill): ComposerCommandItem {
  return {
    id: `skill:${skill.name}`,
    type: "skill",
    skill,
    label: skill.displayName ?? skill.name,
    description: skill.shortDescription ?? skill.description ?? "",
  };
}

function rankSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  query: string,
): ReadonlyArray<ServerProviderSkill> {
  const ranked: Array<{ item: ServerProviderSkill; score: number; tieBreaker: string }> = [];
  for (const skill of skills) {
    const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
    const scores = [
      scoreQueryMatch({
        value: skill.name.toLowerCase(),
        query,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: ["-", "_", "/"],
      }),
      scoreQueryMatch({
        value: displayLabel,
        query,
        exactBase: 1,
        prefixBase: 3,
        boundaryBase: 5,
        includesBase: 7,
        fuzzyBase: 110,
      }),
      scoreQueryMatch({
        value: skill.shortDescription?.toLowerCase() ?? "",
        query,
        exactBase: 20,
        prefixBase: 22,
        boundaryBase: 24,
        includesBase: 26,
      }),
      scoreQueryMatch({
        value: skill.description?.toLowerCase() ?? "",
        query,
        exactBase: 30,
        prefixBase: 32,
        boundaryBase: 34,
        includesBase: 36,
      }),
    ].filter((score): score is number => score !== null);

    if (scores.length > 0) {
      insertRankedSearchResult(
        ranked,
        {
          item: skill,
          score: Math.min(...scores),
          tieBreaker: `${displayLabel}\u0000${skill.name}`,
        },
        SKILL_MENU_LIMIT,
      );
    }
  }

  return ranked.map(({ item }) => item);
}

/**
 * Build the popover rows for the active trigger. Callers own the trigger
 * detection and the path search; this only shapes and ranks what they hold.
 *
 * `builtInCommands` lets a surface drop commands it cannot honor while keeping
 * one ranking and labeling implementation: `/model` only inserts dead text on
 * mobile because nothing handles the `slash-model` trigger it becomes, and the
 * new-task draft also hides plan/default when plan mode is off.
 */
export function buildComposerMenuItems(input: {
  readonly trigger: ComposerTrigger | null;
  readonly provider: ComposerTriggerMenuProvider | null;
  readonly builtInCommands: ReadonlyArray<ComposerBuiltInCommand>;
  readonly pathEntries: ReadonlyArray<ComposerTriggerMenuPathEntry>;
}): ReadonlyArray<ComposerCommandItem> {
  const { trigger } = input;
  if (!trigger) return [];

  if (trigger.kind === "slash-command") {
    const query = trigger.query.toLowerCase();
    const items: ComposerCommandItem[] = [];
    for (const command of input.builtInCommands) {
      if (!command.includes(query)) continue;
      items.push({
        id: `cmd:${command}`,
        type: "slash-command",
        command,
        label: `/${command}`,
        description: BUILT_IN_COMMAND_DESCRIPTIONS[command],
      });
    }
    for (const command of input.provider?.slashCommands ?? []) {
      if (!command.name.toLowerCase().includes(query)) continue;
      items.push({
        id: `pcmd:${command.name}`,
        type: "provider-slash-command",
        command,
        label: `/${command.name}`,
        description: command.description ?? "",
      });
    }
    return items;
  }

  if (trigger.kind === "skill") {
    const enabledSkills = (input.provider?.skills ?? []).filter((skill) => skill.enabled);
    const query = normalizeSearchQuery(trigger.query, { trimLeadingPattern: /^\$+/ });
    if (!query) {
      return enabledSkills.slice(0, SKILL_MENU_LIMIT).map(skillItem);
    }
    return rankSkills(enabledSkills, query).map(skillItem);
  }

  if (trigger.kind === "path") {
    return input.pathEntries.map((entry): ComposerCommandItem => {
      const parts = entry.path.split("/");
      return {
        id: `path:${entry.path}`,
        type: "path",
        path: entry.path,
        kind: entry.kind,
        label: parts[parts.length - 1] ?? entry.path,
        description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
      };
    });
  }

  return [];
}

/**
 * What accepting a menu row does to the draft. `interactionMode` rows drop the
 * typed command entirely and hand the mode to the caller; everything else
 * substitutes its own token in place of the trigger.
 */
export type ComposerCommandSelection = {
  readonly text: string;
  readonly cursor: number;
  readonly interactionMode: "plan" | "default" | null;
};

export function resolveComposerCommandSelection(input: {
  readonly text: string;
  readonly trigger: ComposerTrigger;
  readonly item: ComposerCommandItem;
}): ComposerCommandSelection {
  const { item, trigger } = input;
  const interactionMode =
    item.type === "slash-command" && (item.command === "plan" || item.command === "default")
      ? item.command
      : null;

  let replacement = "";
  if (interactionMode !== null) {
    // Switching the mode consumes the command; no text is left behind.
    replacement = "";
  } else if (item.type === "path") {
    replacement = `${serializeComposerFileLink(item.path)} `;
  } else if (item.type === "skill") {
    replacement = `$${item.skill.name} `;
  } else if (item.type === "slash-command") {
    replacement = `/${item.command} `;
  } else {
    replacement = `/${item.command.name} `;
  }

  const result = replaceTextRange(input.text, trigger.rangeStart, trigger.rangeEnd, replacement);

  return { text: result.text, cursor: result.cursor, interactionMode };
}

/** Caret offsets as the editor reports them; `start === end` is a bare caret. */
export interface ComposerSelectionRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Where the caret belongs after the composer's text changed. A draft swap
 * parks it at the end of the newly loaded text: an offset measured against the
 * previous draft points at unrelated characters, and can land just after an
 * `@`/`$`/`/` token so the trigger popover opens without any user input. Any
 * other change only clamps the caret into the text, and returns `current`
 * unchanged when nothing moved so React can skip the update.
 */
export function nextComposerSelection(input: {
  readonly current: ComposerSelectionRange;
  readonly textLength: number;
  readonly draftChanged: boolean;
}): ComposerSelectionRange {
  const { current, textLength } = input;
  if (input.draftChanged) {
    if (current.start === textLength && current.end === textLength) {
      return current;
    }
    return { start: textLength, end: textLength };
  }
  const start = Math.min(current.start, textLength);
  const end = Math.min(current.end, textLength);
  if (start === current.start && end === current.end) {
    return current;
  }
  return { start, end };
}
