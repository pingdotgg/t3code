import type { PreviewAnnotationPayload } from "@t3tools/contracts";

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
