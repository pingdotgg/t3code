import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { buildElementContextBlock, normalizeElementContextSelection } from "./elementContext";
import { dataUrlToFile } from "./imageCompression";

const TRAILING_PREVIEW_ANNOTATION_BLOCK_PATTERN =
  /\n*<preview_annotation>\n((?:(?!<preview_annotation>)[\s\S])*)\n<\/preview_annotation>\s*$/;

export interface ParsedPreviewAnnotation {
  id: string;
  title: string;
  comment: string;
  targetSummary: string;
  styleChanges: string[];
  hasScreenshot: boolean;
}

export interface ExtractedPreviewAnnotation {
  promptText: string;
  annotation: ParsedPreviewAnnotation | null;
}

export function buildPreviewAnnotationPrompt(annotation: PreviewAnnotationPayload): string {
  const lines = ["Preview annotation:"];
  lines.push(`Id: ${annotation.id}`);
  const title = annotation.pageTitle?.trim() || annotation.pageUrl.trim() || "Preview";
  lines.push(`Page: ${title}`);
  if (annotation.comment.trim()) lines.push(`Comment: ${annotation.comment.trim()}`);
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
  if (annotation.strokes.length > 0) {
    targets.push(
      `${annotation.strokes.length} drawing${annotation.strokes.length === 1 ? "" : "s"}`,
    );
  }
  if (targets.length > 0) lines.push(`Targets: ${targets.join(", ")}.`);
  if (annotation.styleChanges.length > 0) {
    lines.push("Requested visual changes:");
    for (const change of annotation.styleChanges) {
      lines.push(`- ${change.property}: ${change.previousValue || "(unset)"} → ${change.value}`);
    }
  }
  if (annotation.screenshot) {
    lines.push("The attached screenshot is the annotated preview crop.");
  }
  const elementContexts = annotation.elements
    .map((target) => normalizeElementContextSelection(target.element))
    .filter((context) => context !== null);
  const elementBlock = buildElementContextBlock(elementContexts);
  if (elementBlock) lines.push(elementBlock);
  return ["<preview_annotation>", ...lines, "</preview_annotation>"].join("\n");
}

export function appendPreviewAnnotationPrompt(
  prompt: string,
  annotation: PreviewAnnotationPayload,
): string {
  const annotationText = buildPreviewAnnotationPrompt(annotation);
  const trimmed = prompt.trim();
  return trimmed ? `${trimmed}\n\n${annotationText}` : annotationText;
}

export function extractTrailingPreviewAnnotation(prompt: string): ExtractedPreviewAnnotation {
  const match = TRAILING_PREVIEW_ANNOTATION_BLOCK_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, annotation: null };
  const body = match[1] ?? "";
  const lines = body.split("\n");
  const pageLine = lines.find((line) => line.startsWith("Page: "));
  const idLine = lines.find((line) => line.startsWith("Id: "));
  const commentLine = lines.find((line) => line.startsWith("Comment: "));
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
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    annotation: {
      id: idLine?.slice("Id: ".length).trim() || `${match.index}`,
      title: pageLine?.slice("Page: ".length).trim() || "Preview annotation",
      comment: commentLine?.slice("Comment: ".length).trim() || "",
      targetSummary: targetsLine?.slice("Targets: ".length).trim() || "",
      styleChanges,
      hasScreenshot: body.includes("The attached screenshot is the annotated preview crop."),
    },
  };
}

const BASE64_DATA_URL_PATTERN = /^data:([^;,]*);base64,/;

/**
 * Decodes the captured crop in place rather than `fetch`ing its data URL. The
 * desktop renderer is served over a custom scheme whose CSP allows `data:` for
 * `img-src` but not for `connect-src`, so a fetch is blocked there and the
 * screenshot never reaches the composer. Returns null when the crop is missing
 * or is not a base64 data URL; callers must then drop the annotation's
 * screenshot so the prompt does not advertise an attachment that never landed.
 */
export function previewAnnotationScreenshotFile(annotation: PreviewAnnotationPayload): File | null {
  if (!annotation.screenshot) return null;
  const { dataUrl } = annotation.screenshot;
  const match = BASE64_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) return null;
  return dataUrlToFile(dataUrl, `preview-annotation-${annotation.id}.png`, match[1] || "image/png");
}
