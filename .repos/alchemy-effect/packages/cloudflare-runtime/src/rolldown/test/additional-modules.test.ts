import { createMiniflareFromRolldown } from "../../../../cloudflare-test-tools/src/miniflare/miniflare.ts";
import { describe, expect, it } from "vitest";
import { buildFixture } from "./utils/build-fixture.ts";
import {
  getAsset,
  getEntryChunk,
  hasCloudflareModuleReferences,
} from "./utils/output.ts";

describe("additional modules", async () => {
  const built = await buildFixture({
    fixture: "additional-modules/index.ts",
  });

  it("supports Data modules with a .bin extension", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(await miniflare.fetchJson<{ byteLength: number }>("/bin")).toEqual({
      byteLength: 342_936,
    });
  });

  it("supports Text modules with .html, .txt, and .sql extensions", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(await miniflare.fetchText("/html")).toBe("<h1>Hello world</h1>\n");
    expect(await miniflare.fetchText("/text")).toBe("Example text content.\n");
    expect(await miniflare.fetchText("/sql")).toBe("SELECT * FROM users;\n");
  });

  it("supports text filenames containing double underscores", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(await miniflare.fetchText("/text2")).toBe(
      "Example text content 2\n",
    );
  });

  it("supports subpath imports for text modules", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    // Removed - see fixtures/additional-modules/index.ts for more details.
    // expect(await miniflare.fetchText("/subpath-html")).toBe("<h1>Hello world</h1>\n");
    expect(await miniflare.fetchText("/subpath-html-with-ext")).toBe(
      "<h1>Hello world</h1>\n",
    );
  });

  it("supports .wasm, .wasm?module, and .wasm?init imports", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(await miniflare.fetchJson<{ result: number }>("/wasm")).toEqual({
      result: 7,
    });
    expect(
      await miniflare.fetchJson<{ result: number }>("/wasm-with-module-param"),
    ).toEqual({
      result: 11,
    });
    expect(
      await miniflare.fetchJson<{ result: number }>("/wasm-with-init-param"),
    ).toEqual({
      result: 15,
    });
  });

  it("rewrites Cloudflare module sentinels into emitted asset paths", () => {
    const entry = getEntryChunk(built.output);

    expect(hasCloudflareModuleReferences(entry.code)).toBe(false);

    const binAsset = getAsset(built.output, /bin-example.*\.bin$/);
    const htmlAsset = getAsset(built.output, /html-example.*\.html$/);
    const textAsset = getAsset(built.output, /text-example.*\.txt$/);
    const text2Asset = getAsset(built.output, /text__example__2.*\.txt$/);
    const sqlAsset = getAsset(built.output, /sql-example.*\.sql$/);
    const wasmAsset = getAsset(built.output, /wasm-example.*\.wasm$/);

    expect(entry.code).toContain(binAsset.fileName);
    expect(entry.code).toContain(htmlAsset.fileName);
    expect(entry.code).toContain(textAsset.fileName);
    expect(entry.code).toContain(text2Asset.fileName);
    expect(entry.code).toContain(sqlAsset.fileName);
    expect(entry.code).toContain(wasmAsset.fileName);
  });
});
