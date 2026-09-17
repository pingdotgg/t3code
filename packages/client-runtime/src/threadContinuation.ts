export type ThreadContinuationIntent = "handoff" | "second-opinion";

const MAX_REQUEST_CHARS = 12_000;
const MAX_RESPONSE_CHARS = 24_000;
const MAX_TRANSCRIPT_CHARS = 96_000;
const MAX_FILES = 100;
const OMITTED_TRANSCRIPT_NOTICE = "[Earlier messages omitted to fit continuation prompt.]";

export interface ThreadContinuationTranscriptMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

function bounded(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

function boundedTranscript(messages: ReadonlyArray<ThreadContinuationTranscriptMessage>): string {
  const entries = messages.map((message) => {
    const maxChars = message.role === "assistant" ? MAX_RESPONSE_CHARS : MAX_REQUEST_CHARS;
    const text = bounded(message.text, maxChars) || "(empty message)";
    const label =
      message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
    return `${label}:\n${text}`;
  });
  const complete = entries.join("\n\n");
  if (complete.length <= MAX_TRANSCRIPT_CHARS) return complete;

  const retained: Array<string> = [];
  let retainedLength = OMITTED_TRANSCRIPT_NOTICE.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const nextLength = retainedLength + 2 + entry.length;
    if (nextLength > MAX_TRANSCRIPT_CHARS) break;
    retained.unshift(entry);
    retainedLength = nextLength;
  }
  return [OMITTED_TRANSCRIPT_NOTICE, ...retained].join("\n\n");
}

export function buildThreadContinuationPrompt(input: {
  intent: ThreadContinuationIntent;
  sourceThreadTitle: string;
  userRequest: string;
  assistantResponse: string;
  changedFiles?: ReadonlyArray<string>;
}): string {
  const task =
    input.intent === "handoff"
      ? "Continue this work from the current workspace state. Verify what is already complete, then carry the task forward."
      : "Give a second opinion on this completed turn. Review the request, response, and current workspace state independently. Do not modify files. Call out correctness issues, missed requirements, risky assumptions, and the strongest next step.";
  const files = [...new Set(input.changedFiles ?? [])].slice(0, MAX_FILES);

  return [
    task,
    "",
    `Source thread: ${bounded(input.sourceThreadTitle, 240)}`,
    "",
    "Original request:",
    bounded(input.userRequest, MAX_REQUEST_CHARS) || "(not available)",
    "",
    "Previous agent response:",
    bounded(input.assistantResponse, MAX_RESPONSE_CHARS) || "(empty response)",
    ...(files.length > 0
      ? ["", "Files changed in that turn:", ...files.map((file) => `- ${file}`)]
      : []),
  ].join("\n");
}

export function buildWholeThreadContinuationPrompt(input: {
  intent: ThreadContinuationIntent;
  sourceThreadTitle: string;
  messages: ReadonlyArray<ThreadContinuationTranscriptMessage>;
  changedFiles?: ReadonlyArray<string>;
}): string {
  const task =
    input.intent === "handoff"
      ? "Continue this work from the current workspace state. Review the full source thread transcript, verify what is already complete, then carry the task forward."
      : "Give a second opinion on the full source thread and current workspace state. Do not modify files. Call out correctness issues, missed requirements, risky assumptions, and the strongest next step.";
  const transcript = boundedTranscript(input.messages);
  const files = [...new Set(input.changedFiles ?? [])].slice(0, MAX_FILES);

  return [
    task,
    "",
    `Source thread: ${bounded(input.sourceThreadTitle, 240)}`,
    "",
    "Full conversation transcript:",
    transcript || "(no messages)",
    "",
    ...(files.length > 0
      ? ["Files changed across the thread:", ...files.map((file) => `- ${file}`)]
      : []),
  ].join("\n");
}

export function buildThreadContinuationTitle(input: {
  intent: ThreadContinuationIntent;
  sourceThreadTitle: string;
}): string {
  const prefix = input.intent === "handoff" ? "Continue" : "Review";
  const title = input.sourceThreadTitle.trim() || "thread";
  return `${prefix}: ${title}`.slice(0, 200);
}
