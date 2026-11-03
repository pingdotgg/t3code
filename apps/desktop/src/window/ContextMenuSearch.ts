const MAX_LABEL_QUERY_LENGTH = 30;

export interface ContextMenuWebSearch {
  readonly label: string;
  readonly url: string;
}

export function contextMenuWebSearch(selectionText: string): ContextMenuWebSearch | undefined {
  const query = selectionText.replace(/\s+/g, " ").trim();
  if (query.length === 0) return undefined;
  const shown =
    query.length > MAX_LABEL_QUERY_LENGTH
      ? `${query.slice(0, MAX_LABEL_QUERY_LENGTH).trimEnd()}…`
      : query;
  return {
    // Electron menus treat "&" as an accelerator marker, so double it to show it literally.
    label: `Search Google for “${shown.replaceAll("&", "&&")}”`,
    url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  };
}
