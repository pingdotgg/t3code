import { BROWSER_ENGINE_FAVICON_MAX_LENGTH } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { makeBrowserFaviconAssets } from "./faviconAssets.ts";

const png = (body: string) => `data:image/png;base64,${body}`;

describe("browser favicon assets", () => {
  it("content-addresses assets and resolves them only inside their project", () => {
    const assets = makeBrowserFaviconAssets();
    const ref = assets.capture("a", png("AAAA"));
    expect(ref).not.toBeNull();
    expect(assets.capture("a", png("AAAA"))).toBe(ref);
    expect(assets.read("a", ref!)).toBe(png("AAAA"));
    expect(assets.read("b", ref!)).toBeNull();
  });

  it("refuses oversized or non-image bytes", () => {
    const assets = makeBrowserFaviconAssets();
    expect(assets.capture("a", png("A".repeat(BROWSER_ENGINE_FAVICON_MAX_LENGTH)))).toBeNull();
    expect(assets.capture("a", "data:image/svg+xml;base64,AAAA")).toBeNull();
    expect(assets.capture("a", "data:text/html;base64,AAAA")).toBeNull();
    expect(assets.capture("a", "https://example.com/favicon.ico")).toBeNull();
  });

  it("evicts the project's least recently used asset past the per-project cap", () => {
    const assets = makeBrowserFaviconAssets({ perProject: 2, total: 10 });
    const first = assets.capture("a", png("AAAA"))!;
    const second = assets.capture("a", png("BBBB"))!;
    const other = assets.capture("b", png("CCCC"))!;
    // Reading refreshes recency, so the second asset is now the oldest.
    expect(assets.read("a", first)).not.toBeNull();
    assets.capture("a", png("DDDD"));
    expect(assets.read("a", second)).toBeNull();
    expect(assets.read("a", first)).not.toBeNull();
    // Another project's assets never pay for this project's churn.
    expect(assets.read("b", other)).not.toBeNull();
  });

  it("evicts the least recently used asset across projects past the total cap", () => {
    const assets = makeBrowserFaviconAssets({ perProject: 10, total: 2 });
    const first = assets.capture("a", png("AAAA"))!;
    const second = assets.capture("b", png("BBBB"))!;
    assets.capture("c", png("CCCC"));
    expect(assets.read("a", first)).toBeNull();
    expect(assets.read("b", second)).not.toBeNull();
  });
});
