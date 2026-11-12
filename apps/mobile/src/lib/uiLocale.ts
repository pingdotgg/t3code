export type UiLocaleSetting = "system" | "en" | "zh-Hans";
export type ResolvedUiLocale = Exclude<UiLocaleSetting, "system">;

/**
 * Priority: explicit server setting, then the per-app/system language, then en.
 * `setting` is null when the server predates the uiLocale field.
 */
export function resolveUiLocale(
  setting: UiLocaleSetting | null | undefined,
  systemLocale: string | null | undefined,
): ResolvedUiLocale {
  if (setting === "en" || setting === "zh-Hans") return setting;
  if (systemLocale?.toLowerCase().startsWith("zh")) return "zh-Hans";
  return "en";
}

/** Several environments may be connected; the first explicit setting wins. */
export function resolveActiveUiLocale(
  settings: ReadonlyArray<{ readonly uiLocale?: UiLocaleSetting } | null | undefined>,
  systemLocale: string | null | undefined,
): ResolvedUiLocale {
  const explicit = settings.find(
    (entry) => entry?.uiLocale === "en" || entry?.uiLocale === "zh-Hans",
  );
  return resolveUiLocale(explicit?.uiLocale, systemLocale);
}

/** What the settings row should show: the uniform choice, or "system" when unset or mixed. */
export function selectedUiLocaleChoice(
  settings: ReadonlyArray<{ readonly uiLocale?: UiLocaleSetting } | null | undefined>,
): UiLocaleSetting {
  const values = new Set(settings.map((entry) => entry?.uiLocale ?? "system"));
  const [first] = values;
  return values.size === 1 && first ? first : "system";
}
