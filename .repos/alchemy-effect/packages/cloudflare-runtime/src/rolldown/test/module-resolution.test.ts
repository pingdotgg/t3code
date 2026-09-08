import { createMiniflareFromRolldown } from "../../../../cloudflare-test-tools/src/miniflare/miniflare.ts";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixture } from "./utils/build-fixture.ts";

describe("module resolution", async () => {
  const built = await buildFixture({
    fixture: "module-resolution/index.ts",
    inputOptions: {
      resolve: {
        alias: {
          "@alias/test": path.resolve(
            "test/fixtures/module-resolution/aliasing.ts",
          ),
        },
      },
    },
  });

  it("supports package exports and subpath exports", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(
      await miniflare.fetchJson<{ packageMessage: string }>("/package-export"),
    ).toEqual({
      packageMessage: "package export",
    });
    expect(
      await miniflare.fetchJson<{ featureMessage: string }>("/package-subpath"),
    ).toEqual({
      featureMessage: "package subpath",
    });
  });

  it("resolves packages that rely on mainFields when no exports map is present", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(
      await miniflare.fetchJson<{ legacyMessage: string }>(
        "/package-main-fields",
      ),
    ).toEqual({
      legacyMessage: "browser field",
    });
  });

  it("supports explicit and extensionless resolution for js and cjs modules", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(
      await miniflare.fetchJson<{ helloWorldExt: string }>("/require-ext"),
    ).toEqual({
      helloWorldExt: "hello (.js) world (.cjs)",
    });
    expect(
      await miniflare.fetchJson<{ helloWorldNoExt: string }>("/require-no-ext"),
    ).toEqual({
      helloWorldNoExt: "hello (.js) world (.cjs)",
    });
  });

  it("coexists with user aliases", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(await miniflare.fetchText("/@alias/test")).toBe("OK!");
  });
});
