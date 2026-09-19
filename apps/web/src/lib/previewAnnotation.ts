import type { PreviewAnnotationPayload } from "@t3tools/contracts";

import { dataUrlToFile } from "./imageCompression";

export type PreviewAnnotationCapture =
  /** The crop is ready to attach. */
  | { readonly status: "captured"; readonly file: File }
  /** The pick carried no crop, which is normal for comment-only annotations. */
  | { readonly status: "none" }
  /** The crop could not be decoded. Send the annotation without it. */
  | { readonly status: "failed" };

/** Decode Electron's PNG crop locally; fetching a data URL violates desktop connect-src. */
export function capturePreviewAnnotationScreenshot(
  annotation: PreviewAnnotationPayload,
): PreviewAnnotationCapture {
  if (!annotation.screenshot) return { status: "none" };
  try {
    const { dataUrl } = annotation.screenshot;
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      return { status: "failed" };
    }
    const file = dataUrlToFile(dataUrl, `preview-annotation-${annotation.id}.png`, "image/png");
    return file.size > 0 ? { status: "captured", file } : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}
