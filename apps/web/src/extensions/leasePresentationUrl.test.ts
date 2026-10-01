import { describe, expect, it } from "vite-plus/test";

import { resolveLeasePresentationUrl } from "./leasePresentationUrl";

const mint = { id: "t3.resources/lease", method: "createPresentationUrl" };
const minted = (kind: string) => ({
  url: "/api/assets/eyJ2.sig/doc.pdf",
  expiresAt: 1_700_000_000_000,
  kind,
});

describe("resolveLeasePresentationUrl", () => {
  it("resolves a minted workspace file against the environment, not the renderer origin", () => {
    // Desktop's renderer is t3code://app; a relative URL there 404s.
    expect(
      resolveLeasePresentationUrl(mint, minted("workspace-file"), "http://127.0.0.1:47951/"),
    ).toEqual({
      ...minted("workspace-file"),
      url: "http://127.0.0.1:47951/api/assets/eyJ2.sig/doc.pdf",
    });
    expect(
      resolveLeasePresentationUrl(
        mint,
        minted("workspace-file-exact"),
        "https://box.tailnet.ts.net/",
      ),
    ).toMatchObject({ url: "https://box.tailnet.ts.net/api/assets/eyJ2.sig/doc.pdf" });
  });

  it("leaves browser-surface claims and other APIs in the server's form", () => {
    const surface = minted("browser-surface");
    expect(resolveLeasePresentationUrl(mint, surface, "http://127.0.0.1:47951/")).toBe(surface);
    const other = { url: "/api/assets/x/y" };
    expect(
      resolveLeasePresentationUrl(
        { id: "t3.resources/lease", method: "getCapabilities" },
        other,
        "http://127.0.0.1:47951/",
      ),
    ).toBe(other);
    expect(
      resolveLeasePresentationUrl(
        { id: "t3.other/api", method: "createPresentationUrl" },
        other,
        "http://127.0.0.1:47951/",
      ),
    ).toBe(other);
  });
});
