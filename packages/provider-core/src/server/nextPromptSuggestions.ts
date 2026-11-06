// Custom build: next-prompt suggestion buttons. Kept in one file so rebases touch little else.
import * as Schema from "effect/Schema";

import type { ModelSelection } from "@t3tools/contracts";

import { limitSection } from "./textGenerationUtils.ts";

export type NextPromptSuggestionKind = "prompt" | "skill" | "command";

export interface NextPromptCommand {
  readonly name: string;
  readonly description?: string | undefined;
  readonly kind: "skill" | "command";
}

export interface NextPromptSuggestionsInput {
  readonly cwd: string;
  /** The person's latest message. */
  readonly userMessage: string;
  /** The agent's reply to it. */
  readonly assistantReply: string;
  /** Skills and slash commands the person could invoke in this thread. */
  readonly commands: ReadonlyArray<NextPromptCommand>;
  readonly modelSelection: ModelSelection;
}

export interface NextPromptSuggestion {
  readonly text: string;
  readonly kind: NextPromptSuggestionKind;
}

export interface NextPromptSuggestionsResult {
  readonly suggestions: ReadonlyArray<NextPromptSuggestion>;
}

export const MAX_NEXT_PROMPT_SUGGESTIONS = 4;
const USER_MESSAGE_LIMIT = 2_000;
// The end of a reply holds its recommendations and questions, so keep the tail.
const REPLY_TAIL_LIMIT = 6_000;
const MAX_COMMANDS = 120;
const COMMAND_DESCRIPTION_LIMIT = 160;
const SUGGESTION_TEXT_LIMIT = 200;

const NEXT_PROMPT_SUGGESTIONS_PROMPT = [
  "You suggest what the person might type next in a chat with a coding agent.",
  "Read their last message and the agent's reply, then propose 2 to 4 short, distinct next messages written in the person's voice, as they would type them.",
  "Good suggestions answer a question the agent asked, pick one of the options it offered, approve or decline what it proposed, or ask for the obvious next step.",
  'When one of the listed skills or slash commands clearly fits the next step, include it as a suggestion with kind "skill" or "command" and text set to its exact name without a leading slash. Never invent a name that is not listed.',
  'Plain suggestions use kind "prompt": at most 12 words, no quotes, no trailing period.',
  "Return an empty list when the reply needs no follow-up.",
].join("\n");

const tail = (text: string, limit: number) =>
  text.length <= limit ? text : `…${text.slice(text.length - limit)}`;

export function buildNextPromptSuggestionsPrompt(input: NextPromptSuggestionsInput) {
  const commands = input.commands
    .slice(0, MAX_COMMANDS)
    .map((command) => {
      const description = command.description?.trim();
      return `- ${command.kind} ${command.name}${
        description ? `: ${limitSection(description, COMMAND_DESCRIPTION_LIMIT)}` : ""
      }`;
    })
    .join("\n");

  const prompt = [
    NEXT_PROMPT_SUGGESTIONS_PROMPT,
    "",
    "Available skills and slash commands:",
    commands.length > 0 ? commands : "(none)",
    "",
    "The person's last message:",
    limitSection(input.userMessage.trim(), USER_MESSAGE_LIMIT),
    "",
    "The agent's reply:",
    tail(input.assistantReply.trim(), REPLY_TAIL_LIMIT),
  ].join("\n");

  const outputSchema = Schema.Struct({
    suggestions: Schema.Array(
      Schema.Struct({
        text: Schema.String,
        kind: Schema.Literals(["prompt", "skill", "command"]),
      }),
    ),
  });

  return { prompt, outputSchema };
}

// A fenced block whose info string is `options`, one next message per line.
const OPTIONS_BLOCK =
  /(?:^|\n)[ \t]*(`{3,}|~{3,})options[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/g;

/**
 * The options a reply lists for the person's next message, one per line of its last `options`
 * block, or null when it has none. A line naming an offered skill (`$name`) or slash command
 * (`/name`) becomes that skill or command; anything else is sent as written.
 */
export function parseReplyOptions(
  reply: string,
  commands: ReadonlyArray<NextPromptCommand>,
): ReadonlyArray<NextPromptSuggestion> | null {
  let body: string | undefined;
  for (const match of reply.matchAll(OPTIONS_BLOCK)) body = match[2];
  if (body === undefined) return null;
  const offered = new Map(commands.map((command) => [command.name.toLowerCase(), command]));
  const options: Array<NextPromptSuggestion> = [];
  const seen = new Set<string>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .trim();
    if (line.length === 0 || line.length > SUGGESTION_TEXT_LIMIT) continue;
    const prefix = line[0];
    const command =
      prefix === "/" || prefix === "$"
        ? offered.get(line.slice(1).split(/\s/, 1)[0]!.toLowerCase())
        : undefined;
    const option: NextPromptSuggestion =
      command !== undefined && line.slice(1).trim().toLowerCase() === command.name.toLowerCase()
        ? { text: command.name, kind: command.kind }
        : { text: line, kind: "prompt" };
    const key = `${option.kind}:${option.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
    if (options.length === MAX_NEXT_PROMPT_SUGGESTIONS) break;
  }
  return options.length > 0 ? options : null;
}

/** Trim, drop duplicates and names that are not offered, and cap the count. */
export function sanitizeNextPromptSuggestions(
  suggestions: ReadonlyArray<NextPromptSuggestion>,
  commands: ReadonlyArray<NextPromptCommand>,
): ReadonlyArray<NextPromptSuggestion> {
  const offered = new Map(commands.map((command) => [command.name.toLowerCase(), command]));
  const seen = new Set<string>();
  const result: Array<NextPromptSuggestion> = [];
  for (const suggestion of suggestions) {
    let text = suggestion.text.trim().replace(/^["'“]+|["'”]+$/g, "");
    let kind = suggestion.kind;
    if (kind !== "prompt") {
      const command = offered.get(text.replace(/^[/$]/, "").toLowerCase());
      if (command === undefined) continue;
      text = command.name;
      kind = command.kind;
    }
    if (text.length === 0 || text.length > SUGGESTION_TEXT_LIMIT) continue;
    const key = `${kind}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ text, kind });
    if (result.length === MAX_NEXT_PROMPT_SUGGESTIONS) break;
  }
  return result;
}
