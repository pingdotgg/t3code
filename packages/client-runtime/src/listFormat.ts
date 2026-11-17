/** "A, B, and C" in `locale`. Hermes ships without Intl.ListFormat, so it falls back to English. */
export function formatConjunctionList(items: ReadonlyArray<string>, locale: string): string {
  if (typeof Intl.ListFormat === "function") {
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
  }
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
