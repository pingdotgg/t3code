// One ideograph or syllable block already reads as a compact mark; two look bulky.
const SINGLE_GLYPH_SCRIPT = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;

function splitGlyphs(value: string) {
  return value.match(/\P{M}\p{M}*/gu) ?? [];
}

export function projectMonogram(projectName: string): string {
  const words =
    projectName
      .normalize("NFKC")
      .trim()
      .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = splitGlyphs(firstWord);
  const first = glyphs[0] ?? "P";
  if (SINGLE_GLYPH_SCRIPT.test(first)) return first;
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? splitGlyphs(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return splitGlyphs(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}
