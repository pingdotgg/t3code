/** The only Chromium locale packaged builds ship, so Electron seeds the spellchecker with it. */
const PACKAGED_DEFAULT_LANGUAGE = "en-US";

const normalizeLanguageTag = (tag: string): string =>
  tag.split(/[.@]/)[0]!.replace(/_/g, "-").toLowerCase();

const matchAvailableLanguage = (
  preferred: string,
  available: ReadonlyArray<string>,
): string | undefined => {
  const tag = normalizeLanguageTag(preferred);
  const exact = available.find((language) => language.toLowerCase() === tag);
  if (exact) return exact;
  const base = tag.split("-")[0]!;
  return (
    available.find((language) => language.toLowerCase() === base) ??
    available.find((language) => language.toLowerCase().startsWith(`${base}-`))
  );
};

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
  const languages = [
    ...new Set(
      preferredSystemLanguages.flatMap((preferred) => {
        const match = matchAvailableLanguage(preferred, available);
        return match ? [match] : [];
      }),
    ),
  ];
  if (languages.length === 0) return undefined;
  if (languages.length === 1 && languages[0] === PACKAGED_DEFAULT_LANGUAGE) return undefined;
  return languages;
};
