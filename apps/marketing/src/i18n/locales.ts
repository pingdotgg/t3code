// `code` is Astro's locale code and the BCP 47 tag for `<html lang>` and hreflang. `path` is the URL
// segment. pt-BR lives at `/pt-br`: lowercase like every other path on the site, with the region
// kept so a future pt-PT can sit beside it. zh is Simplified Chinese.
export const LOCALES = [
  { code: "en", path: "", name: "English" },
  { code: "es", path: "es", name: "Español" },
  { code: "zh-Hans", path: "zh", name: "简体中文" },
  { code: "pt-BR", path: "pt-br", name: "Português (Brasil)" },
  { code: "fr", path: "fr", name: "Français" },
  { code: "de", path: "de", name: "Deutsch" },
  { code: "ja", path: "ja", name: "日本語" },
  { code: "ko", path: "ko", name: "한국어" },
  { code: "ru", path: "ru", name: "Русский" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const DEFAULT_LOCALE: Locale = "en";

/** Pages that exist in every locale. Legal pages, the 404, and /95 stay English-only. */
export const LOCALIZED_PATHS = ["/", "/download"] as const;

export type LocalizedPath = (typeof LOCALIZED_PATHS)[number];

export const isLocalizedPath = (path: string): path is LocalizedPath =>
  (LOCALIZED_PATHS as ReadonlyArray<string>).includes(path);

export const localeInfo = (locale: Locale) => LOCALES.find((entry) => entry.code === locale)!;

export const localizedHref = (locale: Locale, path: LocalizedPath): string => {
  const prefix = localeInfo(locale).path;
  if (!prefix) return path;
  return path === "/" ? `/${prefix}` : `/${prefix}${path}`;
};

/** `getStaticPaths` entries for a `[...locale]` route: English at the root, the rest prefixed. */
export const localeStaticPaths = () =>
  LOCALES.map((entry) => ({
    params: { locale: entry.path || undefined },
    props: { locale: entry.code as Locale },
  }));

/** Splits `"On ARM? {deb} or {appimage}."` so callers can render each `{key}` as markup. */
export const templateParts = (template: string): Array<string | { key: string }> =>
  template
    .split(/(\{\w+\})/)
    .filter(Boolean)
    .map((part) => (/^\{\w+\}$/.test(part) ? { key: part.slice(1, -1) } : part));

export const fillTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
