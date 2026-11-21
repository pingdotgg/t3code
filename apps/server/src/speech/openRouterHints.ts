// OpenRouter forwards only the matched provider's options entry, so every
// supported field can travel together. Providers missing here drop the hints.
const PROMPT_LIMIT = 800;
const PROMPT_PREFIX = "Expected vocabulary: ";
/** Azure rejects multilingual phrase lists over 3,200 characters in total. */
const AZURE_PHRASE_LIMIT = 3_200;

/** Keeps whole words and stops before the provider's character budget. */
function limitWords(words: readonly string[], maxCharacters: number, separator = 1) {
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = length + word.length + (kept.length > 0 ? separator : 0);
    if (next > maxCharacters) break;
    kept.push(word);
    length = next;
  }
  return kept;
}

/** Whisper's prompt limit is about 224 tokens; keep the vocabulary well inside it. */
function promptWords(words: readonly string[]) {
  return limitWords(words, PROMPT_LIMIT - PROMPT_PREFIX.length, 2);
}

const OPENROUTER_HINT_FIELDS: Record<
  string,
  (words: readonly string[]) => Record<string, unknown>
> = {
  azure: (words) => ({ phraseList: { phrases: limitWords(words, AZURE_PHRASE_LIMIT) } }),
  "google-vertex": (words) => ({ custom_vocabulary: words }),
  assemblyai: (words) => ({ keyterms_prompt: words }),
  openai: (words) => ({ prompt: PROMPT_PREFIX + promptWords(words).join(", ") }),
  groq: (words) => ({ prompt: PROMPT_PREFIX + promptWords(words).join(", ") }),
  together: (words) => ({ prompt: PROMPT_PREFIX + promptWords(words).join(", ") }),
};

/** `undefined` when there is nothing to hint, so the request keeps its old shape. */
export function openRouterHintOptions(words: readonly string[]) {
  if (words.length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(OPENROUTER_HINT_FIELDS).map(([provider, fields]) => [provider, fields(words)]),
  );
}
