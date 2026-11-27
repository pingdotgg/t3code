/**
 * A Bot note is `notes/<slug>.md`: a small header with its title and one-line summary, then the
 * body. The header is the index, so hand edits and deletes can never leave the index stale.
 */
export interface ParsedNote {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

const HEADER = /^---\n([\s\S]*?)\n---\n?/u;

const headerValue = (header: string, key: string): string | undefined => {
  const line = header.split("\n").find((entry) => entry.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim();
};

/** A file without a header (written by hand) is all body, titled after its slug. */
export function parseNote(slug: string, text: string): ParsedNote {
  const match = HEADER.exec(text);
  if (match === null) return { title: slug, summary: "", body: text };
  const header = match[1] ?? "";
  return {
    title: headerValue(header, "title") || slug,
    summary: headerValue(header, "summary") ?? "",
    body: text.slice(match[0].length),
  };
}

const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim();

export function serializeNote(note: ParsedNote): string {
  const body = note.body.endsWith("\n") || note.body === "" ? note.body : `${note.body}\n`;
  return `---\ntitle: ${oneLine(note.title)}\nsummary: ${oneLine(note.summary)}\n---\n${body}`;
}
