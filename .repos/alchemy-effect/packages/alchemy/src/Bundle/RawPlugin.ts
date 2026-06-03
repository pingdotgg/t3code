import type * as rolldown from "rolldown";

/**
 * Matches `?raw` or `&raw` query suffixes, mirroring Vite's `rawRE`
 * (see `vite/src/node/utils.ts`). Used to gate both `resolveId` and
 * `load` so the plugin only inspects ids that opt in.
 */
export const RAW_RE: RegExp = /(\?|&)raw(?:&|$)/;

/**
 * Rolldown plugin that adds Vite-style `?raw` import support to the
 * Alchemy bundler.
 *
 * Importing a file with the `?raw` suffix inlines its contents as the
 * default export of a JS module:
 *
 * ```ts
 * import sql from "./schema.sql?raw";
 * //         ^ string — the file contents read as UTF-8
 * ```
 *
 * This plugin only implements `?raw`. Vite's `?url` and `?inline`
 * variants both rely on a browser asset pipeline (URL serving / `data:`
 * fallback) that has no analogue in the server-side bundles produced
 * here (Cloudflare Workers, AWS Lambda), so they are intentionally
 * omitted.
 */
export const rawPlugin = (): rolldown.Plugin => ({
  name: "alchemy:raw",
  resolveId: {
    filter: { id: RAW_RE },
    async handler(source, importer) {
      const [base, query] = splitFileAndPostfix(source);
      const resolved = await this.resolve(base, importer, { skipSelf: true });
      if (!resolved || resolved.external) return null;
      return { id: resolved.id + query, moduleSideEffects: false };
    },
  },
  load: {
    filter: { id: RAW_RE },
    async handler(id) {
      const file = id.replace(/[?#].*$/, "");
      const contents = await this.fs.readFile(file, { encoding: "utf8" });
      return {
        code: `export default ${JSON.stringify(contents)};`,
        // Empty mappings = "this module has no meaningful source map".
        // The generated code is a synthetic `export default "..."` that
        // doesn't correspond line-for-line to any source file (the
        // underlying file isn't JS), so there's nothing to map. Supplying
        // `{ mappings: "" }` (rather than omitting `map`) opts the module
        // out of source-map generation without making rolldown synthesize
        // a default one from the loaded code.
        map: { mappings: "" },
        // NOTE: matches Vite — avoids a double `export default` if the
        // file extension would otherwise be picked up by another loader
        // (e.g. `?raw&.json`).
        moduleType: "js",
      };
    },
  },
});

/**
 * Splits an id into its file portion and the query/hash postfix (kept
 * with the leading `?` / `#`). Matches Vite's `splitFileAndPostfix`.
 *
 * @example
 *   splitFileAndPostfix("./foo.txt?raw") // => ["./foo.txt", "?raw"]
 *   splitFileAndPostfix("./foo.txt")     // => ["./foo.txt", ""]
 */
export function splitFileAndPostfix(id: string): [string, string] {
  const queryIdx = id.indexOf("?");
  const hashIdx = id.indexOf("#");
  const idx =
    queryIdx === -1
      ? hashIdx
      : hashIdx === -1
        ? queryIdx
        : Math.min(queryIdx, hashIdx);
  if (idx === -1) return [id, ""];
  return [id.slice(0, idx), id.slice(idx)];
}
