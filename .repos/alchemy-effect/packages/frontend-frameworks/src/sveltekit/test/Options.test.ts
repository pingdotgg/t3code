import { describe, expect, it } from "vitest";
import { fromHarnessOptions, resolveExportTarget } from "../index.ts";

describe("fromHarnessOptions", () => {
  it("maps the shared vite options onto SvelteKit options", () => {
    const bindings = ["text-binding-hook"];
    const options = fromHarnessOptions({
      vite: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          bindings,
          assets: { notFoundHandling: "404-page" },
        },
      },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(options.adapter?.notFoundHandling).toBe("404-page");
    // binding hooks pass through wholesale — the deploy target's dev
    // platform serves them (resource bindings included)
    expect(options.dev?.bindings).toBe(bindings);
  });

  it("prefers the target-scoped carriage over the deprecated vite alias", () => {
    const scoped = ["scoped-binding-hook"];
    const options = fromHarnessOptions({
      target: {
        cloudflare: {
          worker: {
            compatibilityDate: "2026-03-10",
            worker: {
              bindings: scoped,
              assets: { notFoundHandling: "single-page-application" },
            },
          },
        },
      },
      vite: {
        compatibilityDate: "1999-01-01",
        worker: { assets: { notFoundHandling: "none" } },
      },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.adapter?.notFoundHandling).toBe("single-page-application");
    expect(options.dev?.bindings).toBe(scoped);
  });

  it("falls back to the deprecated vite alias when no target is scoped", () => {
    const options = fromHarnessOptions({
      vite: { compatibilityDate: "2026-03-10" },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
  });

  it("tolerates fully-empty options", () => {
    const options = fromHarnessOptions({});
    expect(options.compatibilityDate).toBeUndefined();
    expect(options.dev?.bindings).toBeUndefined();
  });
});

describe("resolveExportTarget", () => {
  it("accepts a plain string target", () => {
    expect(resolveExportTarget("./src/exports/vite/index.js")).toBe(
      "./src/exports/vite/index.js",
    );
  });

  it("picks the import condition (kit's ESM-only ./vite export)", () => {
    expect(
      resolveExportTarget({
        types: "./types/index.d.ts",
        import: "./src/exports/vite/index.js",
      }),
    ).toBe("./src/exports/vite/index.js");
  });

  it("falls back to default and resolves nested conditions", () => {
    expect(
      resolveExportTarget({ default: { import: "./dist/index.js" } }),
    ).toBe("./dist/index.js");
  });

  it("returns undefined for unusable entries", () => {
    expect(resolveExportTarget(undefined)).toBeUndefined();
    expect(
      resolveExportTarget({ types: "./types/index.d.ts" }),
    ).toBeUndefined();
    expect(resolveExportTarget(null)).toBeUndefined();
  });
});
