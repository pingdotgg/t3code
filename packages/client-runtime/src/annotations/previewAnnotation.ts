import type {
  PreviewAnnotationCallout,
  PreviewAnnotationCalloutAnchor,
  PreviewAnnotationElementTarget,
  PreviewAnnotationPayload,
} from "@t3tools/contracts";

import { buildElementContextBlock, normalizeElementContextSelection } from "./elementContext.ts";

const TRAILING_PREVIEW_ANNOTATION_BLOCK_PATTERN =
  /\n*<preview_annotation>\n((?:(?!<preview_annotation>)[\s\S])*)\n<\/preview_annotation>\s*$/;
const PREVIEW_SCREENSHOT_LINE = "The attached screenshot is the annotated preview crop.";
const IMAGE_SCREENSHOT_LINE = "The attached screenshot is the annotated image.";

export interface ParsedPreviewAnnotationCallout {
  number: number;
  anchorSummary: string;
  comment: string;
}

export interface ParsedPreviewAnnotation {
  id: string;
  title: string;
  comment: string;
  targetSummary: string;
  styleChanges: string[];
  hasScreenshot: boolean;
  calloutCount: number;
  callouts: ParsedPreviewAnnotationCallout[];
}

export interface ExtractedPreviewAnnotation {
  promptText: string;
  annotation: ParsedPreviewAnnotation | null;
}

export interface ExtractedPreviewAnnotations {
  promptText: string;
  annotations: ParsedPreviewAnnotation[];
}

export function buildPreviewAnnotationCopyText(
  visibleText: string,
  annotations: ReadonlyArray<ParsedPreviewAnnotation>,
): string {
  const sections = annotations.map((annotation) => {
    const lines = [`Annotation: ${annotation.title}`];
    const comment = annotation.comment.trim();
    if (comment) {
      lines.push(comment);
    }
    if (annotation.targetSummary) {
      lines.push(`Targets: ${annotation.targetSummary}`);
    }
    if (annotation.callouts.length > 0) {
      lines.push("Callouts:");
      for (const callout of annotation.callouts) {
        lines.push(`#${callout.number} [${callout.anchorSummary}]`);
        const instruction = callout.comment.trim();
        if (instruction) {
          lines.push(...instruction.split("\n").map((line) => `  ${line}`));
        }
      }
    }
    if (annotation.styleChanges.length > 0) {
      lines.push("Requested visual changes:");
      lines.push(...annotation.styleChanges.map((change) => `- ${change}`));
    }
    return lines.join("\n");
  });
  const promptText = visibleText.trim();
  return [promptText, ...sections].filter((section) => section.length > 0).join("\n\n");
}

function compactCoordinate(value: number): string {
  const fixed = value.toFixed(3).replace(/\.?0+$/, "");
  if (fixed.startsWith("0.")) return fixed.slice(1);
  if (fixed.startsWith("-0.")) return `-${fixed.slice(2)}`;
  return fixed;
}

function formatRect(rect: { x: number; y: number; width: number; height: number }): string {
  return [
    `x=${compactCoordinate(rect.x)}`,
    `y=${compactCoordinate(rect.y)}`,
    `w=${compactCoordinate(rect.width)}`,
    `h=${compactCoordinate(rect.height)}`,
  ].join(", ");
}

function formatElementSource(target: PreviewAnnotationElementTarget): string | null {
  const source = target.element.source ?? target.element.stack[0] ?? null;
  if (!source?.fileName) return null;
  if (source.lineNumber == null) return source.fileName;
  return `${source.fileName}:${source.lineNumber}${
    source.columnNumber == null ? "" : `:${source.columnNumber}`
  }`;
}

function formatElementAnchor(
  anchor: Extract<PreviewAnnotationCalloutAnchor, { kind: "element" }>,
  elements: ReadonlyArray<PreviewAnnotationElementTarget>,
): string {
  const target = elements.find((entry) => entry.id === anchor.targetId);
  if (!target) {
    return `element: ${anchor.targetId}, region: ${formatRect(anchor.rect)}`;
  }
  const elementLabel =
    target.element.selector?.trim() || target.element.tagName.trim() || anchor.targetId;
  const parts = [`element: ${elementLabel}`];
  const componentName = target.element.componentName?.trim();
  if (componentName) parts.push(`component: ${componentName}`);
  const source = formatElementSource(target);
  if (source) parts.push(`source: ${source}`);
  parts.push(`region: ${formatRect(anchor.rect)}`);
  return parts.join(", ");
}

