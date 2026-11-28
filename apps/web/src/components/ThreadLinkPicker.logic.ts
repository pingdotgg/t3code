import { normalizeSearchText } from "~/lib/utils";

export function threadLinkMatcher(query: string, locale?: string) {
  const localQuery = query.trim().toLocaleLowerCase(locale);
  const foldedQuery = normalizeSearchText(query);
  return (text: string) =>
    text.toLocaleLowerCase(locale).includes(localQuery) ||
    normalizeSearchText(text).includes(foldedQuery);
}
