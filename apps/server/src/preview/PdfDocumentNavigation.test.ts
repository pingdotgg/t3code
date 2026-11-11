import type { CDPSession } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import { installPdfDocumentNavigation } from "./PdfDocumentNavigation.ts";

const source = "https://environment.test/api/assets/signed-token/files/Study%20guide.PDF";

function fixture(nativePdfViewer = false) {
  const completed = Promise.withResolvers<{ method: string; params: Record<string, unknown> }>();
  let paused: (event: {
    requestId: string;
    frameId: string;
    request: { url: string; method: string };
    responseStatusCode: number | undefined;
    responseHeaders: Array<{ name: string; value: string }>;
  }) => void = () => {
    throw new Error("Navigation handler was not installed");
  };
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "Runtime.evaluate") return { result: { value: nativePdfViewer } };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (
      method === "Fetch.fulfillRequest" ||
      method === "Fetch.continueRequest" ||
      method === "Fetch.failRequest"
    ) {
      completed.resolve({ method, params });
    }
    return {};
  });
  const cdp = {
    send,
    on: (_name: string, listener: typeof paused) => {
      paused = listener;
    },
  } as unknown as CDPSession;
  return {
    cdp,
    send,
    navigate: (
      url = source,
      frameId = "main",
      method = "GET",
      status: number | null = 200,
      contentType = "application/pdf",
    ) => {
      paused({
        requestId: "request-1",
        frameId,
        request: { url, method },
        responseStatusCode: status ?? undefined,
        responseHeaders: [{ name: "Content-Type", value: contentType }],
      });
      return completed.promise;
    },
  };
}

describe("PDF document navigation", () => {
  it("escapes filenames in the browser document", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp, { handleAuthRequests: false });
    const result = await test.navigate(
      "https://environment.test/api/assets/token/%3Cscript%3E.pdf",
    );
    expect(Buffer.from(String(result.params.body), "base64").toString()).toContain(
      "<title>&lt;script>.pdf</title>",
    );
  });

  it("still commits PDF documents while every document also pauses for auth", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp, { handleAuthRequests: true });
    expect(test.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/assets/*", resourceType: "Document", requestStage: "Response" },
        { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
      ],
      handleAuthRequests: true,
    });
    // The request-stage pause of the same PDF has no response yet and must go on.
    const requestStage = fixture();
    await installPdfDocumentNavigation(requestStage.cdp, { handleAuthRequests: true });
    expect(await requestStage.navigate(source, "main", "GET", null)).toEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "request-1" },
    });
    expect((await test.navigate()).method).toBe("Fetch.fulfillRequest");
  });

  it("resumes navigation when committing the document fails", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp, { handleAuthRequests: false });
    test.send.mockRejectedValueOnce(new Error("Tab closed"));
    expect(await test.navigate()).toEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "request-1" },
    });
  });
});
