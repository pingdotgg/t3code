import type { PreviewAnnotationPayload } from "@t3tools/contracts";
export {
  appendPreviewAnnotationPrompt,
  buildPreviewAnnotationCopyText,
  buildPreviewAnnotationPrompt,
  extractTrailingPreviewAnnotation,
  extractTrailingPreviewAnnotations,
  type ExtractedPreviewAnnotation,
  type ExtractedPreviewAnnotations,
  type ParsedPreviewAnnotation,
  type ParsedPreviewAnnotationCallout,
} from "@t3tools/client-runtime/annotations";

export async function previewAnnotationScreenshotFile(
  annotation: PreviewAnnotationPayload,
): Promise<File | null> {
  if (!annotation.screenshot) return null;
  const response = await fetch(annotation.screenshot.dataUrl);
  const blob = await response.blob();
  return new File([blob], `preview-annotation-${annotation.id}.png`, {
    type: blob.type || "image/png",
  });
}
