/** The only Chromium locale packaged builds ship, so Electron seeds the spellchecker with it. */
const PACKAGED_DEFAULT_LANGUAGE = "en-US";

const normalizeLanguageTag = (tag: string): string =>
  tag.split(/[.@]/)[0]!.replace(/_/g, "-").toLowerCase();

const baseLanguage = (tag: string): string => tag.toLowerCase().split("-")[0]!;

const findExactLanguage = (tag: string, available: ReadonlyArray<string>): string | undefined =>
  available.find((language) => language.toLowerCase() === tag);

const findBaseLanguage = (base: string, available: ReadonlyArray<string>): string | undefined =>
  available.find((language) => language.toLowerCase() === base) ??
  available.find((language) => language.toLowerCase().startsWith(`${base}-`));

/**
 * The dictionaries to use instead of the packaged en-US default, or undefined to leave the
 * session alone. A list other than the seeded default is the user's own choice and is kept.
 */
export const resolveSpellCheckerLanguages = (
  current: ReadonlyArray<string>,
  preferredSystemLanguages: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): string[] | undefined => {
  if (current.length > 1 || (current[0] ?? PACKAGED_DEFAULT_LANGUAGE) !== PACKAGED_DEFAULT_LANGUAGE)
    return undefined;
  const tags = preferredSystemLanguages.map(normalizeLanguageTag);
  const exactMatches = tags.map((tag) => findExactLanguage(tag, available));
  // GLib follows en_GB with a generated "en"; that fallback must not add another English dictionary.
  const coveredBases = new Set(
    exactMatches.flatMap((match) => (match ? [baseLanguage(match)] : [])),
  );
  const languages: string[] = [];
  tags.forEach((tag, index) => {
    let match = exactMatches[index];
    if (!match) {
      const base = baseLanguage(tag);
      if (coveredBases.has(base)) return;
      match = findBaseLanguage(base, available);
      if (match) coveredBases.add(base);
    }
    if (match && !languages.includes(match)) languages.push(match);
  });
  if (languages.length === 0) return undefined;
  if (languages.length === 1 && languages[0] === PACKAGED_DEFAULT_LANGUAGE) return undefined;
  return languages;
};
