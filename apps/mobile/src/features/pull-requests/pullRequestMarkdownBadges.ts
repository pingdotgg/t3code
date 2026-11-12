import {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  markdownWithHtml,
  parseMarkdownSource,
  type MarkdownNode,
  type MarkdownEdit,
} from "../../lib/markdownDocument";
import { isBotBadgeImage } from "./botBadgeImages";

export type PullRequestMarkdownSegment =
  | (Extract<PullRequestBodySegment, { kind: "markdown" }> & {
      readonly sourceOffsetAt: (offset: number) => number | null;
    })
  | Extract<PullRequestBodySegment, { kind: "attachment" }>
  | {
      readonly id: string;
      readonly kind: "table";
      readonly rows: ReadonlyArray<
        ReadonlyArray<{
          readonly header: boolean;
          readonly segments: ReadonlyArray<PullRequestMarkdownSegment>;
        }>
      >;
    };

function originalOffset(edits: ReadonlyArray<MarkdownEdit>, offset: number): number | null {
  let shift = 0;
  for (const edit of edits) {
    const start = edit.start + shift;
    if (offset < start) break;
    if (offset < start + edit.content.length) return null;
    shift += edit.content.length - (edit.end - edit.start);
  }
  return offset - shift;
}

/** Leading badge images otherwise get the native renderer's 200pt block-image frame. */
export function inlinePullRequestBadges(source: string): string {
  return badgeMarkdown(source).text;
}

function badgeMarkdown(source: string) {
  if (!source.includes("![") && !/<img\b/i.test(source))
    return { text: source, sourceOffsetAt: (offset: number) => offset };
  let htmlEdits: ReadonlyArray<MarkdownEdit> = [];
  const markdown = markdownWithHtml(source, (edits) => {
    htmlEdits = edits;
  });
  const document = parseMarkdownSource(markdown);
  const definitions = new Map(
    document.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier, node.url] as const] : [],
    ),
  );
  const edits: MarkdownEdit[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "image" || node.type === "imageReference") {
      const href = node.type === "image" ? node.url : definitions.get(node.identifier);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (href && isBotBadgeImage(href) && start !== undefined && end !== undefined) {
        const label = node.alt?.trim().replace(/\s+badge$/i, "") || "Status badge";
        edits.push({ start, end, content: label.replace(/[\\`*_[\]<>]/g, "\\$&") });
      }
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(document);
  return {
    text: edits.reduceRight(
      (text, edit) => text.slice(0, edit.start) + edit.content + text.slice(edit.end),
      markdown,
    ),
    sourceOffsetAt: (offset: number) => {
      const htmlOffset = originalOffset(edits, offset);
      return htmlOffset === null ? null : originalOffset(htmlEdits, htmlOffset);
    },
  };
}

function inlineSegmentBadges(segment: PullRequestBodySegment): PullRequestMarkdownSegment {
  if (segment.kind === "markdown") return { ...segment, ...badgeMarkdown(segment.text) };
  if (segment.kind === "table")
    return {
      ...segment,
      rows: segment.rows.map((row) =>
        row.map((cell) => ({ ...cell, segments: cell.segments.map(inlineSegmentBadges) })),
      ),
    };
  return segment;
}

export function pullRequestMarkdownSegments(source: string) {
  return splitPullRequestBody(source).map(inlineSegmentBadges);
}
