import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

const GENERIC_MODULES = ["Vocs.ts", "Target.ts", "index.ts"];
const FORBIDDEN = [
  /^@alchemy\.run\/cloudflare-runtime/,
  /^@cloudflare\//,
  /cloudflare:/,
  /(^|\/)cloudflare(\.ts|\.js)?$/,
  /\.\.\/waku\/cloudflare\.ts$/,
];

const importSpecifiers = (source: string): Array<string> => {
  const specifiers: Array<string> = [];
  for (const pattern of [
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
};

describe("Vocs target decoupling", () => {
  for (const module of GENERIC_MODULES) {
    it(`${module} imports nothing Cloudflare-specific`, async () => {
      const source = await NodeFsPromises.readFile(
        NodePath.resolve(import.meta.dirname, "..", module),
        "utf8",
      );
      const offending = importSpecifiers(source).filter((specifier) =>
        FORBIDDEN.some((pattern) => pattern.test(specifier)),
      );
      expect(offending).toEqual([]);
    });
  }

  it("cloudflare.ts owns the Waku Cloudflare target composition", async () => {
    const source = await NodeFsPromises.readFile(
      NodePath.resolve(import.meta.dirname, "../cloudflare.ts"),
      "utf8",
    );
    expect(importSpecifiers(source)).toContain("../waku/cloudflare.ts");
  });
});
