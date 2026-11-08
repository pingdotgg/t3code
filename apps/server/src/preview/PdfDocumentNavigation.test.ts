import type { CDPSession } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import { installAssetNavigation } from "./PdfDocumentNavigation.ts";

const source = "https://environment.test/api/assets/signed-token/files/Study%20guide.PDF";

function fixture(nativePdfViewer = false) {
  const completed = Promise.withResolvers<{ method: string; params: Record<string, unknown> }>();
  let paused: (event: {
    requestId: string;
    frameId: string;
    request: { url: string; method: string };
    responseStatusCode?: number;
    responseHeaders?: Array<{ name: string; value: string }>;
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
    request: (url: string) => {
      paused({ requestId: "request-1", frameId: "main", request: { url, method: "GET" } });
      return completed.promise;
    },
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
  it("escapes filenames in the browser document", async () => {
    const test = fixture();
    await installAssetNavigation(test.cdp, null);
    const result = await test.navigate(
      "https://environment.test/api/assets/token/%3Cscript%3E.pdf",
    );
    expect(Buffer.from(String(result.params.body), "base64").toString()).toContain(
      "<title>&lt;script>.pdf</title>",
    );
  });

  it("resumes navigation when committing the document fails", async () => {
    const test = fixture();
    await installAssetNavigation(test.cdp, null);
    test.send.mockRejectedValueOnce(new Error("Tab closed"));
    expect(await test.navigate()).toEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "request-1" },
    });
  });

  it("keeps committing PDF documents while asset requests are redirected", async () => {
    const test = fixture();
    await installAssetNavigation(test.cdp, async () => undefined);
    expect(test.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/assets/*", resourceType: "Document", requestStage: "Response" },
        { urlPattern: "*/api/assets/*", requestStage: "Request" },
      ],
    });
    expect((await test.navigate()).method).toBe("Fetch.fulfillRequest");
  });

  it("continues a request unchanged when its redirect fails", async () => {
    const test = fixture(true);
    const redirect = vi.fn(async () => {
      throw new Error("Signing key unavailable");
    });
    await installAssetNavigation(test.cdp, redirect);
    expect(test.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "*/api/assets/*", requestStage: "Request" }],
    });
    expect(await test.request(source)).toEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "request-1" },
    });
    expect(redirect).toHaveBeenCalledWith(source);
  });
});
