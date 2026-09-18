/**
 * `import source from "./hasher.ts?worker"` — the target is bundled into
 * one self-contained ES module (the same Cloudflare-flavored build the
 * parent gets: workerd externals, node builtins, Alchemy defines) and
 * imported as a **string**, ready to hand to a `WorkerLoader`
 * (`modules: { "worker.js": source }`). Nested `?worker` imports inside
 * the target work the same way.
 *
 * Bundling happens at build time, so the string is fixed per deploy; the
 * dynamic worker it becomes is then instantiated at runtime as many times
 * as the caller wants.
 */
import type * as rolldown from "rolldown";
import { splitFileAndPostfix } from "../../../Bundle/RawPlugin.ts";

export const WORKER_MODULE_RE: RegExp = /(\?|&)worker(?:&|$)/;

export const workerModulePlugin = (options: {
  /**
   * The nested build's input options (plugins, externals, cwd) for a given
   * entry; `input` is set by the plugin. Built lazily per import.
   */
  readonly nested: (entry: string) => Promise<rolldown.InputOptions>;
  readonly loadRolldown: () => Promise<typeof import("rolldown")>;
}): rolldown.Plugin => ({
  name: "alchemy:worker-module",
  resolveId: {
    filter: { id: WORKER_MODULE_RE },
    async handler(source, importer) {
      const [base, query] = splitFileAndPostfix(source);
      const resolved = await this.resolve(base, importer, { skipSelf: true });
      if (!resolved || resolved.external) return null;
      return { id: resolved.id + query, moduleSideEffects: false };
    },
  },
  load: {
    filter: { id: WORKER_MODULE_RE },
    async handler(id) {
      const entry = id.replace(/[?#].*$/, "");
      this.addWatchFile(entry);
      const rolldownLib = await options.loadRolldown();
      const input = await options.nested(entry);
      const bundle = await rolldownLib.rolldown({ ...input, input: entry });
      try {
        const { output } = await bundle.generate({
          format: "esm",
          minify: true,
          keepNames: true,
          inlineDynamicImports: true,
          sourcemap: false,
        });
        const chunk = output.find(
          (item) => item.type === "chunk" && item.isEntry,
        );
        if (chunk === undefined || chunk.type !== "chunk") {
          throw new Error(`worker module ${entry}: no entry chunk produced`);
        }
        for (const item of output) {
          if (item.type === "chunk" && item !== chunk) {
            throw new Error(
              `worker module ${entry}: produced a second chunk (${item.fileName}); a dynamic worker is one module`,
            );
          }
        }
        return {
          code: `export default ${JSON.stringify(chunk.code)};`,
          map: { mappings: "" },
          moduleType: "js",
        };
      } finally {
        await bundle.close();
      }
    },
  },
});
