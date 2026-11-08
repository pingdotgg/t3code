import { constVoid } from "effect/Function";
import type { CDPSession } from "playwright-core";

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

export const isPdfAssetUrl = (url: string) => {
  const { pathname } = new URL(url);
  return pathname.startsWith("/api/assets/") && /\.pdf$/i.test(pathname);
};

/** Returns where a request this server can serve should load from, or undefined to leave it. */
export type AssetRequestRedirect = (url: string) => Promise<string | undefined>;

// One installer because `Fetch.enable` replaces a session's patterns and every handler sees every pause.
export async function installAssetNavigation(
  cdp: CDPSession,
  redirect: AssetRequestRedirect | null,
) {
  const nativeViewer = await cdp.send("Runtime.evaluate", {
    expression: "navigator.pdfViewerEnabled",
    returnByValue: true,
  });
  const pdfFrameId =
    nativeViewer.result?.value === true
      ? null
      : (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  if (pdfFrameId === null && redirect === null) return;
  cdp.on("Fetch.requestPaused", (event) => {
    const { requestId, request, frameId } = event;
    const proceed = (url?: string) =>
      cdp.send("Fetch.continueRequest", url === undefined ? { requestId } : { requestId, url });
    void (async () => {
      // A pause carries a response status or error only at the response stage.
      if (event.responseStatusCode === undefined && event.responseErrorReason === undefined) {
        await proceed(await redirect?.(request.url));
        return;
      }
      // The shell cannot open PDFs. Commit a document at the original URL so the
      // client can embed its signed bytes while Back and Forward keep working.
      if (request.method !== "GET" || frameId !== pdfFrameId || !isPdfAssetUrl(request.url)) {
        await proceed();
        return;
      }
      const status = event.responseStatusCode;
      if (status === undefined || (status >= 300 && status < 400)) {
        await proceed();
        return;
      }
      const contentType = event.responseHeaders
        ?.find((header) => header.name.toLowerCase() === "content-type")
        ?.value.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (status < 200 || status >= 300 || contentType !== "application/pdf") {
        // Reach the browser's requestfailed path instead of committing a successful PDF tab.
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
        return;
      }
      const name = escapeHtml(
        decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "PDF"),
      );
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
          { name: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
          { name: "X-Content-Type-Options", value: "nosniff" },
        ],
        body: Buffer.from(
          `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1><p>This PDF is displayed in the connected client.</p></body></html>`,
        ).toString("base64"),
      });
    })().catch(() => proceed().catch(constVoid));
  });
  await cdp.send("Fetch.enable", {
    patterns: [
      // Only document navigations pause; the client's PDF fetch gets the original bytes.
      ...(pdfFrameId === null
        ? []
        : [
            {
              urlPattern: "*/api/assets/*",
              resourceType: "Document" as const,
              requestStage: "Response" as const,
            },
          ]),
      ...(redirect === null
        ? []
        : [{ urlPattern: "*/api/assets/*", requestStage: "Request" as const }]),
    ],
  });
}
