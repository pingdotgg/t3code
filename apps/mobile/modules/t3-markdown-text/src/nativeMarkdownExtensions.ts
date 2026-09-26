import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/**
 * GitHub alerts (`> [!NOTE]`), which md4c does not know about, applied to its AST so the mobile
 * renderer matches web. A pure tree rewrite; the renderer only has to recognise the marker field.
 */

export type GithubAlertKind = "note" | "tip" | "important" | "warning" | "caution";

/** A blockquote that opened with a GitHub alert marker; the marker line itself is gone. */
interface AlertMarkedNode extends MarkdownNode {
  readonly type: "blockquote";
  readonly alert: GithubAlertKind;
}

export function markdownAlertKind(node: MarkdownNode): GithubAlertKind | undefined {
  return node.type === "blockquote" ? (node as Partial<AlertMarkedNode>).alert : undefined;
}

function isBreak(node: MarkdownNode | undefined): boolean {
  return node?.type === "soft_break" || node?.type === "line_break";
}

/** Block containers whose children can hold another block. Inline containers cannot. */
function hasBlockChildren(node: MarkdownNode): boolean {
  return (
    node.type === "document" ||
    node.type === "blockquote" ||
    node.type === "list" ||
    node.type === "list_item" ||
    node.type === "task_list_item" ||
    node.type === "html_block"
  );
}

// --- GitHub alerts -------------------------------------------------------------------------

/**
 * Only a marker with nothing after it on its own line counts, which is GitHub's rule:
 * `> [!NOTE] aside` is an ordinary quote. md4c merges adjacent plain text into one node and emits
 * the line break separately, so the marker is a whole text node followed by a break.
 */
const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;

function liftGithubAlert(node: MarkdownNode): MarkdownNode {
  const paragraph = node.children?.[0];
  const marker = paragraph?.children?.[0];
  if (paragraph?.type !== "paragraph" || marker?.type !== "text" || marker.content === undefined) {
    return node;
  }
  const match = GITHUB_ALERT_MARKER.exec(marker.content.trimEnd());
  if (!match?.[1]) return node;
  const [next, ...body] = (paragraph.children ?? []).slice(1);
  if (next !== undefined && !isBreak(next)) return node;

  const blocks = (node.children ?? []).slice(1);
  const lifted: AlertMarkedNode = {
    ...node,
    type: "blockquote",
    alert: match[1].toLowerCase() as GithubAlertKind,
    children: body.length > 0 ? [{ ...paragraph, children: body }, ...blocks] : blocks,
  };
  return lifted;
}

function liftGithubAlerts(node: MarkdownNode): MarkdownNode {
  if (!hasBlockChildren(node) || !node.children) return node;
  let changed = false;
  const children = node.children.map((child) => {
    const lifted = liftGithubAlerts(child);
    changed ||= lifted !== child;
    return lifted;
  });
  const rewritten = changed ? { ...node, children } : node;
  return rewritten.type === "blockquote" ? liftGithubAlert(rewritten) : rewritten;
}

export function nativeMarkdownWithExtensions(document: MarkdownNode): MarkdownNode {
  return liftGithubAlerts(document);
}
