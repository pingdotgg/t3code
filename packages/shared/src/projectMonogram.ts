// One ideograph or syllable block already reads as a compact mark; two look bulky.
const SINGLE_GLYPH_SCRIPT = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;

export function projectMonogram(projectName: string): string {
  const words =
    projectName
      .normalize("NFKC")
      .trim()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  if (SINGLE_GLYPH_SCRIPT.test(first)) return first;
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}