function formatCalloutAnchor(
  anchor: PreviewAnnotationCalloutAnchor,
  elements: ReadonlyArray<PreviewAnnotationElementTarget>,
): string {
  switch (anchor.kind) {
    case "point":
      return `point: x=${compactCoordinate(anchor.point.x)}, y=${compactCoordinate(anchor.point.y)}`;
    case "region":
      return `region: ${formatRect(anchor.rect)}`;
    case "element":
      return formatElementAnchor(anchor, elements);
  }
}

function escapeAnnotationSentinels(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replaceAll("<preview_annotation>", "&lt;preview_annotation&gt;")
    .replaceAll("</preview_annotation>", "&lt;/preview_annotation&gt;");
}

function unescapeAnnotationSentinels(value: string): string {
  return value
    .replaceAll("&lt;preview_annotation&gt;", "<preview_annotation>")
    .replaceAll("&lt;/preview_annotation&gt;", "</preview_annotation>");
}

function appendCalloutLines(
  lines: string[],
  callouts: ReadonlyArray<PreviewAnnotationCallout>,
  elements: ReadonlyArray<PreviewAnnotationElementTarget>,
): void {
  if (callouts.length === 0) return;
  lines.push("Callouts:");
  const ordered = [...callouts].sort(
    (left, right) => left.number - right.number || left.id.localeCompare(right.id),
  );
  for (const callout of ordered) {
    lines.push(`#${callout.number} [${formatCalloutAnchor(callout.anchor, elements)}]`);
    const comment = escapeAnnotationSentinels(callout.comment).trim();
    if (!comment) continue;
    for (const commentLine of comment.split("\n")) {
      lines.push(`  ${commentLine}`);
    }
  }
}

function annotationTitle(annotation: PreviewAnnotationPayload): string {
  if (annotation.source?.kind === "image") {
    return annotation.source.name?.trim() || annotation.pageTitle?.trim() || "Image";
  }
  if (annotation.source?.kind === "preview") {
    return (
      annotation.source.title?.trim() ||
      annotation.source.url.trim() ||
      annotation.pageTitle?.trim() ||
      annotation.pageUrl.trim() ||
      "Preview"
    );
  }
  return annotation.pageTitle?.trim() || annotation.pageUrl.trim() || "Preview";
}

export function buildPreviewAnnotationPrompt(annotation: PreviewAnnotationPayload): string {
  const lines = ["Preview annotation:"];
  lines.push(`Id: ${annotation.id}`);
  lines.push(`Page: ${annotationTitle(annotation)}`);
  const comment = annotation.comment.replace(/\r\n/g, "\n").trim();
  if (comment) {
    if (comment.includes("\n")) {
      lines.push("Comment:", ...comment.split("\n").map((line) => `  ${line}`));
    } else {
      lines.push(`Comment: ${comment}`);
    }
  }
  const targets: string[] = [];
  if (annotation.elements.length > 0) {
    targets.push(
      `${annotation.elements.length} selected element${annotation.elements.length === 1 ? "" : "s"}`,
    );
  }
  if (annotation.regions.length > 0) {
    targets.push(
      `${annotation.regions.length} marked region${annotation.regions.length === 1 ? "" : "s"}`,
    );
  }
  const drawingCount =
    annotation.strokes.length > 0
      ? annotation.strokes.length
      : (annotation.editable?.strokes.length ?? 0);
  if (drawingCount > 0) {
    targets.push(`${drawingCount} drawing${drawingCount === 1 ? "" : "s"}`);
  }
  const calloutCount = annotation.callouts?.length ?? 0;
  if (calloutCount > 0) {
    targets.push(`${calloutCount} numbered callout${calloutCount === 1 ? "" : "s"}`);
  }
  if (targets.length > 0) lines.push(`Targets: ${targets.join(", ")}.`);
  appendCalloutLines(lines, annotation.callouts ?? [], annotation.elements);
  if (annotation.styleChanges.length > 0) {
    lines.push("Requested visual changes:");
    for (const change of annotation.styleChanges) {
      lines.push(`- ${change.property}: ${change.previousValue || "(unset)"} → ${change.value}`);
    }
  }
  if (annotation.screenshot) {
    lines.push(
      annotation.source?.kind === "image" ? IMAGE_SCREENSHOT_LINE : PREVIEW_SCREENSHOT_LINE,
    );
  }
  const elementContexts = annotation.elements
    .map((target) => normalizeElementContextSelection(target.element))
    .filter((context) => context !== null);
  const elementBlock = buildElementContextBlock(elementContexts);
  if (elementBlock) lines.push(elementBlock);
  return [
    "<preview_annotation>",
    ...lines.map(escapeAnnotationSentinels),
    "</preview_annotation>",
  ].join("\n");
}

