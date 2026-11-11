import { readFile } from "node:fs/promises";
import { rolldown } from "rolldown";
import { describe, expect, it } from "vitest";
import { createMiniflareFromRolldown } from "../../../../cloudflare-test-tools/src/miniflare/miniflare.ts";
import cloudflare from "../plugin.ts";
import { buildFixture } from "./utils/build-fixture.ts";
import { getAsset, getEntryChunk } from "./utils/output.ts";

const fixture = "module-rules/index.ts";
const ttf = { type: "Data" as const, test: (path: string) => path.endsWith(".ttf") };

describe("module rules", () => {
  it("emits an import matching a user rule as a separate module", async () => {
    const built = await buildFixture({
      fixture,
      pluginOptions: { compatibilityDate: "2025-07-01", moduleRules: [ttf] },
    });
    const asset = getAsset(built.output, /font.*\.ttf$/);
    const font = await readFile(new URL("./fixtures/module-rules/font.ttf", import.meta.url));

    expect(Buffer.from(asset.source as Uint8Array)).toEqual(font);
    expect(getEntryChunk(built.output).code).toContain(asset.fileName);
  });

  it("uploads a match as its rule's type", async () => {
    const built = await buildFixture({
      fixture,
      pluginOptions: { compatibilityDate: "2025-07-01", moduleRules: [{ ...ttf, type: "Text" }] },
    });
    expect(getAsset(built.output, /font.*\.txt$/)).toBeDefined();
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchJson("/")).toEqual({ type: "[object String]" });
  });

  it("keeps identical files of different types apart", async () => {
    const built = await buildFixture({
      fixture: "module-rules-dedupe/index.ts",
      pluginOptions: {
        compatibilityDate: "2025-07-01",
        moduleRules: [{ type: "Text", test: (path) => path.endsWith(".md") }],
      },
    });
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchJson("/")).toEqual({
      text: "[object String]",
      data: "[object ArrayBuffer]",
    });
  });

  it("leaves an unmatched extension to rolldown", async () => {
    await expect(buildFixture({ fixture })).rejects.toThrow(/font\.ttf/);
  });

  it("leaves query imports to their own plugins", async () => {
    const built = await buildFixture({
      fixture: "additional-modules/index.ts",
      pluginOptions: {
        compatibilityDate: "2025-07-01",
        moduleRules: [{ test: () => true }],
      },
    });
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(await miniflare.fetchJson<{ result: number }>("/wasm-with-init-param")).toEqual({
      result: 15,
    });
    expect(await miniflare.fetchJson<{ result: number }>("/wasm-with-module-param")).toEqual({
      result: 11,
    });
  });

  it("leaves virtual modules resolved by later plugins alone", async () => {
    // Resolves after the Cloudflare plugins, so `additionalModulesPlugin`
    // sees the virtual id from `this.resolve`.
    const bundle = await rolldown({
      input: "test/fixtures/module-rules/index.ts",
      plugins: [
        cloudflare({ compatibilityDate: "2025-07-01", moduleRules: [ttf] }),
        {
          name: "virtual-font",
          resolveId: (id) => (id === "./font.ttf" ? "\0virtual-font.txt" : undefined),
          load: (id) =>
            id === "\0virtual-font.txt" ? "export default new ArrayBuffer(3);" : undefined,
        },
      ],
    });
    const { output } = await bundle.generate({ format: "esm" });
    await bundle.close();

    expect(output.some((item) => item.type === "asset" && !item.fileName.endsWith(".map"))).toBe(
      false,
    );
    expect(output[0].code).toContain("ArrayBuffer(3)");
  });
});
