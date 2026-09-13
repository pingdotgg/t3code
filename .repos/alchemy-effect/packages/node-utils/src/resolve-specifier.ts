import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResolverFactory, type ResolveOptions } from "rolldown/experimental";

/**
 * TypeScript-aware specifier resolution on top of Oxc's resolver, mirroring
 * what tsx layers over Node's resolver:
 *
 * - `tsconfig.json` `paths` / `baseUrl` aliases, discovered per importing file
 * - emitted-extension substitution (`./x.js` → `x.ts`/`x.tsx`, `.mjs` → `.mts`,
 *   `.cjs` → `.cts`, `.jsx` → `.tsx`), TypeScript source winning over an
 *   emitted sibling
 * - extensionless specifiers and directory indexes, TypeScript first
 *
 * Node's own resolver stays the authority: every candidate this class
 * produces is handed back to Node (`nextResolve`) so it decides the format,
 * validates package exports, and reports the canonical error.
 */
export interface SpecifierResolverOptions {
  /** Discover `tsconfig.json` upward from each importing file. */
  readonly tsconfig: boolean;
}

export const nodeModulesSegment = `${path.sep}node_modules${path.sep}`;

/** Local project code: a file path outside every `node_modules` directory. */
export const isProjectPath = (filePath: string) =>
  !filePath.includes(nodeModulesSegment);

const typeScriptExtensions = /\.(?:[cm]?ts|[tj]sx)$/;

/** Whether TypeScript's extension substitution applies to this importer. */
export const isTypeScriptPath = (filePath: string) =>
  typeScriptExtensions.test(filePath);

export const isFileLikeSpecifier = (specifier: string) =>
  specifier.startsWith("./") ||
  specifier.startsWith("../") ||
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("file:") ||
  path.isAbsolute(specifier);

/**
 * Splits `?query#fragment` metadata off a specifier. Bare specifiers never
 * carry fragments in Node, so only `?` is honoured there.
 */
export const splitSpecifierMetadata = (specifier: string) => {
  const index = isFileLikeSpecifier(specifier)
    ? specifier.search(/[?#]/)
    : specifier.indexOf("?");
  return index === -1
    ? { specifier, metadata: "" }
    : {
        specifier: specifier.slice(0, index),
        metadata: specifier.slice(index),
      };
};

export const filePathOfUrl = (url: string | undefined) => {
  if (url === undefined || !url.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(new URL(url));
  } catch {
    return undefined;
  }
};

export class SpecifierResolver {
  readonly #options: ResolveOptions;
  readonly #base: ResolverFactory;
  readonly #byConditions = new Map<string, ResolverFactory>();

  constructor(options: SpecifierResolverOptions) {
    this.#options = {
      tsconfig: options.tsconfig ? "auto" : undefined,
      // TypeScript source first, then Node's implicit extensions.
      extensions: [
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".jsx",
        ".js",
        ".mjs",
        ".cjs",
        ".json",
        ".node",
      ],
      // TypeScript's emitted-extension substitution: `./x.js` may point at
      // `x.ts` (source) or `x.js` (emitted); source wins when both exist.
      extensionAlias: {
        ".js": [".ts", ".tsx", ".js"],
        ".jsx": [".tsx", ".jsx"],
        ".mjs": [".mts", ".mjs"],
        ".cjs": [".cts", ".cjs"],
      },
      mainFiles: ["index"],
      builtinModules: true,
      moduleType: true,
    };
    this.#base = new ResolverFactory(this.#options);
  }

  /**
   * Bare specifiers are probed without following symlinks: a workspace
   * package linked into `node_modules` must still read as a package (and be
   * left to Node), not as the project file its real path points at.
   */
  #resolver(conditions: ReadonlyArray<string>, symlinks: boolean) {
    const key = `${symlinks} ${conditions.join(" ")}`;
    let resolver = this.#byConditions.get(key);
    if (resolver === undefined) {
      // `cloneWithOptions` replaces the option set (sharing only the cache),
      // so each conditions variant restates the base options.
      resolver = this.#base.cloneWithOptions({
        ...this.#options,
        symlinks,
        conditionNames: [...conditions],
      });
      this.#byConditions.set(key, resolver);
    }
    return resolver;
  }

  /**
   * Resolves `specifier` as imported from `parentPath` to an absolute file
   * path, or `undefined` when Oxc cannot resolve it (Node then reports the
   * error), when it is a builtin, or when a bare specifier lands inside
   * `node_modules` — packages are Node's business, only `paths` aliases
   * that map onto project files are ours.
   */
  resolve(
    parentPath: string,
    specifier: string,
    conditions: ReadonlyArray<string>,
  ): string | undefined {
    const request = specifier.startsWith("file:")
      ? filePathOfUrl(specifier)
      : specifier;
    if (request === undefined) return undefined;
    let result;
    try {
      result = this.#resolver(
        conditions,
        isFileLikeSpecifier(request),
      ).resolveFileSync(parentPath, request);
    } catch {
      return undefined;
    }
    if (result.path === undefined) return undefined;
    if (!isFileLikeSpecifier(request) && !isProjectPath(result.path)) {
      return undefined;
    }
    return result.path;
  }

  /**
   * Given a file path Node failed to find (typically an `exports`/`main`
   * target that names emitted JavaScript that was never built), finds the
   * TypeScript source it was emitted from via extension substitution.
   */
  resolveMissing(
    missingPath: string,
    conditions: ReadonlyArray<string>,
  ): string | undefined {
    const directory = path.dirname(missingPath);
    const base = path.basename(missingPath);
    try {
      const result = this.#resolver(conditions, true).sync(
        directory,
        `./${base}`,
      );
      return result.path;
    } catch {
      return undefined;
    }
  }
}
