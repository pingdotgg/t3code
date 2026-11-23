interface MarkdownAstNode {
  type?: string;
  value?: unknown;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
}

export const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;

// GitHub ends the marker's line at a break written after it too: a hard break or a raw `<br>`.
function isLineBreak(node: MarkdownAstNode | undefined): boolean {
  return (
    node?.type === "break" ||
    (node?.type === "html" &&
      typeof node.value === "string" &&
      /^<br(?:\s[^>]*)?>$/i.test(node.value))
  );
}

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
  // An empty remainder may have next-line sibling content; preserve whether the marker ended its line.
  const markerEndsItsLine = match[0].endsWith("\n");
  if (remainder.length > 0) {
    text.value = remainder;
  } else if (markerEndsItsLine || paragraph.children?.length === 1) {
    paragraph.children?.shift();
  } else if (isLineBreak(paragraph.children?.[1])) {
    paragraph.children?.splice(0, 2);
    // A raw `<br>` leaves its line ending at the start of the body; a hard break keeps none.
    const body = paragraph.children?.[0];
    if (body?.type === "text" && typeof body.value === "string") {
      body.value = body.value.replace(/^\r?\n/, "");
      if (body.value === "") paragraph.children?.shift();
    }
  } else {
    return;
  }
  if (paragraph.children?.length === 0) node.children?.shift();

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
