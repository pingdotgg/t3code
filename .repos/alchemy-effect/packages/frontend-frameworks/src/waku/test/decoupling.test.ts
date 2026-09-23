import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The framework-generic orchestration modules. Everything Cloudflare-specific
 * must live behind the `./cloudflare` deploy-target subpath (plus the
 * `./adapter` fork it selects and the alchemy `./source` provider, which are
 * Cloudflare modules by nature).
 */
const GENERIC_MODULES = ["Waku.ts", "index.ts"];

/**
 * Module specifiers a framework-generic module must never import. The default
 * target module *specifier string* (`"@alchemy.run/frontend-frameworks/waku/cloudflare"`) is
 * allowed as data — it is resolved from the project's node_modules at
 * runtime, never imported by the generic module graph.
 */
const FORBIDDEN = [
  /^@alchemy\.run\/cloudflare-runtime/, // runtime, Vite, Rolldown, ...
  /^@cloudflare\//,
  /cloudflare:/,
  /^wrangler/,
  /(^|\/)adapter(\.ts|\.js)?$/, // the adapter fork
  /(^|\/)cloudflare(\.ts|\.js)?$/, // the ./cloudflare target module
  /^@alchemy\.run\/frameworks\/waku\/(adapter|cloudflare)$/,
];

/** Extract every static/dynamic import + re-export specifier. */
const importSpecifiers = (source: string): Array<string> => {
  const specifiers: Array<string> = [];
  const patterns = [
    // import ... from "x"; export ... from "x";
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
    // side-effect imports: import "x";
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    // dynamic imports: import("x")
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
};

describe("target decoupling", () => {
  for (const module of GENERIC_MODULES) {
    it(`src/${module} imports nothing cloudflare-specific`, async () => {
      const source = await NodeFsPromises.readFile(
        NodePath.resolve(import.meta.dirname, "..", module),
        "utf8",
      );
      const specifiers = importSpecifiers(source);
      // Sanity: the extractor sees the module's real imports.
      expect(specifiers.length).toBeGreaterThan(0);
      const offending = specifiers.filter((specifier) =>
        FORBIDDEN.some((pattern) => pattern.test(specifier)),
      );
      expect(offending).toEqual([]);
    });
  }

  it("src/cloudflare.ts is the module that owns the cloudflare imports", async () => {
    const source = await NodeFsPromises.readFile(
      NodePath.resolve(import.meta.dirname, "../cloudflare.ts"),
      "utf8",
    );
    const specifiers = importSpecifiers(source);
    expect(specifiers).toContain("@alchemy.run/cloudflare-runtime/vite");
  });
});
