/**
 * GitHub's blockquote alerts: a quote whose first line is `[!NOTE]` — or TIP, IMPORTANT,
 * WARNING, CAUTION — renders as a titled callout. They are GitHub's own extension rather than
 * GFM, so remark-gfm leaves the marker as literal text in the quote. This lifts the marker off
 * the mdast into a `data-alert` attribute for the blockquote renderer to style, and removes
 * the marker line itself.
 *
 * Only a marker with nothing after it on its own line counts, which is GitHub's rule:
 * `> [!NOTE] aside` is an ordinary quote.
 */

interface MarkdownAstNode {
  type?: string;
  value?: unknown;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;

function readGithubAlert(node: MarkdownAstNode): void {
  if (node.type !== "blockquote") return;
  const paragraph = node.children?.[0];
  const text = paragraph?.children?.[0];
  if (paragraph?.type !== "paragraph" || text?.type !== "text" || typeof text.value !== "string") {
    return;
  }
  const match = GITHUB_ALERT_MARKER.exec(text.value);
  if (!match?.[1]) return;

  const remainder = text.value.slice(match[0].length);
  // Whether the marker's own line ended inside this text node. Without it, an empty remainder
  // is ambiguous: `[!NOTE]\n**bold**` parses as [text "[!NOTE]\n", strong] — next-line content
  // in a sibling — while `[!NOTE]*aside*` parses the same way minus the newline.
  const markerEndsItsLine = match[0].endsWith("\n");
  if (remainder.length > 0) {
    // The quote continues on the next line inside the same text node: keep the paragraph,
    // shed the marker line.
    text.value = remainder;
  } else if (markerEndsItsLine || paragraph.children?.length === 1) {
    // The marker was the whole text node — a marker-only paragraph, or a marker line whose
    // next line starts as a sibling inline. Drop the node, and the paragraph if it empties.
    paragraph.children?.shift();
    if (paragraph.children?.length === 0) {
      node.children?.shift();
    }
  } else {
    // Something else shares the marker's line — `[!NOTE]*aside*` — which GitHub does not
    // read as an alert.
    return;
  }

  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      dataAlert: match[1].toLowerCase(),
    },
  };
}

export function remarkGithubAlerts() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      node.children?.forEach(visit);
      readGithubAlert(node);
    };
    visit(tree);
  };
}
