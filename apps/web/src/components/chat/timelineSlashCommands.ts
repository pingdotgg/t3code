import {
  BoxIcon,
  ChartColumnIcon,
  CirclePauseIcon,
  EraserIcon,
  FilePlusIcon,
  GaugeIcon,
  Minimize2Icon,
  PlugIcon,
  ScanSearchIcon,
  SendIcon,
  ShieldCheckIcon,
  TargetIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** What the thread's provider answers to under `/`: its listed commands and its skills. */
export interface SlashCommandCatalog {
  readonly commands: ReadonlyArray<{ readonly name: string }>;
  readonly skills: ReadonlyArray<{ readonly name: string }>;
}

export const EMPTY_SLASH_COMMAND_CATALOG: SlashCommandCatalog = { commands: [], skills: [] };

/** A user message that opens with a provider command or skill. */
export interface SlashCommandMessage {
  readonly sigil: "/" | "$";
  readonly name: string;
  /** The text after the name, trimmed. */
  readonly args: string;
  readonly skill: boolean;
  /**
   * Nothing past one argument word (`/compact`, `/goal pause`): the timeline
   * shows it as a work row. Longer text stays the user's message.
   */
  readonly standalone: boolean;
}

export type SlashCommandState = "running" | "done" | "failed" | "stopped";

interface Presentation {
  readonly icon: LucideIcon;
  readonly running: string;
  readonly done: string;
  readonly failed: string;
}

const present = (icon: LucideIcon, running: string, done: string, failed: string) => ({
  icon,
  running,
  done,
  failed,
});

/** Commands providers run as a turn of their own. Other listed commands use `FALLBACK`. */
const COMMANDS = new Map<string, Presentation>([
  [
    "compact",
    present(Minimize2Icon, msg("Compacting the conversation"), msg("Compacted", { $context: "slash command row, the conversation was compacted" }), msg("Couldn't compact")),
  ],
  [
    "clear",
    present(
      EraserIcon,
      msg("Clearing the context"),
      msg("Cleared the context"),
      msg("Couldn't clear the context"),
    ),
  ],
  ["goal", present(TargetIcon, msg("Setting the goal"), msg("Goal set", { $context: "slash command row" }), msg("Couldn't set the goal"))],
  ["feedback", present(SendIcon, msg("Sending feedback"), msg("Sent feedback"), msg("Couldn't send feedback"))],
  [
    "init",
    present(
      FilePlusIcon,
      msg("Writing instructions"),
      msg("Wrote instructions"),
      msg("Couldn't write instructions"),
    ),
  ],
  ["review", present(ScanSearchIcon, msg("Reviewing", { $context: "slash command row, a review is running" }), msg("Review", { $context: "slash command row, a finished review" }), msg("Couldn't review", { $context: "slash command row, a review failed" }))],
  ["code-review", present(ScanSearchIcon, msg("Reviewing code"), msg("Code review", { $context: "slash command row, a finished code review" }), msg("Couldn't review", { $context: "slash command row, a review failed" }))],
  [
    "security-review",
    present(ShieldCheckIcon, msg("Reviewing security"), msg("Security review", { $context: "slash command row, a finished security review" }), msg("Couldn't review", { $context: "slash command row, a review failed" })),
  ],
  ["context", present(GaugeIcon, msg("Checking context"), msg("Context", { $context: "slash command row, the context window report" }), msg("Couldn't check context"))],
  ["usage", present(ChartColumnIcon, msg("Checking usage"), msg("Usage", { $context: "slash command row, the usage report" }), msg("Couldn't check usage"))],
  ["mcp", present(PlugIcon, msg("Checking MCP servers"), msg("MCP servers", { $context: "slash command row, the MCP server report" }), msg("Couldn't check MCP servers"))],
]);

/** `/goal` with one of these words controls the goal instead of setting it. */
const GOAL_CONTROLS = new Map<string, Presentation>([
  ["", present(TargetIcon, msg("Checking the goal"), msg("Checked the goal"), msg("Couldn't check the goal"))],
  ["pause", present(CirclePauseIcon, msg("Pausing the goal"), msg("Goal paused"), msg("Couldn't pause the goal"))],
  ["resume", present(TargetIcon, msg("Resuming the goal"), msg("Goal resumed"), msg("Couldn't resume the goal"))],
  ["clear", present(TargetIcon, msg("Clearing the goal"), msg("Goal cleared"), msg("Couldn't clear the goal"))],
]);

const SKILL = present(BoxIcon, msg("Using skill", { $context: "slash command row, a skill is running" }), msg("Used skill", { $context: "slash command row, a skill finished" }), msg("Couldn't use skill"));
const FALLBACK = present(TerminalIcon, msg("Running", { $context: "slash command row, a command is running" }), msg("Ran", { $context: "slash command row, a command finished" }), msg("Couldn't run", { $context: "slash command row, a command failed" }));

// The name stops at `/`, so a path such as `/usr/bin/foo` never matches.
const COMMAND_MESSAGE = /^([/$])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/;

/**
 * A message is a command only when its name is one this file presents or one
 * the catalog lists; `$` opens skills alone, as the composer inserts them.
 */
export function parseSlashCommandMessage(
  text: string,
  catalog: SlashCommandCatalog,
): SlashCommandMessage | null {
  const match = COMMAND_MESSAGE.exec(text.trim());
  if (!match) return null;
  const sigil = match[1] === "$" ? "$" : "/";
  const name = match[2] ?? "";
  const builtin = sigil === "/" && COMMANDS.has(name);
  const skill = !builtin && catalog.skills.some((entry) => entry.name === name);
  const listed = sigil === "/" && catalog.commands.some((entry) => entry.name === name);
  if (!builtin && !skill && !listed) return null;
  const args = (match[3] ?? "").trim();
  return { sigil, name, args, skill, standalone: !/\s/.test(args) };
}

/** The row's icon, verb and target. `result` is what the provider reported, such as token counts. */
export function presentSlashCommand(
  command: Pick<SlashCommandMessage, "name" | "args" | "skill">,
  state: SlashCommandState,
  result: string | null,
  resolve: MessageResolver = m,
): { icon: LucideIcon; verb: string; target: string | null } {
  const control =
    !command.skill && command.name === "goal" ? GOAL_CONTROLS.get(command.args) : undefined;
  const presentation = command.skill ? SKILL : (control ?? COMMANDS.get(command.name) ?? FALLBACK);
  return {
    icon: presentation.icon,
    verb: resolve(
      state === "stopped"
        ? msg("Stopped", { $context: "slash command row, the user stopped the command" })
        : presentation[state === "done" ? "done" : state],
    ),
    target: result ?? (control || !command.args ? null : command.args),
  };
}
