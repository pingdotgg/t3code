// The command-palette model (mirrors the web CommandPalette): a flat list of
// runnable commands plus a pure fuzzy filter. ChatView builds the list from its
// handlers + current context; the palette renders the filtered result. Keeping
// the filter pure makes the ranking unit-testable without a renderer.

export interface Command {
  readonly id: string;
  readonly title: string;
  /** A shortcut hint shown on the right, e.g. "^N". */
  readonly hint?: string;
  /** Extra search terms (synonyms) not shown but matched. */
  readonly keywords?: string;
  readonly run: () => void;
}

function subsequenceMatch(query: string, text: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return query.length === 0;
}

/**
 * Rank commands against a query: title prefix > title substring > keyword
 * substring > subsequence, preserving the original order within a tier. An
 * empty query returns every command unchanged.
 */
export function filterCommands(
  commands: ReadonlyArray<Command>,
  query: string,
): Command[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...commands];

  const scored: Array<{ command: Command; score: number; order: number }> = [];
  commands.forEach((command, order) => {
    const title = command.title.toLowerCase();
    const keywords = command.keywords?.toLowerCase() ?? "";
    let score: number;
    if (title.startsWith(q)) score = 0;
    else if (title.includes(q)) score = 1;
    else if (keywords.includes(q)) score = 2;
    else if (subsequenceMatch(q, title)) score = 3;
    else return;
    scored.push({ command, score, order });
  });

  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.map((entry) => entry.command);
}
