import * as Schema from "effect/Schema";

export interface ThreadSubtitlePromptInput {
  readonly missionTitle: string;
  readonly context: string;
  readonly phase: "working" | "completed";
}

const THREAD_SUBTITLE_PROMPT = `Generate the live subtitle for a 2code coding-agent thread.
Return JSON with exactly one key: subtitle.

The title is the durable mission. The subtitle is the changing, glanceable answer to "what is happening right now?" It appears directly below the title in dense sidebars and session grids.

Rules:
- 3-10 words and at most 72 characters.
- Describe the newest concrete step or state, not the overall mission.
- Prefer an active phrase while work is running: "wiring subtitle persistence", "running focused sidebar tests".
- For completed work, state the newest useful outcome or handoff: "subtitle generation integrated and verified", "waiting for database choice".
- Weight the newest context most heavily.
- Do not repeat or lightly paraphrase the mission title.
- Do not mention the agent, user, conversation, or that this is a subtitle.
- No quotes, label prefixes, markdown, or trailing punctuation.
- If context is thin, remain factual and concise rather than inventing progress.`;

export function buildThreadSubtitlePrompt(input: ThreadSubtitlePromptInput) {
  const prompt = `${THREAD_SUBTITLE_PROMPT}

Mission title: ${JSON.stringify(input.missionTitle)}
Phase: ${input.phase === "working" ? "work is running" : "the latest turn finished"}

Recent context (oldest first, newest last):
${input.context.slice(-8_000)}`;
  const outputSchema = Schema.Struct({ subtitle: Schema.String });
  return { prompt, outputSchema };
}

export function sanitizeThreadSubtitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^(?:subtitle|status)\s*:\s*/i, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[.!?…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= 72) return normalized;
  return normalized.slice(0, 72).trimEnd();
}
