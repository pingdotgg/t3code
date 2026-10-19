import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  dispose: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./attachmentDownload", () => ({ downloadAttachmentForPreview: mocks.download }));
vi.mock("expo-file-system", () => ({
  File: class {
    open() {
      return { readBytes: mocks.read, close: mocks.close };
    }
  },
  FileMode: { ReadOnly: "r" },
}));

import { isPdfPreviewUri, pdfInitialPage, pdfLinkUrl, preparePdfPreview } from "./pdfPreview";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.download.mockResolvedValue({ uri: "file:///cache/preview.pdf", dispose: mocks.dispose });
  mocks.read.mockResolvedValue(new TextEncoder().encode("%PDF-"));
});

describe("PDF navigation", () => {
  it("resolves web links against the original PDF rather than its download cache", () => {
    expect(
      pdfLinkUrl("../next.pdf#page=2", "https://environment.test/api/assets/token/files/a.pdf"),
    ).toBe("https://environment.test/api/assets/token/next.pdf#page=2");
    expect(pdfLinkUrl("https://example.com/?q=one#section", "file:///cache/preview.pdf")).toBe(
      "https://example.com/?q=one#section",
    );
  });

  it.each([
    "",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///private/a.pdf",
    "intent://open",
    "https://[",
  ])("ignores unsupported or invalid PDF links: %s", (href) => {
    expect(pdfLinkUrl(href, "https://environment.test/a.pdf")).toBeNull();
  });

  it("recognizes signed PDF links with queries and page fragments", () => {
    expect(
      isPdfPreviewUri("https://environment.test/api/assets/token/Syllabus.PDF?x=1#page=8"),
    ).toBe(true);
    expect(isPdfPreviewUri("file:///local/document.pdf")).toBe(true);
    expect(isPdfPreviewUri("https://environment.test/index.html?file=syllabus.pdf")).toBe(false);
    expect(isPdfPreviewUri("invalid")).toBe(false);
  });

  it("keeps valid page destinations and rejects invalid page numbers", () => {
    expect(pdfInitialPage("https://environment.test/a.pdf#page=8&zoom=100")).toBe(8);
    for (const fragment of [
      "",
      "#page=0",
      "#page=-2",
      "#page=1.5",
      "#page=NaN",
      "#page=Infinity",
    ]) {
      expect(pdfInitialPage(`file:///a.pdf${fragment}`)).toBe(1);
    }
  });
});

describe("preparing native PDFs", () => {
  it("downloads from the selected environment without sending the page fragment", async () => {
    const signal = new AbortController().signal;
    const result = await preparePdfPreview("https://remote.test/a.pdf?token=secret#page=8", signal);
    expect(mocks.download).toHaveBeenCalledWith({
      url: "https://remote.test/a.pdf?token=secret",
      attachment: { name: "preview.pdf", mimeType: "application/pdf" },
      signal,
    });
    expect(result?.uri).toBe("file:///cache/preview.pdf");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.dispose).not.toHaveBeenCalled();
    result?.dispose();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("rejects an HTML response and removes the download", async () => {
    mocks.read.mockResolvedValue(new TextEncoder().encode("<html"));
    await expect(
      preparePdfPreview("https://remote.test/a.pdf", new AbortController().signal),
    ).rejects.toThrow("did not return a PDF");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("closes and removes the cached file when reading fails", async () => {
    mocks.read.mockRejectedValue(new Error("read failed"));
    await expect(
      preparePdfPreview("https://remote.test/a.pdf", new AbortController().signal),
    ).rejects.toThrow("read failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("opens local files without downloading or deleting the caller's file", async () => {
    const result = await preparePdfPreview(
      "file:///draft.pdf#page=3",
      new AbortController().signal,
    );
    expect(result?.uri).toBe("file:///draft.pdf");
    result?.dispose();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it("removes a download if the preview is dismissed during validation", async () => {
    const controller = new AbortController();
    mocks.read.mockImplementation(async () => {
      controller.abort();
      return new TextEncoder().encode("%PDF-");
    });
    expect(await preparePdfPreview("https://remote.test/a.pdf", controller.signal)).toBeNull();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("does no work for an already dismissed preview", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await preparePdfPreview("https://remote.test/a.pdf", controller.signal)).toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
