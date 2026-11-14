import { readFileSync } from "node:fs";
import * as NodeModule from "node:module";
import type {
  LoadFnOutput,
  LoadHookContext,
  LoadHookSync,
  ResolveFnOutput,
  ResolveHookContext,
  ResolveHookSync,
} from "node:module";
import { pathToFileURL } from "node:url";
import {
  filePathOfUrl,
  isProjectPath,
  SpecifierResolver,
  splitSpecifierMetadata,
} from "./resolve.ts";
import { SourceTransformer } from "./transform.ts";

export interface LoaderOptions {
  /**
   * Additional package export conditions used during module resolution.
   * They are made available alongside Node's ambient conditions to both the
   * TypeScript-aware resolver and Node's package exports resolver.
   */
  readonly conditions?: ReadonlyArray<string> | undefined;
  /**
   * Honour `tsconfig.json` discovered upward from each file: compiler
   * options for the transform, `paths`/`baseUrl` aliases for resolution.
   * @default true
   */
  readonly tsconfig?: boolean | undefined;
  /**
   * Limits transformation to matching absolute file paths; everything else
   * loads through Node untouched. Lets a published install transpile only
   * the user's own TypeScript while alchemy and its dependencies run their
   * built JavaScript.
   */
  readonly filter?: ((path: string) => boolean) | undefined;
  /**
   * On-disk cache of Oxc output shared by every process on the machine, so
   * the CLI, its dev exec child and the local-provider sidecars transpile
   * each source file once between them rather than once each. `false`
   * disables it, a string names the directory.
   * @default `$ALCHEMY_TRANSFORM_CACHE` (`0` disables), else a per-user
   * directory under the OS temp directory
   */
  readonly cache?: boolean | string | undefined;
}

/** Synchronous Node module hooks, as `module.registerHooks` takes them. */
export interface LoaderHooks {
  readonly resolve: ResolveHookSync;
  readonly load: LoadHookSync;
}

type NextResolve = Parameters<ResolveHookSync>[2];

/**
 * Node's module compile cache (`module.enableCompileCache`) keeps V8 code
 * cache for compiled modules — transformed TypeScript included, since it is
 * keyed by the compiled source — but Node only persists it once after the
 * entry module evaluated and again on a clean exit. Alchemy processes load
 * most of their graph lazily after that point (commands, the user's stack,
 * provider layers) and usually stop on a signal, so without an explicit
 * flush that code never reaches the cache. Flush once module loading has
 * gone quiet; a no-op when the cache is off or this Node predates it.
 */
const scheduleCompileCacheFlush = (() => {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (NodeModule.getCompileCacheDir?.() === undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      NodeModule.flushCompileCache?.();
    }, 1000);
    timer.unref();
  };
})();

/**
 * Whether `require()` breaks inside an imported CommonJS module whose source
 * the load hook supplied (nodejs/node#62920, fixed in 24.18 and 26.2, never
 * in 25.x): Node evaluates it with a stand-in `require` that cannot load ES
 * modules, so a `.cts` requiring TypeScript fails. On these versions the
 * hook leaves imported CommonJS to Node's default load, which defers it to
 * the real CommonJS loader without reading it; that loader's `require()`
 * calls reach the hook again, now in a require context, and are transpiled
 * there. Returning `source: null` directly is rejected by synchronous hooks
 * on older 24.x; Node's default load defers from 24.11.1 and 25.1
 * (nodejs/node#59929), alchemy's minimums. A namespaced (reloaded) graph
 * keeps such files fresh by evicting them from the path-keyed CommonJS
 * cache between generations (see ../watch/import-watcher.ts).
 */
const importedCommonJsNeedsNodeLoader = (() => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major < 24 || (major === 24 && minor < 18) || major === 25 || (major === 26 && minor < 2);
})();

/** Specifiers Node owns outright: builtins, data URLs, remote schemes. */
const isForeignSpecifier = (specifier: string) =>
  /^(?:node:|data:|[a-z][a-z\d+.-]*:\/\/)/i.test(specifier) && !specifier.startsWith("file:");

/**
 * tsx-compatible resolution. Oxc's resolver handles project code the way
 * TypeScript does (tsconfig `paths`, `.js` → `.ts` substitution,
 * extensionless and directory imports); a file it finds is final, as in
 * nub, rather than handed back to Node to resolve a second time. Packages
 * and everything Oxc cannot place stay with Node, which also reports the
 * canonical errors. The format is left to the load step.
 */
