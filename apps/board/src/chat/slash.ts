import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";

export type SlashGroup = "command" | "skill" | "action";

/** The composer actions T3's own chat offers, which the board runs itself. */
export type SlashAction = "model" | "clear";

export interface SlashItem {
  readonly id: string;
  readonly group: SlashGroup;
  readonly name: string;
  /** What the menu shows and what picking it types into the message. */
  readonly label: string;
  readonly description: string;
  /** The argument the command takes, as the engine describes it. */
  readonly hint: string | null;
  readonly action: SlashAction | null;
}

export const GROUP_ORDER: ReadonlyArray<SlashGroup> = ["command", "skill", "action"];

export const GROUP_TITLE = {
  command: "Commands",
  skill: "Skills",
  action: "T3 actions",
} satisfies Record<SlashGroup, string>;

const ACTIONS = {
  model: { description: "Switch response model for this thread" },
  clear: { description: "Start a fresh session; earlier messages stay visible" },
} satisfies Record<SlashAction, { readonly description: string }>;

/**
 * The menu's items for one instance. A command that a visible skill shares its name with is left
 * out, as in T3, and so is one that a T3 action shares its name with, such as `/model`. `/compact` runs only as the whole
 * message, so it goes once the message has other text.
 */
export function buildSlashItems(input: {
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly actions: ReadonlyArray<SlashAction>;
  readonly messageIsOnlyTheCommand: boolean;
}): ReadonlyArray<SlashItem> {
  const skills = getProviderSkillsForSlashMenu(input.skills, true);
  const commands = getProviderSlashCommandsForSlashMenu(input.commands, skills).filter(
    (command) =>
      (command.name !== "compact" || input.messageIsOnlyTheCommand) &&
      !input.actions.some((action) => action === command.name),
  );
  return [
    ...commands.map((command): SlashItem => ({
      id: `command:${command.name}`,
      group: "command",
      name: command.name,
      label: `/${command.name}`,
      description: command.description ?? command.input?.hint ?? "Run provider command",
      hint: command.input?.hint ?? null,
      action: null,
    })),
    ...skills.map((skill): SlashItem => ({
      id: `skill:${skill.name}`,
      group: "skill",
      name: skill.name,
      label: `$${skill.name}`,
      description:
        skill.shortDescription ??
        skill.description ??
        (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      hint: null,
      action: null,
    })),
    ...input.actions.map((action): SlashItem => ({
      id: `action:${action}`,
      group: "action",
      name: action,
      label: `/${action}`,
      description: ACTIONS[action].description,
      hint: null,
      action,
    })),
  ];
}

const WORD_BREAK = /[\s\-_:/.]+/;

const startsAWord = (text: string, query: string) =>
  text
    .toLowerCase()
    .split(WORD_BREAK)
    .some((word) => word.startsWith(query));

/** 0 for a name that starts with the query, 1 for a name or description with a word that does, null for no match. */
function tier(item: SlashItem, query: string): 0 | 1 | null {
  if (item.name.toLowerCase().startsWith(query)) return 0;
  return startsAWord(item.name, query) || startsAWord(item.description, query) ? 1 : null;
}

/**
 * The items a query keeps. Names that start with the query come first, then the ones with a word
 * that does. Inside each of those, items are grouped as commands, then skills, then T3 actions, in
 * the order the engine listed them. An empty query keeps every item, grouped the same way.
 */
export function rankSlashItems(
  items: ReadonlyArray<SlashItem>,
  query: string,
): ReadonlyArray<SlashItem> {
  const needle = query.trim().toLowerCase();
  const byGroup = GROUP_ORDER.flatMap((group) => items.filter((item) => item.group === group));
  if (needle === "") return byGroup;
  const ranks = new Map(byGroup.map((item) => [item, tier(item, needle)]));
  return [0, 1].flatMap((rank) => byGroup.filter((item) => ranks.get(item) === rank));
}

/** The query after a leading `/` when the cursor sits in the message's first word, or null when the menu stays shut. */
export function slashQuery(draft: string, cursor: number): string | null {
  const head = draft.slice(0, cursor);
  return /^\/\S*$/.test(head) ? head.slice(1) : null;
}

/** The message a picked item sends, with its argument after it. A T3 action sends no message. */
export function slashMessage(item: SlashItem, argument: string): string {
  if (item.action !== null) return "";
  const text = argument.trim();
  return text === "" ? item.label : `${item.label} ${text}`;
}
