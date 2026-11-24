const UNIVERSAL_FILLER_WORDS = [
  "uh",
  "uhm",
  "umm",
  "uhh",
  "uhhh",
  "ehh",
  "ehm",
  "ahm",
  "hmm",
  "hm",
  "mmm",
  "хм",
  "ммм",
] as const;

const LANGUAGE_FILLER_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ["um", "ah", "eh"],
  de: ["äh", "ähm"],
  fr: ["euh"],
  pt: ["ah", "ahn", "ãh", "hã", "hum", "éh"],
};

// Hesitation sounds that are also real words. Portuguese speakers hesitate with "é", which is also
// the verb "is", so it is only dropped as a comma-delimited aside at the start of a clause
// ("É, acrescenta" at a sentence start, also on a new line, "tivesse, é, é ansioso"), never after a word, even across a line break ("a regra é, ele...").
const LANGUAGE_FILLER_PATTERNS: Readonly<Record<string, readonly string[]>> = {
  pt: ["(?<=(?:^|[,.!?…])\\s*)é,"],
};

// Marks where a capitalized filler was removed; never present in transcripts.
const SENTENCE_START = "\u0000";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function removeSpeechFillerWords(
  text: string,
  language?: string,
  correctionCue?: string,
): string {
  const baseLanguage = language?.split(/[-_]/, 1)[0]?.toLowerCase();
  const words = [
    ...UNIVERSAL_FILLER_WORDS,
    ...(baseLanguage ? (LANGUAGE_FILLER_WORDS[baseLanguage] ?? []) : []),
  ];
  const patterns = baseLanguage ? (LANGUAGE_FILLER_PATTERNS[baseLanguage] ?? []) : [];
  const cuePattern = correctionCue?.trim().split(/\s+/).map(escapeRegex).join("\\s+");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:(${cuePattern || "(?!)"})(?![\\p{L}\\p{N}_])|(?:${words.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}_])[,.]?${patterns.map((source) => `|${source}`).join("")})`,
    "giu",
  );
  // A capitalized filler opened the sentence, so the word after it takes over the capital
  // ("Uma frase. É, enquanto" becomes "Uma frase. Enquanto"). The correction cue keeps its case.
  const startsWithCue = cuePattern
    ? new RegExp(`^(?:${cuePattern})(?![\\p{L}\\p{N}_])`, "iu")
    : undefined;
  const filtered = text
    .replace(pattern, (match: string, cue: string | undefined) =>
      cue !== undefined ? cue : /^\p{Lu}/u.test(match) ? SENTENCE_START : "",
    )
    .replace(
      new RegExp(`${SENTENCE_START}([^\\S\\r\\n]*)(\\p{Ll})`, "gu"),
      (_match, space: string, letter: string, offset: number, whole: string) =>
        startsWithCue?.test(whole.slice(offset + SENTENCE_START.length + space.length))
          ? space + letter
          : space + letter.toUpperCase(),
    )
    .replaceAll(SENTENCE_START, "");
  return filtered
    .replace(/[^\S\r\n]{2,}/g, " ")
    .replace(/[^\S\r\n]*([\r\n])[^\S\r\n]*/g, "$1")
    .trim();
}