const resolveSpecifier = (
  resolver: SpecifierResolver,
  specifier: string,
  context: ResolveHookContext,
  nextResolve: NextResolve,
): ResolveFnOutput => {
  if (isForeignSpecifier(specifier)) return nextResolve(specifier, context);

  const parentPath = filePathOfUrl(context.parentURL);
  const { specifier: clean, metadata } = splitSpecifierMetadata(specifier);

  // TypeScript's rules apply to project code. Dependencies keep Node's plain
  // resolution so published packages behave exactly as they would without us.
  if (parentPath !== undefined && isProjectPath(parentPath)) {
    const candidate = resolver.resolve(parentPath, clean, context.conditions);
    if (candidate !== undefined) {
      return { url: pathToFileURL(candidate).href + metadata, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
};

/**
 * Key for memoizing a resolution, or `undefined` when it must not be. Inside
 * `node_modules` the result of resolving a specifier depends on the
 * importing module's directory, not the module itself (package scope,
 * node_modules lookup and relative paths are all per directory), and on the
 * conditions; a graph of thousands of modules repeats the same handful of
 * specifiers per directory, so each is resolved once. Project files are
 * keyed individually: a solution-style tsconfig can assign two files of one
 * directory to different referenced projects with different `paths`.
 */
const resolutionKey = (specifier: string, context: ResolveHookContext) => {
  const { parentURL } = context;
  if (parentURL === undefined || isForeignSpecifier(specifier)) return undefined;
  const queryIndex = parentURL.search(/[?#]/);
  const parent = queryIndex === -1 ? parentURL : parentURL.slice(0, queryIndex);
  const scope = parent.includes("/node_modules/")
    ? parent.slice(0, parent.lastIndexOf("/") + 1)
    : parent;
  return `${scope}\0${specifier}\0${context.conditions.join(",")}`;
};

/**
 * `import data from "./x.json"` without an import attribute is how
 * TypeScript projects import JSON (`resolveJsonModule`); Node insists on
 * `with { type: "json" }` for ESM. Supply it, as tsx does.
 */
const withJsonAttribute = (url: string, context: LoadHookContext) => {
  if (!/\.json(?:[?#]|$)/.test(url) || context.importAttributes?.type) {
    return context;
  }
  return {
    ...context,
    importAttributes: { ...context.importAttributes, type: "json" },
  };
};

/**
 * `import text from "./x.txt" with { type: "text" }` — the TC39 Import Text
 * proposal (stage 3), which Bun and Deno already implement. The module's
 * default export is the file decoded as UTF-8 exactly as `TextDecoder`
 * does it (BOM stripped, invalid sequences replaced). Node keys its module
 * map by attributes too, so the same file imported as text and as code are
 * two modules.
 */
const textModule = (filePath: string): LoadFnOutput => ({
  format: "module",
  source: `export default ${JSON.stringify(new TextDecoder().decode(readFileSync(filePath)))};`,
  shortCircuit: true,
});

/**
 * The loader itself: synchronous `resolve` and `load` hooks that transpile
 * TypeScript with Rolldown's Oxc transformer and resolve it the way
 * TypeScript (and tsx) does. Register them process-wide with
 * `registerOxc` (./register.ts), or scoped to one import graph through
 * `namespaced` (./namespace.ts). Each call creates its own resolver,
 * transformer and resolution memo.
 */
export const createHooks = (options: LoaderOptions = {}): LoaderHooks => {
  const transformer = new SourceTransformer(options);
  const resolver = new SpecifierResolver({ tsconfig: options.tsconfig ?? true });
  const resolutions = new Map<string, ResolveFnOutput>();
  const conditions = options.conditions ?? [];

  return {
    resolve(specifier, context, nextResolve) {
      if (conditions.length > 0) {
        context = { ...context, conditions: [...new Set([...conditions, ...context.conditions])] };
      }
      const key = resolutionKey(specifier, context);
      const memoized = key === undefined ? undefined : resolutions.get(key);
      if (memoized !== undefined) return memoized;
      const resolved = resolveSpecifier(resolver, specifier, context, nextResolve);
      // A memoized result skips the rest of the hook chain, which Node only
      // accepts when it says so.
      if (key !== undefined) resolutions.set(key, { ...resolved, shortCircuit: true });
      return resolved;
    },

    load(url, context, nextLoad) {
      scheduleCompileCacheFlush();
      const filePath = filePathOfUrl(url);
      if (filePath === undefined) return nextLoad(url, context);

      // An attribute, not a transpile: applies to any file, filtered or not.
      if (context.importAttributes?.type === "text") return textModule(filePath);

      if (options.filter !== undefined && !options.filter(filePath)) {
        return nextLoad(url, withJsonAttribute(url, context));
      }
      const transformed = transformer.transform(filePath, context.format);
      if (transformed === undefined) return nextLoad(url, withJsonAttribute(url, context));

      // `importAttributes` is present on every import and absent on require().
      if (
        importedCommonJsNeedsNodeLoader &&
        transformed.format === "commonjs" &&
        context.importAttributes !== undefined
      ) {
        return nextLoad(url, { ...context, format: "commonjs" });
      }
      return { ...transformed, shortCircuit: true };
    },
  };
};
