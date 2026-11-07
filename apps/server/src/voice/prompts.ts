import type { FrontDecision, FrontMessage } from "./FrontModel.ts";

const HISTORY_LIMIT = 40;
const HISTORY_KEEP = 20;
/** Relayed agent output is capped near 500 tokens, at about four characters a token. */
const RESULT_MAX_CHARS = 2000;

export const FRONT_SYSTEM_PROMPT = `You are the voice in a live voice call about one coding thread. A coding agent does the real work in that thread; you talk with the user and hand work to the agent.

Answer with JSON: {"action", "speech", "task"}.
- "reply": small talk, a clarifying question, or something you can answer from this call. "speech" is your answer.
- "delegate": the user wants work done, or facts about the code, project, or files. "task" restates the request for the agent in one or two plain sentences. "speech" is a short acknowledgement such as "On it."
- "note": the user adds something the agent should know but asks for nothing new. "task" is the note. "speech" is a brief acknowledgement or empty.
- "none": noise, a false start, or nothing worth answering. "speech" is empty.

"speech" is read aloud: plain words, no markdown, code, lists, or links, and at most two sentences. The user's words come from speech recognition, so they may lack final punctuation or contain misheard words; read them generously.

A message that starts with "[Agent" reports the agent's work. Answer it with "reply": what the user needs to know in at most two sentences, then a short question if one helps. Never delegate or note in answer to the agent; wait for the user to ask.`;

export type FrontInput =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "result"; readonly status: string; readonly text: string };

export function capResult(text: string) {
  const trimmed = text.trim();
  if (trimmed.length <= RESULT_MAX_CHARS) return trimmed;
  const cut = trimmed.lastIndexOf(" ", RESULT_MAX_CHARS);
  return `${trimmed.slice(0, cut > RESULT_MAX_CHARS / 2 ? cut : RESULT_MAX_CHARS)} [truncated]`;
}

function inputMessage(input: FrontInput): FrontMessage {
  if (input.type === "user") return { role: "user", content: input.text };
  const heading =
    input.status === "completed" ? "[Agent finished]" : `[Agent stopped: ${input.status}]`;
  const body = capResult(input.text);
  return { role: "user", content: body ? `${heading}\n${body}` : heading };
}

/** Adjacent user words are one turn: a sentence cut off mid-way goes to the front whole. */
function mergeInputs(inputs: readonly FrontInput[]): FrontMessage[] {
  const messages: FrontMessage[] = [];
  for (const input of inputs) {
    const message = inputMessage(input);
    const previous = messages.at(-1);
    const joinable = input.type === "user" && previous && !previous.content.startsWith("[Agent");
    if (joinable)
      messages[messages.length - 1] = {
        role: "user",
        content: `${previous.content} ${message.content}`,
      };
    else messages.push(message);
  }
  return messages;
}

/**
 * The conversation the front sees. The system prompt and older turns never change between
 * calls, so the model reuses its cache; history is cut from 40 messages to 20 only once a
 * turn is over.
 */
export function makeFrontHistory() {
  let turns: FrontMessage[] = [];
  return {
    messages: (pending: readonly FrontInput[]): FrontMessage[] => [
      { role: "system", content: FRONT_SYSTEM_PROMPT },
      ...turns,
      ...mergeInputs(pending),
    ],
    commit(inputs: readonly FrontInput[], decision: FrontDecision) {
      turns.push(...mergeInputs(inputs), {
        role: "assistant",
        content: JSON.stringify(decision),
      });
      if (turns.length > HISTORY_LIMIT) {
        turns = turns.slice(-HISTORY_KEEP);
        // History restarts on a user message, as chat templates expect.
        while (turns[0] && turns[0].role !== "user") turns.shift();
      }
    },
    get length() {
      return turns.length;
    },
  };
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/** At most two sentences, plus a third only when it is a question. */
export function limitSpeech(text: string) {
  const sentences = [...sentenceSegmenter.segment(text.trim())]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
  const kept = sentences.slice(0, 2);
  const third = sentences[2];
  if (third?.endsWith("?")) kept.push(third);
  return kept.join(" ");
}

/** What the agent receives: the user's own words first, then the front's reading. */
export function delegationText(input: {
  readonly words: string;
  readonly task: string | undefined;
  readonly notes: readonly string[];
}) {
  const parts = [input.words.trim()];
  const task = input.task?.trim();
  if (task && task !== parts[0]) parts.push(`Voice assistant's reading: ${task}`);
  if (input.notes.length > 0)
    parts.push(`Notes from the voice call:\n${input.notes.map((note) => `- ${note}`).join("\n")}`);
  return parts.join("\n\n");
}

export function noteText(note: string) {
  return `Note from the voice call: ${note}`;
}
