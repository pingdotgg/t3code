import { isCompoundOfficeFile } from "./officeEncryptedStreams";
import { previewUnlock } from "./previewUnlock";
import { boundedArchive, prepareOffice } from "./officeArchive";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";
import type { OfficeWorkerRequest, OfficeWorkerResult } from "./officePreviewProtocol";
import type { openEpub } from "./epubPreview";
import { PreviewError, previewFailure } from "./previewFailure";

let epub: Awaited<ReturnType<typeof openEpub>> | undefined;
let pendingEpubPage: number | undefined;
let renderingEpub = false;
let epubAssets: string[] = [];
let workbook: string[][][] = [];
function reply(result: OfficeWorkerResult) {
  self.postMessage(result, { transfer: "bytes" in result ? [result.bytes] : [] });
}
async function handle(input: Exclude<OfficeWorkerRequest, { type: "unlock" }>, password?: string) {
  if (input.type === "epub-page") {
    const book = epub;
    if (!book) throw new PreviewError({ code: "epub-no-chapters" });
    pendingEpubPage = input.index;
    if (renderingEpub) return;
    renderingEpub = true;
    try {
      while (pendingEpubPage !== undefined) {
        const index = pendingEpubPage;
        pendingEpubPage = undefined;
        const result = await book
          .page(index)
          .catch((cause: unknown) => previewFailure(cause, "parse-failed"));
        if (pendingEpubPage !== undefined && pendingEpubPage !== index) {
          if ("assets" in result) for (const url of result.assets) URL.revokeObjectURL(url);
          continue;
        }
        for (const url of epubAssets) URL.revokeObjectURL(url);
        if ("assets" in result) {
          const { assets, ...page } = result;
          epubAssets = assets;
          reply({ type: "epub-page", index, result: page });
        } else {
          epubAssets = [];
          reply({ type: "epub-page", index, result });
        }
        pendingEpubPage = undefined;
      }
    } finally {
      renderingEpub = false;
    }
    return;
  }
  if (input.type === "sheet-page") {
    const rows = workbook[input.sheet];
    if (!rows) throw new PreviewError({ code: "sheet-unavailable" });
    reply({
      type: "sheet-page",
      sheet: input.sheet,
      index: input.index,
      rows: rows.slice(input.index * PREVIEW_PAGE_ROWS, (input.index + 1) * PREVIEW_PAGE_ROWS),
    });
    return;
  }
  if (input.kind === "docx" || input.kind === "xlsx" || input.kind === "pptx") {
    const bytes = isCompoundOfficeFile(input.bytes)
      ? (await import("./officeEncryption")).decryptOffice(input.bytes, password)
      : input.bytes;
    reply({ type: input.kind, ...(await prepareOffice(bytes, input.kind, password)) });
    return;
  }
  if (input.kind === "epub") {
    const { openEpub } = await import("./epubPreview");
    const { archive } = await boundedArchive(input, password);
    const { page, ...book } = await openEpub(archive);
    epub = { page, ...book };
    reply({ type: "epub", ...book });
    return;
  }
  const { openDocument, openNotebook, openRtf } = await import("./extendedDocumentPreview");
  if (input.kind === "ipynb" || input.kind === "rtf") {
    reply(input.kind === "ipynb" ? openNotebook(input.bytes) : openRtf(input.bytes));
    return;
  }
  const { archive } = await boundedArchive(input, password);
  const { unlockOpenDocument } = await import("./openDocumentEncryption");
  await unlockOpenDocument(archive, password);
  const result = await openDocument(archive, input.kind);
  if (result.type === "ods") {
    workbook = result.sheets.map((sheet) => sheet.rows);
    reply({
      ...result,
      sheets: result.sheets.map((sheet) => ({
        ...sheet,
        rows: sheet.rows.slice(0, PREVIEW_PAGE_ROWS),
      })),
    });
  } else reply(result);
}
const receive = previewUnlock(handle, reply, "parse-failed");
self.addEventListener("message", (event: MessageEvent<OfficeWorkerRequest>) => {
  void receive(event.data);
});
