import type { ServerSettings, SpeechCustomWords } from "@t3tools/contracts";

const MATCH_THRESHOLD = 0.18;

const matchKey = (value: string) =>
  [...value]
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("")
    .toLocaleLowerCase();

const isAsciiKey = (value: string) => /^[a-z0-9]+$/i.test(value);

const soundex = (value: string) => {
  const upper = value.toUpperCase();
  const first = upper[0] ?? "";
  const code = (character: string) => {
    if ("BFPV".includes(character)) return "1";
    if ("CGJKQSXZ".includes(character)) return "2";
    if ("DT".includes(character)) return "3";
    if (character === "L") return "4";
    if ("MN".includes(character)) return "5";
    if (character === "R") return "6";
    return "0";
  };
  let previous = code(first);
  let result = first;
  for (const character of upper.slice(1)) {
    const next = code(character);
    if (next !== "0" && next !== previous) result += next;
    previous = next;
  }
  return `${result}000`.slice(0, 4);
};

const editDistance = (left: string, right: string) => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(
        Math.min(
          current[rightIndex]! + 1,
          previous[rightIndex + 1]! + 1,
          previous[rightIndex]! + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
};

const punctuation = (value: string) => {
  const characters = [...value];
  const first = characters.findIndex((character) => /[\p{L}\p{N}]/u.test(character));
  const last = characters.findLastIndex((character) => /[\p{L}\p{N}]/u.test(character));
  return {
    prefix: first < 0 ? value : characters.slice(0, first).join(""),
    suffix: last < 0 ? "" : characters.slice(last + 1).join(""),
  };
};

const preserveCase = (original: string, replacement: string) => {
  const letters = [...original].filter((character) => /\p{L}/u.test(character));
  if (letters.length > 0 && letters.every((character) => character === character.toUpperCase()))
    return replacement.toUpperCase();
  const firstLetter = [...original].find((character) => /\p{L}/u.test(character));
  if (firstLetter && firstLetter === firstLetter.toUpperCase()) {
    const [first = "", ...rest] = [...replacement];
    return first.toUpperCase() + rest.join("");
  }
  return replacement;
};

type CustomWordKey = { readonly word: string; readonly key: string };

const customWordKeys = (words: readonly string[]): CustomWordKey[] =>
  words.flatMap((word) => {
    const keys = [matchKey(word)];
    if (word.includes("&")) keys.push(matchKey(word.replaceAll("&", " and ")));
    return [...new Set(keys)].filter(isAsciiKey).map((key) => ({ word, key }));
  });

const bestMatch = (candidate: string, keys: readonly CustomWordKey[]) => {
  if (!isAsciiKey(candidate) || candidate.length > 50) return undefined;
  let best: { readonly word: string; readonly score: number } | undefined;
  for (const custom of keys) {
    const longest = Math.max(candidate.length, custom.key.length);
    if (Math.abs(candidate.length - custom.key.length) > Math.max(longest * 0.25, 2)) continue;
    const distance = editDistance(candidate, custom.key) / longest;
    const phonetic = /^[a-z]+$/i.test(candidate) && /^[a-z]+$/i.test(custom.key);
    const score =
      phonetic && soundex(candidate) === soundex(custom.key) ? distance * 0.3 : distance;
    if (score < MATCH_THRESHOLD && (!best || score < best.score))
      best = { word: custom.word, score };
  }
  return best;
};

export function applySpeechCustomWords(text: string, words: readonly string[]): string {
  const keys = customWordKeys(words);
  if (keys.length === 0) return text;
  const tokens = [...text.matchAll(/\S+/g)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const output: string[] = [];
  let cursor = 0;
  for (let index = 0; index < tokens.length;) {
    let best: { readonly count: number; readonly word: string; readonly score: number } | undefined;
    for (let count = Math.min(4, tokens.length - index); count >= 1; count -= 1) {
      const slice = tokens.slice(index, index + count);
      if (
        slice
          .slice(0, -1)
          .some(
            (token, offset) =>
              punctuation(token.value).suffix ||
              /[\r\n]/.test(text.slice(token.end, slice[offset + 1]!.start)),
          )
      )
        continue;
      const match = bestMatch(matchKey(slice.map(({ value }) => value).join("")), keys);
      if (
        match &&
        (!best || match.score < best.score || (match.score === best.score && count < best.count))
      )
        best = { count, ...match };
    }
    if (!best) {
      index += 1;
      continue;
    }
    const consumed = tokens.slice(index, index + best.count);
    output.push(text.slice(cursor, consumed[0]!.start));
    output.push(
      punctuation(consumed[0]!.value).prefix +
        preserveCase(consumed[0]!.value, best.word) +
        punctuation(consumed.at(-1)!.value).suffix,
    );
    cursor = consumed.at(-1)!.end;
    index += best.count;
  }
  output.push(text.slice(cursor));
  return output.join("");
}

const normalizeWord = (word: string) =>
  word
    .replace(/[<>"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function normalizeSpeechCustomWords(words: SpeechCustomWords): SpeechCustomWords {
  const seen = new Set<string>();
  return words
    .flatMap(({ term, aliases }) => {
      const preferred = normalizeWord(term);
      const key = preferred.toLocaleLowerCase();
      if (!preferred || preferred.length > 50 || seen.has(key)) return [];
      seen.add(key);
      const normalizedAliases = aliases.flatMap((alias) => {
        const value = normalizeWord(alias);
        const aliasKey = value.toLocaleLowerCase();
        if (!value || value.length > 50 || seen.has(aliasKey)) return [];
        seen.add(aliasKey);
        return [value];
      });
      return [{ term: preferred, aliases: normalizedAliases.slice(0, 8) }];
    })
    .slice(0, 100);
}

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeSpeechAliasReplacer(words: SpeechCustomWords): (text: string) => string {
  const spellings = words
    .flatMap(({ term, aliases }) => [term, ...aliases].map((spelling) => ({ spelling, term })))
    .sort((left, right) => right.spelling.length - left.spelling.length);
  if (spellings.length === 0) return (text) => text;
  const lookup = new Map(
    spellings.map(({ spelling, term }) => [spelling.toLocaleLowerCase(), term]),
  );
  const word = "[\\p{L}\\p{M}\\p{N}\\p{Pc}]";
  const pattern = new RegExp(
    `(?<!${word})(?:${spellings.map(({ spelling }) => escapePattern(spelling)).join("|")})(?!${word})`,
    "giu",
  );
  return (text) => text.replace(pattern, (match) => lookup.get(match.toLocaleLowerCase()) ?? match);
}

export function applySpeechAliases(text: string, words: SpeechCustomWords): string {
  return makeSpeechAliasReplacer(words)(text);
}

export function transcriptionCustomWords(
  settings: Pick<
    ServerSettings,
    "speechCustomWords" | "speechCorrectionWord" | "speechPostProcessingEnabled"
  >,
): string[] {
  return normalizeSpeechCustomWords(
    settings.speechPostProcessingEnabled
      ? [{ term: settings.speechCorrectionWord, aliases: [] }, ...settings.speechCustomWords]
      : settings.speechCustomWords,
  ).map(({ term }) => term);
}
