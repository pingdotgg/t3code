/**
 * Enforces the deploy-target decoupling: the framework-generic half of this
 * package (everything reachable from `src/index.ts`) must contain ZERO
 * Cloudflare imports — no `@alchemy.run/cloudflare-runtime` package, no
 * `cloudflare:` module ids, no `@cloudflare/*` types, and no reach into the
 * Cloudflare target module (`src/cloudflare.ts`), the integration fork, or
 * the vendored runtime. All of that lives exclusively behind the
 * `@alchemy.run/frontend-frameworks/astro/cloudflare` subpath (and `./source`, which is the
 * alchemy *Cloudflare Worker* source provider by definition).
 */
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

const SRC = NodePath.resolve(import.meta.dirname, "..");

/** Import/export specifiers of a TS module (static, type-only, and dynamic). */
const collectSpecifiers = (source: string): Array<string> => {
  const specifiers: Array<string> = [];
  const patterns = [
    /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']/g,
    /import\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
};

/** Transitively walk relative imports starting from the given entry module. */
const walkModuleGraph = async (
  entry: string,
): Promise<Map<string, Array<string>>> => {
  const graph = new Map<string, Array<string>>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const source = await NodeFsPromises.readFile(file, "utf8");
    const specifiers = collectSpecifiers(source);
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      queue.push(NodePath.resolve(NodePath.dirname(file), specifier));
    }
  }
  return graph;
};

describe("framework-generic core is cloudflare-free", () => {
  it("no module reachable from src/index.ts imports anything cloudflare", async () => {
    const graph = await walkModuleGraph(NodePath.join(SRC, "index.ts"));

    // The walk must have actually covered the core modules.
    const reached = [...graph.keys()].map((file) =>
      NodePath.relative(SRC, file),
    );
    expect(reached).toContain("index.ts");
    expect(reached).toContain("Astro.ts");
    expect(reached).toContain("Target.ts");
    expect(reached).toContain("environments.ts");

    for (const [file, specifiers] of graph) {
      const relative = NodePath.relative(SRC, file);

      // The cloudflare halves must be unreachable from the core.
      expect(
        relative,
        `core reaches cloudflare module ${relative}`,
      ).not.toMatch(
        /^(cloudflare\.ts|integration\.ts|config-plugin\.ts|prerender-middleware\.ts|source\.ts|runtime[/\\])/,
      );

      for (const specifier of specifiers) {
        // The package name itself is Cloudflare-specific, so allow its generic
        // `/core` export while rejecting actual platform runtime modules and
        // vendor types — including type-only imports.
        expect(specifier, `${relative} imports ${specifier}`).not.toMatch(
          /^(?:@alchemy\.run\/cloudflare-runtime(?:\/|$)|@cloudflare\/|cloudflare:)/,
        );
      }
    }
  });

  it("the cloudflare target module is self-contained under the ./cloudflare subpath", async () => {
    // Sanity check the inverse direction: the target module exists and is the
    // only public seam re-exporting the integration fork.
    const index = await NodeFsPromises.readFile(
      NodePath.join(SRC, "index.ts"),
      "utf8",
    );
    expect(index).not.toContain("./integration.ts");
    const cloudflare = await NodeFsPromises.readFile(
      NodePath.join(SRC, "cloudflare.ts"),
      "utf8",
    );
    expect(cloudflare).toContain("./integration.ts");
  });
});
