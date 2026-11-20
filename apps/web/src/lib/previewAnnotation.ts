import type { PreviewAnnotationPayload } from "@t3tools/contracts";

import { readComposerImageBytes } from "../components/chat/composerAttachmentFiles";
import { type ComposerThreadTarget, useComposerDraftStore } from "../composerDraftStore";
import { dataUrlToFile } from "./imageCompression";

export type PreviewAnnotationCapture =
  | { readonly status: "captured"; readonly file: File }
  | { readonly status: "none" }
  | { readonly status: "failed" };

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** Decode Electron's PNG crop locally; fetching a data URL violates desktop connect-src. */
export function capturePreviewAnnotationScreenshot(
  annotation: PreviewAnnotationPayload,
): PreviewAnnotationCapture {
  if (!annotation.screenshot) return { status: "none" };
  try {
    const { dataUrl } = annotation.screenshot;
    if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
      return { status: "failed" };
    }
    const file = dataUrlToFile(dataUrl, `preview-annotation-${annotation.id}.png`, "image/png");
    return file.size > 0 ? { status: "captured", file } : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

/** Prepares the crop and stages it under the annotation ID before publishing the chip. */
export async function stagePreviewAnnotation(
  target: ComposerThreadTarget,
  picked: PreviewAnnotationPayload,
  { requireScreenshot = false, signal }: { requireScreenshot?: boolean; signal?: AbortSignal } = {},
) {
  const capture = capturePreviewAnnotationScreenshot(picked);
  const screenshot = picked.screenshot;
  let image = null;
  if (capture.status === "captured" && screenshot) {
    const { file } = capture;
    await readComposerImageBytes(file);
    if (signal?.aborted) return null;
    const candidate = {
      type: "image" as const,
      id: picked.id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: screenshot.dataUrl,
      file,
    };
    if (useComposerDraftStore.getState().addImage(target, candidate)) image = candidate;
  }
  if (signal?.aborted || (requireScreenshot && !image)) return null;
  const cropDropped = screenshot !== null && screenshot !== undefined && image === null;
  const annotation = cropDropped ? { ...picked, screenshot: null } : picked;
  useComposerDraftStore.getState().addPreviewAnnotation(target, annotation);
  return { annotation, image, cropDropped };
}
