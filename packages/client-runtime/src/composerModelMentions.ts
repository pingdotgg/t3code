import type { ProviderOptionSelection } from "@t3tools/contracts";

import { rankModelPickerSearch, type ModelPickerSearchableModel } from "./modelSearch.ts";

const COMPOSER_MODEL_MENTION_LIMIT = 8;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Mentions can't contain spaces, so `:`, `/` and `-` split words, as in `@gpt:traex`. */
function mentionSearchQueries(query: string): ReadonlyArray<string> {
  const spaced = query.replace(/[:/]+/gu, " ").trim();
  const unhyphenated = spaced.replace(/-+/gu, " ").trim();
  // One letter would fill the menu with models and push files out of it.
  if (unhyphenated.replace(/\s+/gu, "").length < 2) return [];
  return unhyphenated === spaced ? [spaced] : [spaced, unhyphenated];
}

/** Returns the models matching an `@` mention, best first. A bare `@` matches none. */
export function rankComposerModelMentions<T>(
  candidates: ReadonlyArray<T>,
  query: string,
  toSearchable: (candidate: T) => ModelPickerSearchableModel,
): T[] {
  for (const words of mentionSearchQueries(query)) {
    // Every word must start a word of the model's names. Fuzzy hits would push files out of the `@` menu.
    const tokens = words
      .toLowerCase()
      .split(/\s+/u)
      .map((token) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(token)}`, "u"));
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
      return tokens.every((token) => token.test(haystack));
    });
    const ranked = rankModelPickerSearch(literal, words, toSearchable);
    if (ranked.length > 0) return ranked.slice(0, COMPOSER_MODEL_MENTION_LIMIT);
  }
  return [];
}

/**
 * Prompt text naming a provider instance, model and options for the agent, as in
 * `model:codex/gpt-6.1-sol?reasoningEffort=xhigh&fastMode=true`. No `@`, which the editor
 * would turn into a file chip.
 */
export function formatComposerModelMention(
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): string {
  const query = options
    .map((option) => `${encodeURIComponent(option.id)}=${encodeURIComponent(option.value)}`)
    .join("&");
  return `model:${instanceId}/${model}${query ? `?${query}` : ""}`;
}

/** The key a device remembers a model's last mention options under. */
export function modelMentionOptionsKey(instanceId: string, model: string): string {
  return `${instanceId}:${model}`;
}

function parseMentionOptions(query: string): ReadonlyArray<ProviderOptionSelection> {
  const options: ProviderOptionSelection[] = [];
  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    try {
      const id = decodeURIComponent(pair.slice(0, separator)).trim();
      const raw = decodeURIComponent(pair.slice(separator + 1));
      if (id) options.push({ id, value: raw === "true" ? true : raw === "false" ? false : raw });
    } catch {
      // A hand-edited `%` escape that does not decode drops only that option.
    }
  }
  return options;
}

export interface ComposerModelMentionOccurrence {
  readonly instanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
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
  let end = slug.length;
  const unmatched = new Map<string, number>();
  while (end > 0) {
    const last = slug[end - 1]!;
    if (SENTENCE_PUNCTUATION.includes(last)) {
      end -= 1;
      continue;
    }
    const opening = CLOSING_BRACKETS[last];
    if (opening === undefined) break;
    const excess = unmatched.get(last) ?? countOf(slug, last) - countOf(slug, opening);
    if (excess <= 0) break;
    unmatched.set(last, excess - 1);
    end -= 1;
  }
  return slug.slice(0, end);
}

/** Finds the `model:<instance>/<model>[?<options>]` references that `formatComposerModelMention` writes. */
export function collectComposerModelMentions(
  text: string,
): ReadonlyArray<ComposerModelMentionOccurrence> {
  if (!text.includes("model:")) return [];
  const occurrences: ComposerModelMentionOccurrence[] = [];
  for (const match of text.matchAll(MODEL_MENTION_PATTERN)) {
    const instanceId = match[1]!;
    const reference = trimModelSlug(match[2]!);
    const queryStart = reference.indexOf("?");
    const model = queryStart < 0 ? reference : reference.slice(0, queryStart);
    if (model.length === 0) continue;
    const options = queryStart < 0 ? [] : parseMentionOptions(reference.slice(queryStart + 1));
    const start = match.index;
    const end = start + "model:".length + instanceId.length + 1 + reference.length;
    occurrences.push({ instanceId, model, options, source: text.slice(start, end), start, end });
  }
  return occurrences;
}
