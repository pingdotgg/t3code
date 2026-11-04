import { rankModelPickerSearch, type ModelPickerSearchableModel } from "./modelSearch.ts";

const COMPOSER_MODEL_MENTION_LIMIT = 8;

/** Mentions can't contain spaces, so `:`, `/` and `-` split words, as in `@gpt:traex`. */
function mentionSearchQueries(query: string): ReadonlyArray<string> {
  const spaced = query.replace(/[:/]+/gu, " ").trim();
  const unhyphenated = spaced.replace(/-+/gu, " ").trim();
  if (unhyphenated.length === 0) return [];
  return unhyphenated === spaced ? [spaced] : [spaced, unhyphenated];
}

/** Returns the models matching an `@` mention, best first. A bare `@` matches none. */
export function rankComposerModelMentions<T>(
  candidates: ReadonlyArray<T>,
  query: string,
  toSearchable: (candidate: T) => ModelPickerSearchableModel,
): T[] {
  for (const words of mentionSearchQueries(query)) {
    // Every word must match literally. Fuzzy model hits would push files out of the `@` menu.
    const tokens = words.toLowerCase().split(/\s+/u);
    const literal = candidates.filter((candidate) => {
      const model = toSearchable(candidate);
      const haystack = [
        model.name,
        model.shortName,
        model.subProvider,
        model.driverKind,
        model.providerDisplayName,
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
    const ranked = rankModelPickerSearch(literal, words, toSearchable);
    if (ranked.length > 0) return ranked.slice(0, COMPOSER_MODEL_MENTION_LIMIT);
  }
  return [];
}

/** Prompt text naming a provider instance and model for the agent. No `@`, which the editor would turn into a file chip. */
export function formatComposerModelMention(instanceId: string, model: string): string {
  return `model:${instanceId}/${model}`;
}

export interface ComposerModelMentionOccurrence {
  readonly instanceId: string;
  readonly model: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

// Instance ids match ProviderInstanceId; model slugs may contain `/`, as in `opencode/anthropic/opus`.
const MODEL_MENTION_PATTERN = /(?<![^\s,(["'])model:([a-zA-Z][a-zA-Z0-9_-]*)\/([^\s,"']+)/gu;
const SENTENCE_PUNCTUATION = ".;:!?";
const CLOSING_BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[" };

function countOf(text: string, char: string): number {
  return text.split(char).length - 1;
}

// Slugs like `foo(bar)` or `GPT-6.1-Sol[1m]` keep balanced brackets; prose wrapping them does not.
function trimModelSlug(slug: string): string {
  let trimmed = slug;
  while (trimmed.length > 0) {
    const last = trimmed.at(-1)!;
    const opening = CLOSING_BRACKETS[last];
    const unbalanced = opening !== undefined && countOf(trimmed, opening) < countOf(trimmed, last);
    if (!SENTENCE_PUNCTUATION.includes(last) && !unbalanced) break;
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/** Finds the `model:<instance>/<model>` references that `formatComposerModelMention` writes. */
export function collectComposerModelMentions(
  text: string,
): ReadonlyArray<ComposerModelMentionOccurrence> {
  if (!text.includes("model:")) return [];
  const occurrences: ComposerModelMentionOccurrence[] = [];
  for (const match of text.matchAll(MODEL_MENTION_PATTERN)) {
    const instanceId = match[1]!;
    const model = trimModelSlug(match[2]!);
    if (model.length === 0) continue;
    const start = match.index;
    const end = start + "model:".length + instanceId.length + 1 + model.length;
    occurrences.push({ instanceId, model, source: text.slice(start, end), start, end });
  }
  return occurrences;
}
