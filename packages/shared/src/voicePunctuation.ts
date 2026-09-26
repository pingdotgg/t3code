import type { DictationSettings } from "@t3tools/contracts";

const punctuation: Record<string, string> = {
  "question mark": "?",
  "exclamation mark": "!",
  "exclamation point": "!",
  "full stop": ".",
  period: ".",
  comma: ",",
};

/** Interpret spoken punctuation before inserting speech or requesting cleanup. */
export function formatSpokenPunctuation(text: string): string {
  return text.replace(
    /[.,!?]?[ \t]*(?<![\p{L}\p{N}_./:-])(question mark|exclamation mark|exclamation point|full stop|period(?!\s+of\b)|comma)(?![\p{L}\p{N}_/-]|[.:][\p{L}\p{N}_./:-])[.,!?]?/giu,
    (_match, command: string) => punctuation[command.toLowerCase()] ?? command,
  );
}

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const listNumbers: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

/** Compile personal phrases once, and format only the current dictated insertion. */
export function createDictationFormatter(settings: DictationSettings) {
  const replacements = new Map(
    settings.replacements.map((entry) => [entry.phrase.toLowerCase(), entry.replacement]),
  );
  const phrases = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const pattern = phrases.length
    ? new RegExp(
        `(?<![\\p{L}\\p{N}_])(?:${phrases.map(escapePattern).join("|")})(?![\\p{L}\\p{N}_])`,
        "giu",
      )
    : null;
  return (raw: string) => {
    let text = raw;
    if (settings.removeFillers)
      text = text.replace(/(?<![\p{L}\p{N}_])(?:um+|uh+)(?![\p{L}\p{N}_])[, ]*/giu, "");
    if (settings.spokenCommands) {
      text = formatSpokenPunctuation(text);
      text = text.replace(
        /[ \t]*\b(new paragraph|new line|bullet point|next bullet)\b[.,:]?[ \t]*/giu,
        (_match, command: string) =>
          command.toLowerCase() === "new paragraph"
            ? "\n\n"
            : command.toLowerCase() === "new line"
              ? "\n"
              : "\n- ",
      );
      text = text.replace(
        /[ \t]*\bnumber (one|two|three|four|five|six|seven|eight|nine|ten|[1-9]|10)\b[.:]?[ \t]*/giu,
        (_match, number: string) => `\n${listNumbers[number.toLowerCase()] ?? number}. `,
      );
      // Explicit corrections only: ordinary uses of "actually" and "like" stay intact.
      const parts = text.split(/\s*\bscratch that\b[.,!?]?\s*/giu);
      text = parts.reduce((previous, next, index) => {
        if (index === 0) return next;
        const sentences = [...previous.trimEnd().matchAll(/[.!?]\s+(?=\S)/gu)];
        const boundary = sentences.at(-1);
        const kept = boundary ? previous.slice(0, boundary.index + 1) : "";
        return (kept ? kept + " " : "") + next;
      }, "");
    }
    // Insert saved text last so punctuation commands and fillers inside snippets
    // remain literal. One replacement pass prevents recursive snippet expansion.
    return pattern
      ? text.replace(pattern, (phrase) => replacements.get(phrase.toLowerCase()) ?? phrase)
      : text;
  };
}
