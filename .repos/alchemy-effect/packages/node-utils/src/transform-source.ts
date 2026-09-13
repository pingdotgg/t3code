import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseSync,
  transformSync,
  TsconfigCache,
  type TransformOptions,
} from "rolldown/utils";
import type { ImportLoaderOptions, TransformContext } from "./import-loader.ts";

/** Extensions Oxc transpiles; everything else is JavaScript Node can run. */
export const transformExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
]);

export type ModuleFormat = "module" | "commonjs";

/**
 * Module format from Node's `load` hook context. Node derives these from the
 * extension and the nearest `package.json#type`; `*-typescript` variants are
 * its TypeScript-aware spellings and mean the same thing.
 */
const nodeFormat = (
  format: string | null | undefined,
): ModuleFormat | undefined => {
  switch (format) {
    case "module":
    case "module-typescript":
      return "module";
    case "commonjs":
    case "commonjs-typescript":
      return "commonjs";
    default:
      return undefined;
  }
};

/** Fallback for older Nodes that pass no format: extension, then package type. */
const inferFormat = (filePath: string): ModuleFormat => {
  const extension = path.extname(filePath);
  if (extension === ".mts" || extension === ".mjs") return "module";
  if (extension === ".cts" || extension === ".cjs") return "commonjs";
  let directory = path.dirname(filePath);
  while (true) {
    const packageJson = path.join(directory, "package.json");
    if (existsSync(packageJson)) {
      try {
        return JSON.parse(readFileSync(packageJson, "utf8")).type === "module"
          ? "module"
          : "commonjs";
      } catch {
        return "commonjs";
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return "commonjs";
    directory = parent;
  }
};

const language = (filePath: string): TransformOptions["lang"] => {
  switch (path.extname(filePath)) {
    case ".tsx":
      return "tsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".jsx":
      return "jsx";
    default:
      return "js";
  }
};

const sourceMapComment = (map: string | object) => {
  const json = typeof map === "string" ? map : JSON.stringify(map);
  return `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}`;
};

export interface TransformedSource {
  readonly format: ModuleFormat;
  readonly source: string;
}

export class SourceTransformer {
  readonly #options: ImportLoaderOptions;
  readonly #tsconfigCache = new TsconfigCache();

  constructor(options: ImportLoaderOptions) {
    this.#options = options;
  }

  /**
   * Transpiles `filePath` for Node, or returns `undefined` when the file is
   * JavaScript that needs no work. `format` is what Node's `load` hook was
   * told; it decides `sourceType` and the format handed back.
   */
  transform(
    filePath: string,
    url: string,
    format: string | null | undefined,
  ): TransformedSource | undefined {
    const extension = path.extname(filePath);
    const transpile = transformExtensions.has(extension);
    if (!transpile && this.#options.transforms === undefined) return undefined;

    let moduleFormat = nodeFormat(format) ?? inferFormat(filePath);
    let source = readFileSync(filePath, "utf8");
    let map: string | object | undefined;
    if (transpile) {
      const lang = this.#options.transform?.lang ?? language(filePath);
      // A `.ts` file in a CommonJS package that uses `import`/`export` runs
      // as ESM — the same call Node's own module-syntax detection makes for
      // `.js`. Explicit `.cts` stays CommonJS regardless.
      if (
        moduleFormat === "commonjs" &&
        extension !== ".cts" &&
        parseSync(filePath, source, { lang, sourceType: "unambiguous" }).module
          .hasModuleSyntax
      ) {
        moduleFormat = "module";
      }
      const transformed = transformSync(
        filePath,
        source,
        {
          tsconfig: this.#options.tsconfig ?? true,
          sourcemap: true,
          ...this.#options.transform,
          lang,
          sourceType: this.#options.transform?.sourceType ?? moduleFormat,
        },
        this.#tsconfigCache,
      );
      if (transformed.errors.length > 0) {
        const [error] = transformed.errors;
        throw error instanceof Error
          ? error
          : new SyntaxError(
              `${filePath}: ${(error as { message?: string }).message ?? String(error)}`,
            );
      }
      source = transformed.code;
      map = transformed.map;
    }

    const context: TransformContext = {
      url,
      path: filePath,
      format: moduleFormat,
    };
    for (const transform of this.#options.transforms ?? []) {
      const result = transform(source, context);
      if (typeof result === "string") {
        source = result;
        map = undefined;
      } else if (result !== undefined) {
        source = result.code;
        map = result.map;
      }
    }
    if (map !== undefined) source += sourceMapComment(map);
    return { format: moduleFormat, source };
  }
}
