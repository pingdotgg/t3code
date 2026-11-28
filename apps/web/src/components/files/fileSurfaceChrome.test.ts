import { afterEach, expect, it, vi } from "vite-plus/test";

import { saveAssetDownload } from "./fileSurfaceChrome";

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("buffers desktop downloads into a blob so the app scheme never navigates away", async () => {
  const fetchSpy = vi.fn(async () => new Response(new Uint8Array([4, 5, 6])));
  vi.stubGlobal("fetch", fetchSpy);
  const clicked: Array<{ href: string; download: string }> = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const anchor = {
        href: "",
        download: "",
        click: () => clicked.push({ href: anchor.href, download: anchor.download }),
      };
      return anchor;
    },
  });

  await saveAssetDownload({
    prepareUrl: async () => "https://example.test/api/assets/download/report.pdf",
    fileName: "docs/report.pdf",
    unavailableMessage: "unavailable",
    loadFailedMessage: "failed",
  });

  expect(fetchSpy).toHaveBeenCalledWith("https://example.test/api/assets/download/report.pdf");
  expect(clicked).toHaveLength(1);
  expect(clicked[0]!.href.startsWith("blob:")).toBe(true);
  expect(clicked[0]!.download).toBe("report.pdf");
});
