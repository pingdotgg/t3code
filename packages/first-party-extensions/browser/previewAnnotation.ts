/**
 * Preview-annotation prompt payload — the package port of the native
 * previewAnnotation module (binding table row #34). Shapes
 * the element-pick/region/stroke/style annotation into the
 * `<preview_annotation>` composer block, plus the bounded screenshot-crop
 * attachment path. The transport consumer (element pick op +
 * `t3.composer/context`) is a later slice; this module is pure and does not
 * depend on any host machinery.
 */
import type { PreviewAnnotationPayload } from "@t3tools/contracts";

import {
  buildElementContextBlock,
  type ElementContextSelection,
  normalizeElementContextSelection,
} from "./elementContext.ts";

/**
 * Bounds the native module never needed: the payload crosses a boundary we
 * don't control (the picker), so every string field is char-clamped, the
 * repeated groups are count-capped, and the serialized prompt is capped in
 * bytes — measured exactly as the SDK envelope measures it:
 * `TextEncoder().encode(JSON.stringify(prompt))`. JSON escaping inflates
 * quotes, backslashes, and control characters up to 6×, so measuring the
 * raw text would let "fitting" prompts still be rejected by `copyJson`.
 * Element contexts are dropped last-to-first until the block fits; if even
 * the bounded head overflows, the body is truncated against the serialized
 * size. Both `<preview_annotation>` delimiters — and any included
 * `<element_context>` block — are always preserved whole.
 */
export const PREVIEW_ANNOTATION_ID_MAX_CHARS = 256;
export const PREVIEW_ANNOTATION_PAGE_MAX_CHARS = 2_048;
export const PREVIEW_ANNOTATION_COMMENT_MAX_CHARS = 8_000;
export const PREVIEW_ANNOTATION_STYLE_CHANGES_MAX = 32;
export const PREVIEW_ANNOTATION_STYLE_FIELD_MAX_CHARS = 256;
export const PREVIEW_ANNOTATION_CONTEXT_ELEMENTS_MAX = 16;
export const PREVIEW_ANNOTATION_PROMPT_MAX_BYTES = 56_000;

const annotationByteEncoder = new TextEncoder();
/** The unit the SDK envelope enforces: UTF-8 bytes of the escaped JSON. */
const serializedByteLength = (value: string): number =>
  annotationByteEncoder.encode(JSON.stringify(value)).length;

const clampChars = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/**
 * Largest body prefix whose *serialized* prompt fits the byte cap — a
 * binary search, since escaping makes per-character cost variable (up to
 * 6× for control chars). Only ever called when the head alone overflows,
 * so the returned body always ends with "…".
 */
function truncateBodyToSerializedFit(body: string): string {
  const render = (inner: string) => `<preview_annotation>\n${inner}\n</preview_annotation>`;
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (
      serializedByteLength(render(`${body.slice(0, mid)}…`)) <= PREVIEW_ANNOTATION_PROMPT_MAX_BYTES
    ) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${body.slice(0, lo)}…`;
}

function serializePrompt(lines: string[], contexts: ElementContextSelection[]): string {
  const block = buildElementContextBlock(contexts);
  const body = block ? [...lines, block] : lines;
  return ["<preview_annotation>", ...body, "</preview_annotation>"].join("\n");
}

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
  lines.push(`Id: ${clampChars(annotation.id, PREVIEW_ANNOTATION_ID_MAX_CHARS)}`);
  const title = clampChars(
    annotation.pageTitle?.trim() || annotation.pageUrl.trim() || "Preview",
    PREVIEW_ANNOTATION_PAGE_MAX_CHARS,
  );
  lines.push(`Page: ${title}`);
  const comment = clampChars(annotation.comment.trim(), PREVIEW_ANNOTATION_COMMENT_MAX_CHARS);
  if (comment) lines.push(`Comment: ${comment}`);
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
  const styleChanges = annotation.styleChanges.slice(0, PREVIEW_ANNOTATION_STYLE_CHANGES_MAX);
  if (styleChanges.length > 0) {
    lines.push("Requested visual changes:");
    for (const change of styleChanges) {
      lines.push(
        `- ${clampChars(change.property, PREVIEW_ANNOTATION_STYLE_FIELD_MAX_CHARS)}: ` +
          `${clampChars(change.previousValue, PREVIEW_ANNOTATION_STYLE_FIELD_MAX_CHARS) || "(unset)"} → ` +
          clampChars(change.value, PREVIEW_ANNOTATION_STYLE_FIELD_MAX_CHARS),
      );
    }
  }
  if (annotation.screenshot) {
    lines.push("The attached screenshot is the annotated preview crop.");
  }
  const elementContexts = annotation.elements
    .slice(0, PREVIEW_ANNOTATION_CONTEXT_ELEMENTS_MAX)
    .map((target) => normalizeElementContextSelection(target.element))
    .filter((context) => context !== null);
  let contextCount = elementContexts.length;
  let text = serializePrompt(lines, elementContexts.slice(0, contextCount));
  while (contextCount > 0 && serializedByteLength(text) > PREVIEW_ANNOTATION_PROMPT_MAX_BYTES) {
    contextCount -= 1;
    text = serializePrompt(lines, elementContexts.slice(0, contextCount));
  }
  if (serializedByteLength(text) > PREVIEW_ANNOTATION_PROMPT_MAX_BYTES) {
    // Even the bounded head overflowed — only reachable when fields are
    // packed with characters JSON must escape. The head carries no
    // element_context block, so truncating it cannot tear one.
    text = [
      "<preview_annotation>",
      truncateBodyToSerializedFit(lines.join("\n")),
      "</preview_annotation>",
    ].join("\n");
  }
  return text;
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

async function previewAnnotationScreenshotFile(
  annotation: PreviewAnnotationPayload,
): Promise<File | null> {
  if (!annotation.screenshot) return null;
  const response = await fetch(annotation.screenshot.dataUrl);
  const blob = await response.blob();
  return new File([blob], `preview-annotation-${annotation.id}.png`, {
    type: blob.type || "image/png",
  });
}

/** Upper bound on turning a picked element's crop into a composer attachment. */
const PREVIEW_ANNOTATION_CAPTURE_TIMEOUT_MS = 5_000;

export type PreviewAnnotationCapture =
  /** The crop is ready to attach. */
  | { readonly status: "captured"; readonly file: File }
  /** The pick carried no crop, which is normal for comment-only annotations. */
  | { readonly status: "none" }
  /** The crop stalled or threw. Send the annotation without it. */
  | { readonly status: "failed" };

/**
 * Bounded wrapper around `previewAnnotationScreenshotFile`. The picker holds the
 * composer while this runs, so it must always settle: a stalled crop resolves as
 * `failed` instead of leaving the caller waiting.
 */
export async function capturePreviewAnnotationScreenshot(
  annotation: PreviewAnnotationPayload,
  timeoutMs: number = PREVIEW_ANNOTATION_CAPTURE_TIMEOUT_MS,
): Promise<PreviewAnnotationCapture> {
  if (!annotation.screenshot) return { status: "none" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const file = await Promise.race([
      previewAnnotationScreenshotFile(annotation),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return file ? { status: "captured", file } : { status: "failed" };
  } catch {
    return { status: "failed" };
  } finally {
    clearTimeout(timer);
  }
}
