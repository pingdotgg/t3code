/**
 * `/improve`: the instructions the improving model gets, and the first message the new thread
 * receives. Pure so both the server and tests use the same text.
 */

export interface ImproveConversationMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ImproveContext {
  readonly draft: string;
  readonly threadTitle: string;
  readonly projectName: string | null;
  readonly workingDirectory: string | null;
  readonly branch: string | null;
  readonly messages: ReadonlyArray<ImproveConversationMessage>;
  readonly destinationLabel: string;
}

const MESSAGE_CHARS = 1_800;
const CONVERSATION_CHARS = 14_000;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** The newest messages that fit, oldest first, each clipped. */
export function recentConversation(
  messages: ReadonlyArray<ImproveConversationMessage>,
  budget = CONVERSATION_CHARS,
): ReadonlyArray<ImproveConversationMessage> {
  const kept: ImproveConversationMessage[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    if (message.text.trim() === "") continue;
    const text = clip(message.text, MESSAGE_CHARS);
    if (used + text.length > budget && kept.length > 0) break;
    kept.unshift({ role: message.role, text });
    used += text.length;
  }
  return kept;
}

export function buildImproveRequest(context: ImproveContext): string {
  const conversation = recentConversation(context.messages)
    .map((message) => `${message.role === "user" ? "USER" : "AGENT"}: ${message.text}`)
    .join("\n\n");
  return [
    "Rewrite the user's draft into a stronger prompt for a coding agent. Another agent will receive it as the first message of a new session that does not have this conversation.",
    "",
    "Rules:",
    "- Preserve the user's intent, every explicit constraint, and every decision already made in the conversation. Do not add new requirements or change scope.",
    "- Make it self-contained: name the files, components, errors, and decisions from the conversation that the task depends on.",
    "- State what done looks like and how to verify it, when the conversation or draft implies it.",
    "- Keep the user's voice and language. Keep it as short as it can be while complete. No preamble, no headings unless the draft has structure.",
    "- Never include secrets, tokens, or credentials even if they appear in the conversation.",
    "- Output only the rewritten prompt in the `transcription` field. Do not answer or perform the task.",
    "",
    `Receiving agent: ${context.destinationLabel}`,
    `Session title: ${context.threadTitle}`,
    context.projectName ? `Project: ${context.projectName}` : null,
    context.workingDirectory ? `Working directory: ${context.workingDirectory}` : null,
    context.branch ? `Branch: ${context.branch}` : null,
    "",
    "Conversation so far (most recent last):",
    conversation === "" ? "(no earlier messages)" : conversation,
    "",
    "User's draft (rewrite this):",
    "<<<DRAFT",
    context.draft,
    "DRAFT>>>",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Strips wrappers some models add despite instructions. Empty means the rewrite failed. */
export function cleanImprovedPrompt(raw: string): string {
  let text = raw.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/^<<<DRAFT\n?|\n?DRAFT>>>$/g, "").trim();
  text = text.replace(/^(?:here(?:'s| is) (?:the |an |a )?(?:improved|rewritten|stronger) prompt:?\s*)/i, "");
  return text.trim();
}

/** A short digest of the source conversation for the new session. */
export function summarizeForHandoff(
  messages: ReadonlyArray<ImproveConversationMessage>,
  budget = 2_400,
): string {
  const lines = recentConversation(messages, budget).map(
    (message) => `- ${message.role === "user" ? "User" : "Agent"}: ${clip(message.text.replace(/\s+/g, " "), 400)}`,
  );
  return lines.join("\n");
}

export function buildHandoffMessage(input: {
  readonly improvedPrompt: string;
  readonly originalPrompt: string;
  readonly summary: string;
  readonly sourceTitle: string;
}): string {
  const sections = [input.improvedPrompt.trim()];
  const context = [
    `Context carried over from the session "${input.sourceTitle}" (same project and working directory):`,
    input.summary.trim() === "" ? "- (no earlier messages)" : input.summary.trim(),
    "",
    "The user's original wording, for reference:",
    input.originalPrompt
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  ].join("\n");
  sections.push(`---\n${context}`);
  return sections.join("\n\n");
}