export function appendPreviewAnnotationPrompt(
  prompt: string,
  annotation: PreviewAnnotationPayload,
): string {
  const annotationText = buildPreviewAnnotationPrompt(annotation);
  const trimmed = prompt.trim();
  return trimmed ? `${trimmed}\n\n${annotationText}` : annotationText;
}

function parseCallouts(lines: ReadonlyArray<string>): ParsedPreviewAnnotationCallout[] {
  const headingIndex = lines.indexOf("Callouts:");
  if (headingIndex < 0) return [];
  const callouts: ParsedPreviewAnnotationCallout[] = [];
  let current: ParsedPreviewAnnotationCallout | null = null;
  const commit = () => {
    if (!current) return;
    callouts.push({
      ...current,
      comment: unescapeAnnotationSentinels(current.comment.trimEnd()),
    });
    current = null;
  };
  for (const line of lines.slice(headingIndex + 1)) {
    const header = /^#(\d+) \[(.*)\]$/.exec(line);
    if (header) {
      commit();
      current = {
        number: Number(header[1]),
        anchorSummary: header[2] ?? "",
        comment: "",
      };
      continue;
    }
    if (current && line.startsWith("  ")) {
      current.comment += `${current.comment ? "\n" : ""}${line.slice(2)}`;
      continue;
    }
    if (current) break;
    if (
      line === "Requested visual changes:" ||
      line === PREVIEW_SCREENSHOT_LINE ||
      line === IMAGE_SCREENSHOT_LINE ||
      line === "<element_context>"
    ) {
      break;
    }
  }
  commit();
  return callouts;
}

function parseAnnotationComment(lines: ReadonlyArray<string>): string {
  const inlineCommentIndex = lines.findIndex((line) => line.startsWith("Comment: "));
  if (inlineCommentIndex >= 0) {
    const commentLines = [lines[inlineCommentIndex]!.slice("Comment: ".length)];
    for (const line of lines.slice(inlineCommentIndex + 1)) {
      if (
        line.startsWith("Targets: ") ||
        line === "Callouts:" ||
        line === "Requested visual changes:" ||
        line === PREVIEW_SCREENSHOT_LINE ||
        line === IMAGE_SCREENSHOT_LINE ||
        line === "<element_context>"
      ) {
        break;
      }
      commentLines.push(line);
    }
    return unescapeAnnotationSentinels(commentLines.join("\n").trim());
  }
  const headingIndex = lines.indexOf("Comment:");
  if (headingIndex < 0) return "";
  const commentLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (!line.startsWith("  ")) break;
    commentLines.push(line.slice(2));
  }
  return unescapeAnnotationSentinels(commentLines.join("\n").trim());
}

export function extractTrailingPreviewAnnotation(prompt: string): ExtractedPreviewAnnotation {
  const match = TRAILING_PREVIEW_ANNOTATION_BLOCK_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, annotation: null };
  const body = match[1] ?? "";
  const lines = body.split("\n");
  const pageLine = lines.find((line) => line.startsWith("Page: "));
  const idLine = lines.find((line) => line.startsWith("Id: "));
  const targetsLine = lines.find((line) => line.startsWith("Targets: "));
  const styleHeadingIndex = lines.indexOf("Requested visual changes:");
  const linesAfterStyleHeading = lines.slice(styleHeadingIndex + 1);
  const elementContextIndex = linesAfterStyleHeading.indexOf("<element_context>");
  const styleChanges =
    styleHeadingIndex < 0
      ? []
      : linesAfterStyleHeading
          .slice(0, elementContextIndex < 0 ? undefined : elementContextIndex)
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2));
  const callouts = parseCallouts(lines);
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    annotation: {
      id:
        unescapeAnnotationSentinels(idLine?.slice("Id: ".length).trim() ?? "") || `${match.index}`,
      title:
        unescapeAnnotationSentinels(pageLine?.slice("Page: ".length).trim() ?? "") ||
        "Preview annotation",
      comment: parseAnnotationComment(lines),
      targetSummary: targetsLine?.slice("Targets: ".length).trim() || "",
      styleChanges: styleChanges.map(unescapeAnnotationSentinels),
      hasScreenshot: body.includes(PREVIEW_SCREENSHOT_LINE) || body.includes(IMAGE_SCREENSHOT_LINE),
      calloutCount: callouts.length,
      callouts,
    },
  };
}

export function extractTrailingPreviewAnnotations(prompt: string): ExtractedPreviewAnnotations {
  const annotations: ParsedPreviewAnnotation[] = [];
  let promptText = prompt;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(promptText);
    if (!extracted.annotation) break;
    annotations.unshift(extracted.annotation);
    promptText = extracted.promptText;
  }
  return { promptText, annotations };
}
