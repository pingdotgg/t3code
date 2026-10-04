import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const markdownParser = unified().use(remarkParse).use(remarkGfm).freeze();
const mentionPattern = /@\{([^{}\s]+)\}/gu;
const ignoredMarkdownNodes = new Set([
  "code",
  "inlineCode",
  "html",
  "link",
  "linkReference",
  "image",
  "imageReference",
]);

type MarkdownNode = {
  type: string;
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
  children?: MarkdownNode[] | undefined;
};

function htmlContentRanges(body: string, tree: MarkdownNode) {
  const fragments: string[] = [];
  let cursor = 0;
  const collect = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "html" && start !== undefined && end !== undefined) {
      fragments.push(" ".repeat(start - cursor), body.slice(start, end));
      cursor = end;
    } else {
      node.children?.forEach(collect);
    }
  };
  collect(tree);
  const ranges: { start: number; end: number }[] = [];
  if (fragments.length === 0) return ranges;
  fragments.push(" ".repeat(body.length - cursor));
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    const location = "tagName" in node ? node.sourceCodeLocation : undefined;
    const start = location?.startTag?.endOffset;
    const end = location?.endTag?.startOffset ?? location?.endOffset;
    if (start !== undefined && end !== undefined && end > start) {
      ranges.push({ start, end });
      return;
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parseFragment(fragments.join(""), { sourceCodeLocationInfo: true }));
  return ranges;
}

function mentionLabels(html: string) {
  const labels = new Map<string, string>();
  const conflicts = new Set<string>();
  const text = (node: DefaultTreeAdapterTypes.Node): string =>
    "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ("tagName" in node) {
      if (["pre", "code", "script", "style"].includes(node.tagName)) return;
      const attribute = (name: string) => node.attrs.find((entry) => entry.name === name)?.value;
      const id = attribute("data-atlassian-id");
      if (id && attribute("class")?.split(/\s+/u).includes("ap-mention")) {
        const label = text(node).replace(/\s+/gu, " ").trim();
        if (label.startsWith("@") && label.length > 1) {
          if (labels.has(id) && labels.get(id) !== label) conflicts.add(id);
          labels.set(id, label);
        }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parseFragment(html));
  conflicts.forEach((id) => labels.delete(id));
  return labels;
}

/** Resolves prose mentions for display without changing the Markdown used for edits. */
export function bitbucketMentionDisplayBody(body: string, html: unknown) {
  if (typeof html !== "string" || !html || !body.includes("@{")) return undefined;
  const labels = mentionLabels(html);
  if (labels.size === 0) return undefined;
  const tree = markdownParser.parse(body);
  const htmlRanges = htmlContentRanges(body, tree);
  const replacements: { start: number; end: number; label: string }[] = [];
  const visit = (node: MarkdownNode) => {
    if (ignoredMarkdownNodes.has(node.type)) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "text" && start !== undefined && end !== undefined) {
      const source = body.slice(start, end);
      for (const match of source.matchAll(mentionPattern)) {
        if (
          htmlRanges.some(
            (range) => start + match.index >= range.start && start + match.index < range.end,
          )
        )
          continue;
        let escapes = 0;
        for (let index = match.index - 1; index >= 0 && source[index] === "\\"; index--) escapes++;
        if (escapes % 2 !== 0) continue;
        const label = labels.get(match[1]!);
        if (label === undefined) continue;
        replacements.push({
          start: start + match.index,
          end: start + match.index + match[0].length,
          label: label.replace(/[\\`*_{}[\]()<>!#|~&]/gu, "\\$&"),
        });
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  if (replacements.length === 0) return undefined;
  let displayBody = body;
  for (const replacement of replacements.toReversed()) {
    displayBody =
      displayBody.slice(0, replacement.start) +
      replacement.label +
      displayBody.slice(replacement.end);
  }
  return displayBody === body ? undefined : displayBody;
}
