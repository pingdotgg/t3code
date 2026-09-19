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
  en: ["um", "ah", "eh", "ha"],
  de: ["äh", "ähm"],
  fr: ["euh"],
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function removeSpeechFillerWords(text: string, language?: string): string {
  const baseLanguage = language?.split(/[-_]/, 1)[0]?.toLowerCase();
  const words = [
    ...UNIVERSAL_FILLER_WORDS,
    ...(baseLanguage ? (LANGUAGE_FILLER_WORDS[baseLanguage] ?? []) : []),
  ];
  let filtered = text;
  for (const word of words) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegex(word)}(?![\\p{L}\\p{N}_])[,.]?`,
      "giu",
    );
    filtered = filtered.replace(pattern, "");
  }
  return filtered.replace(/\s{2,}/g, " ").trim();
}
