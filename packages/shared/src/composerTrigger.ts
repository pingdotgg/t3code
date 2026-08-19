export type ComposerTriggerKind = "path" | "slash-command" | "slash-model" | "skill";
export type ComposerSlashCommand =
  | "model"
  | "plan"
  | "default"
  | "goal"
  | "goal pause"
  | "goal resume"
  | "goal clear";

export type GoalChipAction = "pause" | "resume" | "clear";

export const GOAL_PAUSE_HINT =
  "Pause prevents the next Continuation. Stop interrupts this Turn and also Pauses.";

export const BUILT_IN_GOAL_SLASH_COMMANDS = [
  {
    command: "goal",
    label: "/goal",
    description: "Set an Objective this Thread keeps working toward",
  },
  {
    command: "goal pause",
    label: "/goal pause",
    description: "Pause — prevent the next Continuation",
  },
  {
    command: "goal resume",
    label: "/goal resume",
    description: "Resume a Paused, Blocked, or Usage-limited Goal",
  },
  {
    command: "goal clear",
    label: "/goal clear",
    description: "Clear the Goal from this Thread",
  },
] as const satisfies ReadonlyArray<{
  readonly command: ComposerSlashCommand;
  readonly label: string;
  readonly description: string;
}>;

export const GOAL_OBJECTIVE_PREVIEW_MAX_CHARS = 80;

const GOAL_COMMAND_TOKEN = /^\/goal(?:\/\S*)?$/i;
const SLASH_GOAL_PHRASE = /^slash\s+goal\b/i;
const GOAL_SLASH_LINE = /^\/goal(?:\s+([\s\S]*))?$/i;

export type ParsedGoalComposerCommand =
  | { readonly action: "status" }
  | { readonly action: "pause" }
  | { readonly action: "resume" }
  | { readonly action: "clear" }
  | { readonly action: "set"; readonly objective: string }
  | { readonly action: "refuse" };

export function isGoalCommandForm(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (SLASH_GOAL_PHRASE.test(trimmed)) {
    return true;
  }
  const firstToken = trimmed.split(/\s+/u, 1)[0] ?? "";
  return GOAL_COMMAND_TOKEN.test(firstToken);
}

export function parseGoalComposerCommand(text: string): ParsedGoalComposerCommand | null {
  const trimmed = text.trim();
  if (!isGoalCommandForm(trimmed)) {
    return null;
  }
  const slashMatch = GOAL_SLASH_LINE.exec(trimmed);
  if (slashMatch === null) {
    return { action: "refuse" };
  }
  const rest = (slashMatch[1] ?? "").trim();
  if (rest.length === 0) {
    return { action: "status" };
  }
  const restLower = rest.toLowerCase();
  if (restLower === "pause") {
    return { action: "pause" };
  }
  if (restLower === "resume") {
    return { action: "resume" };
  }
  if (restLower === "clear") {
    return { action: "clear" };
  }
  return { action: "set", objective: rest };
}

export function formatGoalStatusLabel(status: string): string {
  if (status === "usageLimited") {
    return "Usage-limited";
  }
  if (status.length === 0) {
    return status;
  }
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

export function formatGoalStatusMessage(
  goal: { readonly status: string; readonly objective: string } | null | undefined,
): string {
  if (goal == null) {
    return "No Objective on this Thread. Type /goal followed by the outcome to set one.";
  }
  return `${formatGoalStatusLabel(goal.status)}: ${goal.objective}`;
}

/** Chip prefix: bare "Goal" while Active, otherwise carries the status. */
export function formatGoalChipPrefix(status: string): string {
  if (status === "active") {
    return "Goal";
  }
  return `Goal ${formatGoalStatusLabel(status).toLowerCase()}`;
}

/** Accessible label for the composer Goal chip. Matches the visible text. */
export function formatGoalChipAriaLabel(
  goal: { readonly status: string; readonly objective: string },
  options?: { readonly isWorking?: boolean },
): string {
  const isWorking = options?.isWorking === true && goal.status === "active";
  const label = `${formatGoalChipPrefix(goal.status)}: ${goal.objective}`;
  return isWorking ? `${label} (Running)` : label;
}

// User-facing actions: pause/resume/clear only. Complete belongs to the model
// (structured <objective_complete> signal), never to chip or palette chrome.
export function goalChipActions(status: string): ReadonlyArray<GoalChipAction> {
  const actions: GoalChipAction[] = [];
  if (status === "active") {
    actions.push("pause");
  }
  if (status === "paused" || status === "blocked" || status === "usageLimited") {
    actions.push("resume");
  }
  actions.push("clear");
  return actions;
}

export function goalChipActionLabel(action: GoalChipAction): string {
  switch (action) {
    case "pause":
      return "Pause";
    case "resume":
      return "Resume";
    case "clear":
      return "Delete";
  }
}

export function threadHasActiveGoal(goal: { readonly status: string } | null | undefined): boolean {
  return goal?.status === "active";
}

export function formatGoalActivityLabel(kind: string): string | null {
  switch (kind) {
    case "goal.set":
      return "Objective set";
    case "goal.continued":
      return "Continued";
    case "goal.paused":
      return "Paused";
    case "goal.resumed":
      return "Resumed";
    case "goal.cleared":
      return "Cleared";
    case "goal.completed":
      return "Complete";
    case "goal.blocked":
      return "Blocked";
    case "goal.usage-limited":
      return "Usage-limited";
    default:
      return null;
  }
}

export function isBuiltInGoalSlashCommand(command: string): boolean {
  return command === "goal" || command.startsWith("goal ");
}

export function composerTextForGoalSlashCommand(command: string): string {
  return command === "goal" ? "/goal " : `/${command}`;
}

export function truncateGoalObjectivePreview(objective: string): string {
  if (objective.length <= GOAL_OBJECTIVE_PREVIEW_MAX_CHARS) {
    return objective;
  }
  return `${objective.slice(0, GOAL_OBJECTIVE_PREVIEW_MAX_CHARS - 1)}…`;
}

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"\\]+$/;

export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/**
 * Detect an active trigger (@path, $skill, /command) at the cursor position.
 *
 * Accepts an optional `isWhitespaceChar` override so callers with inline
 * placeholder characters (e.g. terminal context chips on web) can treat
 * those as token boundaries.
 */
export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function parseStandaloneComposerSlashCommand(text: string): "plan" | "default" | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  return "default";
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
