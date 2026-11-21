import { modelPreviewFormat, type ModelPreviewFormat } from "@t3tools/shared/filePreview";

/**
 * The page the mobile app opens in a WebView to orbit one 3D file with touch. It needs no T3
 * session: the fragment names a signed download URL on this origin, so it never connects to an
 * environment.
 */
export const MODEL_VIEWER_PAGE_PATH = "/model-viewer";

export function isModelViewerPage(): boolean {
  return window.location.pathname === MODEL_VIEWER_PAGE_PATH;
}

export interface ModelViewerPageParams {
  readonly src: string;
  readonly name: string;
  readonly format: ModelPreviewFormat;
  readonly appearance: "light" | "dark" | null;
}

/**
 * Reads `#src=<url>&name=<file name>&appearance=<light|dark>`. The fragment keeps the signed URL
 * out of server logs. Only same-origin URLs are accepted, and the format comes from the name; for a
 * `.blend` file the URL serves its exported geometry.
 */
export function readModelViewerPageParams(location: {
  readonly hash: string;
  readonly origin: string;
}): ModelViewerPageParams | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const name = params.get("name") ?? "";
  const format = modelPreviewFormat(name);
  let src: URL;
  try {
    src = new URL(params.get("src") ?? "", location.origin);
  } catch {
    return null;
  }
  if (src.origin !== location.origin || format === null) return null;
  const appearance = params.get("appearance");
  return {
    src: src.href,
    name,
    format,
    appearance: appearance === "light" || appearance === "dark" ? appearance : null,
  };
}
