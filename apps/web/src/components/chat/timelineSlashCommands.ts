import {
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
  SparklesIcon,
  TargetIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";

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
    present(Minimize2Icon, "Compacting the conversation", "Compacted", "Couldn't compact"),
  ],
  [
    "clear",
    present(
      EraserIcon,
      "Clearing the context",
      "Cleared the context",
      "Couldn't clear the context",
    ),
  ],
  ["goal", present(TargetIcon, "Setting the goal", "Goal set", "Couldn't set the goal")],
  ["feedback", present(SendIcon, "Sending feedback", "Sent feedback", "Couldn't send feedback")],
  [
    "init",
    present(
      FilePlusIcon,
      "Writing instructions",
      "Wrote instructions",
      "Couldn't write instructions",
    ),
  ],
  ["review", present(ScanSearchIcon, "Reviewing", "Review", "Couldn't review")],
  ["code-review", present(ScanSearchIcon, "Reviewing code", "Code review", "Couldn't review")],
  [
    "security-review",
    present(ShieldCheckIcon, "Reviewing security", "Security review", "Couldn't review"),
  ],
  ["context", present(GaugeIcon, "Checking context", "Context", "Couldn't check context")],
  ["usage", present(ChartColumnIcon, "Checking usage", "Usage", "Couldn't check usage")],
  ["mcp", present(PlugIcon, "Checking MCP servers", "MCP servers", "Couldn't check MCP servers")],
]);

/** `/goal` with one of these words controls the goal instead of setting it. */
const GOAL_CONTROLS = new Map<string, Presentation>([
  ["", present(TargetIcon, "Checking the goal", "Checked the goal", "Couldn't check the goal")],
  ["pause", present(CirclePauseIcon, "Pausing the goal", "Goal paused", "Couldn't pause the goal")],
  ["resume", present(TargetIcon, "Resuming the goal", "Goal resumed", "Couldn't resume the goal")],
  ["clear", present(TargetIcon, "Clearing the goal", "Goal cleared", "Couldn't clear the goal")],
]);

const SKILL = present(SparklesIcon, "Using skill", "Used skill", "Couldn't use skill");
const FALLBACK = present(TerminalIcon, "Running", "Ran", "Couldn't run");

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
): { icon: LucideIcon; verb: string; target: string | null } {
  const control =
    !command.skill && command.name === "goal" ? GOAL_CONTROLS.get(command.args) : undefined;
  const presentation = command.skill ? SKILL : (control ?? COMMANDS.get(command.name) ?? FALLBACK);
  return {
    icon: presentation.icon,
    verb: state === "stopped" ? "Stopped" : presentation[state === "done" ? "done" : state],
    target: result ?? (control || !command.args ? null : command.args),
  };
}
