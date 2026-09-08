import MagicString from "magic-string";
import path from "node:path";
import type {
  Plugin,
  PluginContext,
  RenderedChunk,
  RolldownMagicString,
  SourceMap,
} from "rolldown";
import { createPlugin } from "../factory.ts";
import { sanitizePath, toPosixPath } from "../utils.ts";

export const MODULE_RULES = [
  { type: "CompiledWasm", pattern: /\.wasm(\?module)?$/ },
  { type: "Data", pattern: /\.bin$/ },
  { type: "Text", pattern: /\.(txt|html|sql)$/ },
] as const;

const MODULE_REFERENCE_PATTERN = `__CLOUDFLARE_MODULE__(${MODULE_RULES.map((rule) => rule.type).join("|")})__(.*?)__CLOUDFLARE_MODULE__`;
export const MODULE_REFERENCE_REGEX = new RegExp(MODULE_REFERENCE_PATTERN);
const MODULE_REFERENCE_GLOBAL_REGEX = new RegExp(MODULE_REFERENCE_PATTERN, "g");

export const additionalModulesPlugin = createPlugin(
  "additional-modules",
  () => {
    const additionalModulePaths = new Set<string>();
    return {
      vite: {
        enforce: "pre",
        hotUpdate(options) {
          if (additionalModulePaths.has(options.file)) {
            void options.server.restart();
            return [];
          }
        },
      },
      shared: {
        resolveId: {
          filter: { id: MODULE_RULES.map((rule) => rule.pattern) },
          async handler(source, importer, options) {
            const resolved = await this.resolve(source, importer, options);
            if (!resolved) {
              return;
            }

            const rule = MODULE_RULES.find((rule) =>
              rule.pattern.test(resolved.id),
            );
            if (!rule) {
              return resolved;
            }

            const filePath = sanitizePath(resolved.id);
            additionalModulePaths.add(filePath);

            return {
              id: moduleReferenceId(rule.type, filePath),
              external: true,
            };
          },
        },
        renderChunk: {
          filter: { code: { include: MODULE_REFERENCE_REGEX } },
          handler: withMagicString(async function (code, chunk, magicString) {
            const matches = code.matchAll(MODULE_REFERENCE_GLOBAL_REGEX);
            for (const match of matches) {
              const [full, , id] = match;
              const source = await this.fs.readFile(id);
              const referenceId = this.emitFile({
                type: "asset",
                name: path.basename(id),
                source,
              });
              const fileName = this.getFileName(referenceId);
              const relativePath = toPosixPath(
                path.relative(path.dirname(chunk.fileName), fileName),
              );
              const importPath = relativePath.startsWith(".")
                ? relativePath
                : `./${relativePath}`;
              magicString.update(
                match.index,
                match.index + full.length,
                importPath,
              );
            }
          }),
        },
      },
    };
  },
);

function moduleReferenceId(type: "CompiledWasm" | "Data" | "Text", id: string) {
  return `__CLOUDFLARE_MODULE__${type}__${id}__CLOUDFLARE_MODULE__` as const;
}

type PluginHandler<T extends keyof Plugin> = Plugin[T] extends infer T
  ? T extends (...args: any) => any
    ? T
    : never
  : never;

/**
 * Returns a `renderChunk` handler that transforms the chunk using a magic string.
 * Uses Rolldown's native magic string if available, or the `magic-string` library otherwise.
 */
function withMagicString(
  renderChunk: (
    this: PluginContext,
    code: string,
    chunk: RenderedChunk,
    magicString: MagicString | RolldownMagicString,
  ) => Promise<void>,
): PluginHandler<"renderChunk"> {
  return async function (code, chunk, outputOptions, meta) {
    const magicString = meta.magicString ?? new MagicString(code);
    await renderChunk.call(this, code, chunk, magicString);
    if (
      "isRolldownMagicString" in magicString &&
      magicString.isRolldownMagicString
    ) {
      return magicString;
    }
    return {
      code: magicString.toString(),
      map: outputOptions.sourcemap
        ? (magicString.generateMap({ hires: "boundary" }) as SourceMap)
        : null,
    };
  };
}
