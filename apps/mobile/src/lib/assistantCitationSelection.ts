import { markdownMathRanges } from "@t3tools/shared/markdownMath";
import { createAssistantTextSelector } from "@t3tools/shared/assistantCitations";
import {
  splitCodexArtifactTemplateMarkdown,
  renderCodexInlineDirectivesAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { splitMarkdownDetails } from "./markdownDetails";
import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";

function renderedText(node: MarkdownNode, restoreMath: (value: string) => string): string {
  if (
    node.type === "definition" ||
    node.type === "image" ||
    node.type === "imageReference" ||
    node.type === "html"
  )
    return "";
  if ("value" in node) return restoreMath(node.value);
  if ("children" in node) {
    const inline =
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "link" ||
      node.type === "linkReference" ||
      node.type === "emphasis" ||
      node.type === "strong" ||
      node.type === "delete" ||
      node.type === "tableCell";
    return node.children.map((child) => renderedText(child, restoreMath)).join(inline ? "" : "\n");
  }
  return node.type === "break" ? "\n" : "";
}

function citationText(markdown: string): string {
  const formulas = markdownMathRanges(markdown);
  let marker = "\ue000t3math";
  while (markdown.includes(marker)) marker += "_";
  const tokens = formulas.map((_, index) => `${marker}${index}\ue001`);
  let cursor = 0;
  let prose = "";
  for (const [index, formula] of formulas.entries()) {
    prose += markdown.slice(cursor, formula.start) + tokens[index];
    cursor = formula.end;
  }
  prose += markdown.slice(cursor);
  return renderedText(parseMarkdownDocument(prose), (value) =>
    value.replace(new RegExp(`${marker}(\\d+)\ue001`, "g"), (_, index: string) => {
      const formula = formulas[Number(index)]!;
      const tex = formula.tex.trim();
      return formula.display ? `\\[\n${tex}\n\\]` : `\\(${tex}\\)`;
    }),
  );
}

function citationSegments(markdown: string, path = ""): Array<{ path: string; text: string }> {
  return splitMarkdownDetails(markdown).flatMap((block, index) => {
    if (block.kind === "details") return citationSegments(block.body, `${path}${index}/`);
    return splitCodexArtifactTemplateMarkdown(block.markdown).flatMap((segment, segmentIndex) =>
      segment.kind === "markdown"
        ? [
            {
              path: `${path}${index}:${segmentIndex}`,
              text: citationText(renderCodexInlineDirectivesAsMarkdown(segment.markdown)),
            },
          ]
        : [],
    );
  });
}

function occurrences(text: string, quote: string): number[] {
  const result: number[] = [];
  for (let index = text.indexOf(quote); index !== -1; index = text.indexOf(quote, index + 1))
    result.push(index);
  return result;
}

export function collectMobileAssistantTextSelectors(markdown: string, path: string, text: string) {
  if (!text.trim()) return [];
  const normalize = (value: string) => value.replace(/\s+/g, " ");
  const quote = normalize(text);
  const segments = citationSegments(markdown);
  const segmentIndex = segments.findIndex((segment) => segment.path === path);
  const segment = segments[segmentIndex];
  if (!segment) return [];
  const leading = segments
    .slice(0, segmentIndex)
    .map((entry) => entry.text)
    .join("\n");
  const fullText = normalize(segments.map((entry) => entry.text).join("\n"));
  const offset = normalize(leading + (segmentIndex > 0 ? "\n" : "")).length;
  const matches = occurrences(fullText, quote);
  const localMatches = occurrences(normalize(segment.text), quote);
  if (localMatches.length > 20) return [];
  return localMatches.flatMap((localStart) => {
    const start = offset + localStart;
    const index = matches.indexOf(start);
    if (index === -1) return [];
    const selector = createAssistantTextSelector(fullText, start, start + quote.length);
    return selector ? [{ ...selector, text, occurrence: { index, count: matches.length } }] : [];
  });
}
