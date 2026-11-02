export function normalizeLanguages(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)),
  ];
}

/** The device's first language, or the app locale when the device reports none. */
export function resolveVoiceInputLanguage(
  languages: ReadonlyArray<string>,
  fallback: string,
): string {
  return languages[0] ?? fallback;
}
