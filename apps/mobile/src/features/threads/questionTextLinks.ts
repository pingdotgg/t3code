export type QuestionTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

const LINK_PATTERN =
  /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|https?:\/\/[^\s<>]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?\]}'"]+$/;

/** Drops trailing sentence punctuation, keeping a final `)` only when it closes a `(` in the URL. */
function trimBareUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const trimmed = url.replace(TRAILING_PUNCTUATION, "");
    const opens = trimmed.split("(").length - 1;
    const closes = trimmed.split(")").length - 1;
    const next = trimmed.endsWith(")") && closes > opens ? trimmed.slice(0, -1) : trimmed;
    if (next === url) return url;
    url = next;
  }
}

/** Splits question text into plain text and tappable HTTP(S) links (bare URLs and `[label](url)`). */
export function splitQuestionTextLinks(text: string): ReadonlyArray<QuestionTextSegment> {
  const segments: QuestionTextSegment[] = [];
  let cursor = 0;
  const pushText = (end: number) => {
    if (end > cursor) segments.push({ kind: "text", text: text.slice(cursor, end) });
  };

  for (const match of text.matchAll(LINK_PATTERN)) {
    const [raw, label, markdownHref] = match;
    const start = match.index;
    pushText(start);
    if (markdownHref) {
      segments.push({ kind: "link", text: label ?? markdownHref, href: markdownHref });
      cursor = start + raw.length;
      continue;
    }
    const url = trimBareUrl(raw);
    segments.push({ kind: "link", text: url, href: url });
    cursor = start + url.length;
  }
  pushText(text.length);
  return segments;
}
