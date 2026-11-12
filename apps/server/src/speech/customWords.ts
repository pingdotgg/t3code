import type { SpeechCustomWords } from "@t3tools/contracts";

/** Fuzzy-matches preferred terms and rewrites aliases to their preferred spelling. */
export function makeSpeechTextCorrector(
  words: readonly string[],
  dictionary: SpeechCustomWords = [],
) {
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
      const sources = [word];
      if (word.includes("&")) sources.push(word.replaceAll("&", " and "));
      const keys = sources.flatMap((source) => {
        const key = matchKey(source);
        // A term that loses its symbols to one letter (C# -> c) would claim every standalone letter.
        const lostSymbols = key !== source.replace(/\s+/gu, "").toLocaleLowerCase();
        return key.length < 2 && lostSymbols ? [] : [key];
      });
      return [...new Set(keys)].filter(isAsciiKey).map((key) => ({ word, key }));
    });

  const possessive = /['’]s$/iu;
  const innerPossessives = (value: string) => value.match(/['’]s(?=\s)/giu)?.length ?? 0;
  type Match = { readonly word: string; readonly score: number; readonly suffix: string };
  const bestMatch = (phrase: string, keys: readonly CustomWordKey[]) => {
    const key = matchKey(phrase);
    const suffix = phrase.match(possessive)?.[0] ?? "";
    const stem = suffix ? key.slice(0, -1) : key;
    if (!isAsciiKey(stem) || stem.length > 50) return undefined;
    const inner = innerPossessives(phrase);
    let best: Match | undefined;
    for (const custom of keys) {
      if (inner > 0 && inner > innerPossessives(custom.word)) continue;
      const keepSuffix = suffix !== "" && !possessive.test(custom.word);
      const candidate = keepSuffix ? stem : key;
      if (Math.min(candidate.length, custom.key.length) < 4 && candidate !== custom.key) continue;
      const longest = Math.max(candidate.length, custom.key.length);
      if (Math.abs(candidate.length - custom.key.length) > Math.max(longest * 0.25, 2)) continue;
      const distance = editDistance(candidate, custom.key) / longest;
      const phonetic = /^[a-z]+$/i.test(candidate) && /^[a-z]+$/i.test(custom.key);
      const score =
        phonetic && soundex(candidate) === soundex(custom.key) ? distance * 0.3 : distance;
      if (score < MATCH_THRESHOLD && (!best || score < best.score))
        best = { word: custom.word, score, suffix: keepSuffix ? suffix : "" };
    }
    return best;
  };

  const apply = (text: string): string => {
    if (keys.length === 0) return text;
    // Leave surrounding punctuation in the source; only horizontal whitespace can join words.
    const tokens = [...text.matchAll(/[\p{L}\p{M}\p{N}](?:\S*[\p{L}\p{M}\p{N}])?/gu)]
      .filter(([word]) => /^[\p{L}\p{M}\p{N}'’-]+$/u.test(word))
      .map((match) => ({
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      }));
    const output: string[] = [];
    let cursor = 0;
    for (let index = 0; index < tokens.length;) {
      let best: (Match & { readonly count: number }) | undefined;
      for (let count = Math.min(4, tokens.length - index); count >= 1; count -= 1) {
        const slice = tokens.slice(index, index + count);
        if (
          slice
            .slice(0, -1)
            .some(
              (token, offset) =>
                !/^[\t\p{Zs}]+$/u.test(text.slice(token.end, slice[offset + 1]!.start)),
            )
        )
          continue;
        const match = bestMatch(text.slice(slice[0]!.start, slice[count - 1]!.end), keys);
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
      const first = tokens[index]!;
      output.push(
        text.slice(cursor, first.start),
        preserveCase(first.value, best.word),
        best.suffix,
      );
      cursor = tokens[index + best.count - 1]!.end;
      index += best.count;
    }
    output.push(text.slice(cursor));
    return output.join("");
  };

  const keys = customWordKeys(words);
  const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const spellings = dictionary
    .flatMap(({ term, aliases }) => [term, ...aliases].map((spelling) => ({ spelling, term })))
    .sort((left, right) => right.spelling.length - left.spelling.length);
  if (spellings.length === 0) return apply;
  const lookup = new Map(
    spellings.map(({ spelling, term }) => [spelling.toLocaleLowerCase(), term]),
  );
  const word = "[\\p{L}\\p{M}\\p{N}\\p{Pc}]";
  const pattern = new RegExp(
    `(?<!${word})(?:${spellings.map(({ spelling }) => escapePattern(spelling)).join("|")})(?!${word})`,
    "giu",
  );
  return (text: string) => {
    let output = "";
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      output += apply(text.slice(cursor, match.index));
      output += lookup.get(match[0].toLocaleLowerCase()) ?? match[0];
      cursor = match.index + match[0].length;
    }
    return output + apply(text.slice(cursor));
  };
}

export function applySpeechAliases(text: string, words: SpeechCustomWords): string {
  return makeSpeechTextCorrector([], words)(text);
}

const normalizeWord = (word: string) => word.replace(/\s+/g, " ").trim();

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
