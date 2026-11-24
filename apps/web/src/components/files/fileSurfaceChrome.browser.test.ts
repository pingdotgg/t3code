import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../../test/render";
import { saveAssetDownload } from "./fileSurfaceChrome";

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

it("buffers desktop downloads into a blob so the app scheme never navigates away", async () => {
  const fetchSpy = vi.fn(async () => new Response(new Uint8Array([4, 5, 6])));
  using _fetch = stubGlobal("fetch", fetchSpy);
  const clicked: Array<{ href: string; download: string }> = [];
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
  try {
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
  } finally {
    clickSpy.mockRestore();
  }
});
