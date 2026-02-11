import type { ChatMessage } from "./types";

export interface BootstrapInputResult {
  text: string;
  includedCount: number;
  omittedCount: number;
  truncated: boolean;
}

const BOOTSTRAP_PREAMBLE =
  "Continue this conversation using the transcript context below. The final section is the latest user request to answer now.";
const TRANSCRIPT_HEADER = "Transcript context:";
const LATEST_PROMPT_HEADER = "Latest user request (answer this now):";
const OMITTED_SUMMARY = (count: number) =>
  `[${count} earlier message(s) omitted to stay within input limits.]`;

function messageRoleLabel(message: ChatMessage): "USER" | "ASSISTANT" {
  return message.role === "assistant" ? "ASSISTANT" : "USER";
}

function buildMessageBlock(message: ChatMessage): string {
  return `${messageRoleLabel(message)}:\n${message.text}`;
}

function finalizeWithPrompt(
  transcriptBody: string,
  latestPrompt: string,
  maxChars: number,
): string | null {
  const text = `${BOOTSTRAP_PREAMBLE}\n\n${TRANSCRIPT_HEADER}\n${transcriptBody}\n\n${LATEST_PROMPT_HEADER}\n${latestPrompt}`;
  return text.length <= maxChars ? text : null;
}

export function buildBootstrapInput(
  previousMessages: ChatMessage[],
  latestPrompt: string,
  maxChars: number,
): BootstrapInputResult {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const promptOnly = latestPrompt.length <= budget ? latestPrompt : latestPrompt.slice(0, budget);

  if (previousMessages.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: 0,
      truncated: promptOnly.length !== latestPrompt.length,
    };
  }

  const newestFirstBlocks: string[] = [];
  for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
    const message = previousMessages[index];
    if (!message) continue;
    newestFirstBlocks.push(buildMessageBlock(message));
  }

  if (newestFirstBlocks.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: previousMessages.length,
      truncated: true,
    };
  }

  // Include a contiguous suffix from newest to oldest, then reverse to chronological.
  let includedNewestFirst: string[] = [];
  for (const block of newestFirstBlocks) {
    const nextNewestFirst = [...includedNewestFirst, block];
    const nextChronological = [...nextNewestFirst].reverse();
    const omittedCount = newestFirstBlocks.length - nextChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? `${OMITTED_SUMMARY(omittedCount)}\n\n${nextChronological.join("\n\n")}`
        : nextChronological.join("\n\n");
    if (!finalizeWithPrompt(transcriptBody, latestPrompt, budget)) {
      break;
    }
    includedNewestFirst = nextNewestFirst;
  }

  let includedChronological = [...includedNewestFirst].reverse();
  while (true) {
    const omittedCount = newestFirstBlocks.length - includedChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? includedChronological.length > 0
          ? `${OMITTED_SUMMARY(omittedCount)}\n\n${includedChronological.join("\n\n")}`
          : OMITTED_SUMMARY(omittedCount)
        : includedChronological.join("\n\n");
    const finalized = finalizeWithPrompt(transcriptBody, latestPrompt, budget);
    if (finalized) {
      return {
        text: finalized,
        includedCount: includedChronological.length,
        omittedCount,
        truncated: omittedCount > 0 || latestPrompt.length !== promptOnly.length,
      };
    }

    if (includedChronological.length === 0) {
      return {
        text: promptOnly,
        includedCount: 0,
        omittedCount: previousMessages.length,
        truncated: true,
      };
    }

    includedChronological = includedChronological.slice(1);
  }
}
