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
    responseStatusCode: number;
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
      status = 200,
      contentType = "application/pdf",
    ) => {
      paused({
        requestId: "request-1",
        frameId,
        request: { url, method },
        responseStatusCode: status,
        responseHeaders: [{ name: "Content-Type", value: contentType }],
      });
      return completed.promise;
    },
  };
}

describe("PDF document navigation", () => {
  it("keeps native PDF rendering when the browser supports it", async () => {
    const test = fixture(true);
    await installPdfDocumentNavigation(test.cdp);
    expect(test.send.mock.calls.map(([method]) => method)).toEqual(["Runtime.evaluate"]);
  });

  it("commits the PDF URL for client rendering without redirects or server-side PDF rendering", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    const { method, params } = await test.navigate();
    expect(method).toBe("Fetch.fulfillRequest");
    expect(params).toMatchObject({ responseCode: 200, requestId: "request-1" });
    expect(params.responseHeaders).toEqual([
      { name: "Content-Type", value: "text/html; charset=utf-8" },
      { name: "Cache-Control", value: "no-store" },
      { name: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
      { name: "X-Content-Type-Options", value: "nosniff" },
    ]);
    expect(Buffer.from(String(params.body), "base64").toString()).toBe(
      "<!doctype html><html><head><title>Study guide.PDF</title></head><body><h1>Study guide.PDF</h1><p>This PDF is displayed in the connected client.</p></body></html>",
    );
    expect(test.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/assets/*", resourceType: "Document", requestStage: "Response" },
      ],
    });
  });

  it.each([401, 403, 404, 410, 500])(
    "fails unavailable PDF assets with HTTP %s",
    async (status) => {
      const test = fixture();
      await installPdfDocumentNavigation(test.cdp);
      expect(await test.navigate(source, "main", "GET", status)).toEqual({
        method: "Fetch.failRequest",
        params: { requestId: "request-1", errorReason: "Failed" },
      });
      expect(test.send.mock.calls.some(([method]) => method === "Fetch.fulfillRequest")).toBe(
        false,
      );
    },
  );

  it("rejects a non-PDF response instead of committing a successful PDF tab", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    expect(await test.navigate(source, "main", "GET", 200, "text/html")).toMatchObject({
      method: "Fetch.failRequest",
    });
  });

  it("allows redirects to reach their asset response", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    expect(await test.navigate(source, "main", "GET", 302)).toMatchObject({
      method: "Fetch.continueRequest",
    });
  });

  it("accepts a partial PDF response", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    expect(
      await test.navigate(source, "main", "GET", 206, "Application/PDF; charset=binary"),
    ).toMatchObject({
      method: "Fetch.fulfillRequest",
    });
  });

  it.each([
    ["https://environment.test/api/assets/token/index.html", "main", "GET"],
    ["https://example.com/paper.pdf", "main", "GET"],
    [source, "subframe", "GET"],
    [source, "main", "POST"],
  ])("leaves other browser requests alone: %s, %s, %s", async (url, frameId, method) => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    expect(await test.navigate(url, frameId, method)).toEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "request-1" },
    });
  });

  it("escapes filenames in the browser document", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    const result = await test.navigate(
      "https://environment.test/api/assets/token/%3Cscript%3E.pdf",
    );
    expect(Buffer.from(String(result.params.body), "base64").toString()).toContain(
      "<title>&lt;script>.pdf</title>",
    );
  });

  it("resumes navigation when committing the document fails", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    test.send.mockRejectedValueOnce(new Error("Tab closed"));
    expect(await test.navigate()).toEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "request-1" },
    });
  });
});
