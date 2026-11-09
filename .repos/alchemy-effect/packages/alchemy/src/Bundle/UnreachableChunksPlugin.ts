import type * as rolldown from "rolldown";

/**
 * Drop the chunks no entry reaches, with their source maps, before the bundle
 * is returned or written.
 *
 * Rolldown decides a dynamic chunk is live when the statement holding its
 * `import()` is included, and a cycle can keep that true on its own: Vite's
 * `node.js` sets up `createCachedImport(() => import("./build.js"))` at
 * module level, and `build.js` imports `node.js` back. So a Worker that only
 * reaches `import("vite")` through deploy-time code tree-shaking removes
 * still got ~1 MB of chunks (Vite, rolldown, esbuild, postcss, …) that
 * nothing loads, and every output file is uploaded.
 *
 * `dynamicImports` is computed before constant inlining, so it can list an
 * `import()` the final code no longer contains: only dynamic imports the
 * importer's code still references are followed.
 */
export const unreachableChunksPlugin = (): rolldown.Plugin => ({
  name: "alchemy:unreachable-chunks",
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle).filter(
      (file): file is rolldown.OutputChunk => file.type === "chunk",
    );
    const live = new Set<string>();
    const queue = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
    while (queue.length > 0) {
      const fileName = queue.pop()!;
      if (live.has(fileName)) continue;
      live.add(fileName);
      const chunk = bundle[fileName] as rolldown.OutputChunk;
      for (const dependency of chunk.imports) {
        if (bundle[dependency]?.type === "chunk") queue.push(dependency);
      }
      for (const dependency of chunk.dynamicImports) {
        if (
          bundle[dependency]?.type === "chunk" &&
          chunk.code.includes(dependency.split("/").pop()!)
        ) {
          queue.push(dependency);
        }
      }
    }
    for (const chunk of chunks) {
      if (live.has(chunk.fileName)) continue;
      delete bundle[chunk.fileName];
      if (chunk.sourcemapFileName !== null) delete bundle[chunk.sourcemapFileName];
    }
  },
});
