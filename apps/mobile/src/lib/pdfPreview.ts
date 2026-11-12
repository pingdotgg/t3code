import { downloadAttachmentForPreview } from "./attachmentDownload";

export function isPdfPreviewUri(uri: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(uri).pathname);
  } catch {
    return false;
  }
}

export function pdfInitialPage(uri: string): number {
  const page = Number(new URLSearchParams(uri.split("#", 2)[1]).get("page"));
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function pdfLinkUrl(href: string, sourceUri: string): string | null {
  if (href.trim().length === 0) return null;
  try {
    const url = new URL(href, sourceUri);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export async function preparePdfPreview(uri: string, signal: AbortSignal) {
  if (signal.aborted) return null;
  const source = uri.split("#", 1)[0]!;
  const cached = /^(file|content):/.test(source)
    ? { uri: source, dispose: () => {} }
    : await downloadAttachmentForPreview({
        url: source,
        attachment: { name: "preview.pdf", mimeType: "application/pdf" },
        signal,
      });
  if (cached === null) return null;
  try {
    const { File, FileMode } = await import("expo-file-system");
    const handle = new File(cached.uri).open(FileMode.ReadOnly);
    try {
      const header = await handle.readBytes(5);
      if (String.fromCharCode(...header) !== "%PDF-") {
        throw new Error("The server did not return a PDF. Check the connection and try again.");
      }
    } finally {
      handle.close();
    }
    if (signal.aborted) {
      cached.dispose();
      return null;
    }
    return cached;
  } catch (error) {
    cached.dispose();
    if (signal.aborted) return null;
    throw error;
  }
}
