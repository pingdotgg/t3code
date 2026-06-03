import type {
  CallExpression,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  Expression,
  ExpressionStatement,
  NewExpression,
  Program,
  Statement,
  VariableDeclaration,
} from "@oxc-project/types";
import MagicString from "magic-string";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import picomatch from "picomatch";
import type * as rolldown from "rolldown";
import { parseAst } from "rolldown/parseAst";

/**
 * Default packages whose modules will receive `/*#__PURE__*\/` annotations.
 * Mirrors what `effect-smol` ships via `babel-plugin-annotate-pure-calls`
 * applied to its own `dist/` output.
 *
 * `alchemy` is included so its own resources (which consist almost entirely
 * of `Effect.fn(...)`, `Context.Service(...)(...)`, `Layer.effect(...)` and
 * `Data.TaggedError(...)` top-level calls) become tree-shakeable. The
 * package already declares `"sideEffects": false`, so it is safe.
 */
export const DEFAULT_PURE_PACKAGES: ReadonlyArray<string> = [
  "effect",
  "@effect/*",
  "alchemy",
  "@alchemy.run/*",
];

/**
 * Options for {@link purePlugin}.
 */
export interface PurePluginOptions {
  /**
   * Extra package names or globs to annotate, in addition to
   * {@link DEFAULT_PURE_PACKAGES}. Globs are matched with picomatch
   * against the package name (e.g. `effect`, `@effect/cluster`).
   */
  readonly packages?: ReadonlyArray<string>;
  /**
   * If true, the configured `packages` list replaces the defaults
   * entirely instead of extending them.
   * @default false
   */
  readonly replaceDefaults?: boolean;
  /**
   * If true, also marks matched modules as side-effect free
   * (mirrors `"sideEffects": []` in package.json), so rolldown drops
   * unused re-exports from those packages.
   * @default true
   */
  readonly markSideEffectFree?: boolean;
  /**
   * If true, automatically detect the npm package that owns the bundle
   * entry (by walking up to the nearest `package.json`) and annotate it
   * too. This makes the user's own source tree-shakeable without any
   * configuration.
   *
   * The package's `sideEffects` field is NOT consulted for this gate —
   * if your entry's package has init-time side effects you wish to
   * preserve, declare them in `package.json` (`"sideEffects": ["./foo.ts"]`)
   * or set this option to `false`.
   *
   * @default true
   */
  readonly autoDetectEntryPackage?: boolean;
}

const PURE_COMMENT = "/*#__PURE__*/ ";
const SUPPORTED_FILE_RE = /\.(?:m?[jt]sx?|cjs|cts)$/;

/**
 * Rolldown plugin that injects `/*#__PURE__*\/` annotations on top-level
 * call/new expressions of modules belonging to the configured packages,
 * enabling tree-shaking of `effect`, `@effect/*`, and any user-listed
 * packages without requiring a babel post-build pass.
 */
export const purePlugin = (
  options: PurePluginOptions = {},
): rolldown.Plugin => {
  const patterns = options.replaceDefaults
    ? [...(options.packages ?? DEFAULT_PURE_PACKAGES)]
    : [...DEFAULT_PURE_PACKAGES, ...(options.packages ?? [])];
  const markSideEffectFreeOpt = options.markSideEffectFree ?? true;
  const autoDetect = options.autoDetectEntryPackage ?? true;
  // Mutable so the `options` hook can append the auto-detected entry
  // package without rebuilding the plugin instance.
  let isMatch = picomatch(patterns);
  // Per-bundle cache of directory -> owning package metadata.
  // Avoids walking the filesystem for every module of a large package.
  const pkgInfoCache = new Map<string, PackageInfo | null>();
  // Resolved absolute paths of entry modules. Marking an entry module as
  // `moduleSideEffects: false` makes rolldown treat its top-level
  // statements (including `console.log` etc.) as eliminable, often
  // collapsing the whole bundle. We always preserve entries' side
  // effects, regardless of the package they belong to.
  const entryPaths = new Set<string>();

  return {
    name: "alchemy:annotate-pure",
    async options(opts) {
      collectEntryPaths(opts, entryPaths);
      if (!autoDetect) return null;
      const detected = await detectEntryPackage(opts);
      if (detected === null) return null;
      if (patterns.includes(detected)) return null;
      patterns.push(detected);
      isMatch = picomatch(patterns);
      return null;
    },
    transform: {
      filter: { id: SUPPORTED_FILE_RE },
      async handler(code, id) {
        const info = await resolvePackageInfo(id, pkgInfoCache);
        if (info === null || info.name === null || !isMatch(info.name)) {
          return null;
        }
        const cleanId = id.replace(/[?#].*$/, "");
        const isEntry = entryPaths.has(cleanId);
        // Only override `moduleSideEffects` when the owning package
        // explicitly opts in via `sideEffects: false` / `[]`. Pure
        // annotations themselves are always safe to add (they only mean
        // "if the result is unused, the call may be dropped"), but
        // marking arbitrary modules side-effect-free could erase
        // intentional registrations / mutations the author made at the
        // top level of files in packages that did not declare so.
        const markSideEffectFree =
          markSideEffectFreeOpt &&
          !isEntry &&
          isSideEffectFree(info.sideEffects);
        const annotated = annotateModule(code, id);
        if (annotated === null) {
          return markSideEffectFree ? { code, moduleSideEffects: false } : null;
        }
        return {
          code: annotated.code,
          map: annotated.map,
          moduleSideEffects: markSideEffectFree ? false : null,
        };
      },
    },
  };
};

/**
 * Captures the absolute paths of every entry module declared on the
 * rolldown input options into `out`. Handles all three input shapes:
 * string, array of strings, and `{ name -> path }` record.
 */
function collectEntryPaths(
  opts: rolldown.InputOptions,
  out: Set<string>,
): void {
  const cwd = opts.cwd ?? process.cwd();
  const add = (entry: unknown) => {
    if (typeof entry !== "string") return;
    out.add(path.resolve(cwd, entry));
  };
  if (typeof opts.input === "string") add(opts.input);
  else if (Array.isArray(opts.input)) for (const e of opts.input) add(e);
  else if (opts.input && typeof opts.input === "object") {
    for (const e of Object.values(opts.input)) add(e);
  }
}

/**
 * Walks up from each entry path (and `cwd`) to find the nearest
 * `package.json`, and returns its `name` if the package is safely
 * annotatable — i.e. it declares `sideEffects: false` or `[]`. Returns
 * `null` if no entry package can be found, the entry has no name, or the
 * package opts out of side-effect-free treatment.
 */
async function detectEntryPackage(
  opts: rolldown.InputOptions,
): Promise<string | null> {
  const inputs: string[] = [];
  if (typeof opts.input === "string") inputs.push(opts.input);
  else if (Array.isArray(opts.input)) inputs.push(...opts.input);
  else if (opts.input && typeof opts.input === "object") {
    inputs.push(...(Object.values(opts.input) as string[]));
  }
  if (opts.cwd) inputs.push(opts.cwd);
  if (inputs.length === 0) inputs.push(process.cwd());

  for (const candidate of inputs) {
    const meta = await findOwningPackageMeta(candidate);
    if (meta === null || meta.name === null) continue;
    return meta.name;
  }
  return null;
}

/**
 * Metadata extracted from a `package.json`. `name` may be `null` when the
 * file exists but has no `"name"` field (rare, but possible for private
 * subpackage roots).
 */
export interface PackageInfo {
  readonly name: string | null;
  readonly sideEffects: unknown;
}

async function findOwningPackageMeta(
  start: string,
): Promise<PackageInfo | null> {
  // Resolve to absolute and start from the directory containing `start`
  // (or `start` itself if it is already a directory).
  let dir = path.resolve(start);
  try {
    if ((await fs.stat(dir)).isFile()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  for (let i = 0; i < 64; i++) {
    const pj = path.join(dir, "package.json");
    try {
      const stat = await fs.stat(pj);
      if (stat.isFile()) {
        const contents = await fs.readFile(pj, "utf8");
        const json = JSON.parse(contents) as {
          name?: unknown;
          sideEffects?: unknown;
        };
        return {
          name: typeof json.name === "string" ? json.name : null,
          sideEffects: json.sideEffects,
        };
      }
    } catch {
      // keep climbing
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Mirrors how rolldown / rollup interpret the `sideEffects` package.json
 * field. We only treat `false` and `[]` as "fully side-effect free"; an
 * array of files or `true` is treated as not safe to auto-annotate the
 * whole package.
 */
function isSideEffectFree(value: unknown): boolean {
  if (value === false) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Extracts the npm package name from a resolved module id by walking back to
 * the last `node_modules/` segment. Handles scoped packages. This is the
 * fast path that does not hit the filesystem; it works for ordinary
 * `node_modules/<pkg>/...` ids but NOT for workspace-linked sources whose
 * resolved path is e.g. `<repo>/packages/alchemy/src/Bundle/PurePlugin.ts`.
 *
 * @example
 *   packageNameFromId("/proj/node_modules/effect/dist/Effect.js")
 *     // => "effect"
 *   packageNameFromId("/proj/node_modules/@effect/cluster/dist/index.js")
 *     // => "@effect/cluster"
 */
export function packageNameFromId(id: string): string | null {
  const normalized = id.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/node_modules/");
  if (idx === -1) return null;
  const rest = normalized.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  if (parts.length === 0 || parts[0] === "") return null;
  if (parts[0].startsWith("@")) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/**
 * Resolves the owning {@link PackageInfo} for a module id by walking up
 * the directory tree to the nearest `package.json`. This is what makes
 * the plugin work for workspace-linked sources (e.g. our own
 * `packages/alchemy/src/**` when consumers import via the `worker`/`bun`
 * conditions which resolve to `.ts`).
 *
 * Caches both positive and negative results per directory to keep the
 * filesystem walk bounded across an entire bundle pass.
 */
export async function resolvePackageInfo(
  id: string,
  cache: Map<string, PackageInfo | null>,
): Promise<PackageInfo | null> {
  // Strip rolldown's `?query` / `#hash` suffixes if present.
  const cleanId = id.replace(/[?#].*$/, "");

  // Fast path: id matches `node_modules/<pkg>/...`. We still try to read
  // the package's `package.json` to learn its `sideEffects` field, but if
  // the file is unreadable (or this is a virtual id from a test) we fall
  // back to a minimal record using the path-derived name.
  const fastName = packageNameFromId(cleanId);

  let dir = path.dirname(cleanId);
  // Remember dirs we visited for this lookup so we can backfill their
  // cache entries — but ONLY descendants of the resolved package root.
  // Caching shared ancestors like `/proj/node_modules` would poison
  // sibling packages (e.g. effect and lodash both live under it).
  const visited: string[] = [];
  let foundRoot: string | null = null;
  let foundInfo: PackageInfo | null = null;
  // Hard ceiling to prevent runaway walks on weird ids.
  for (let i = 0; i < 64; i++) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      cacheDescendants(cache, visited, dir, cached);
      return cached;
    }
    visited.push(dir);
    const pkgJsonPath = path.join(dir, "package.json");
    let info: PackageInfo | null = null;
    try {
      const stat = await fs.stat(pkgJsonPath);
      if (stat.isFile()) {
        const contents = await fs.readFile(pkgJsonPath, "utf8");
        const json = JSON.parse(contents) as {
          name?: unknown;
          sideEffects?: unknown;
        };
        info = {
          name: typeof json.name === "string" ? json.name : null,
          sideEffects: json.sideEffects,
        };
      }
    } catch {
      // package.json missing or unreadable — keep climbing.
    }
    if (info !== null) {
      foundRoot = dir;
      foundInfo = info;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (foundInfo !== null && foundRoot !== null) {
    cacheDescendants(cache, visited, foundRoot, foundInfo);
    return foundInfo;
  }
  // No `package.json` found on disk. If we have a path-derived name
  // (from a `node_modules/<pkg>/...` segment), use it with no
  // `sideEffects` info — annotation can still happen, the override is
  // gated separately. Cache only the directly-owning dir so we don't
  // poison sibling lookups under the same `node_modules`.
  if (fastName !== null) {
    const fallback: PackageInfo = { name: fastName, sideEffects: undefined };
    if (visited[0]) cache.set(visited[0], fallback);
    return fallback;
  }
  if (visited[0]) cache.set(visited[0], null);
  return null;
}

/**
 * Caches `info` only at directories that are at or below `root` — i.e.
 * directories that genuinely belong to the same package. Dirs above the
 * package root are shared with siblings (e.g. `node_modules`) and must
 * not be tagged.
 */
function cacheDescendants(
  cache: Map<string, PackageInfo | null>,
  visited: string[],
  root: string,
  info: PackageInfo | null,
): void {
  for (const v of visited) {
    if (v === root || isPathInside(v, root)) cache.set(v, info);
  }
}

/**
 * `true` if `child` is `parent` or a directory contained beneath it.
 * Path-only check; does not touch the filesystem.
 */
function isPathInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Convenience wrapper that returns just the package name. Equivalent to
 * `resolvePackageInfo(...)?.name ?? packageNameFromId(id)`.
 */
export async function resolvePackageName(
  id: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cleanId = id.replace(/[?#].*$/, "");
  const fast = packageNameFromId(cleanId);
  if (fast !== null) return fast;
  // Adapter cache so callers can keep a single-value cache shape.
  const adapter = new Map<string, PackageInfo | null>();
  for (const [k, v] of cache) {
    adapter.set(k, v === null ? null : { name: v, sideEffects: undefined });
  }
  const info = await resolvePackageInfo(cleanId, adapter);
  for (const [k, v] of adapter) {
    cache.set(k, v?.name ?? null);
  }
  return info?.name ?? null;
}

interface AnnotatedModule {
  readonly code: string;
  readonly map: ReturnType<MagicString["generateMap"]>;
}

/**
 * Parses `code` and inserts `/*#__PURE__*\/` before every top-level
 * `CallExpression` / `NewExpression` callee. Returns `null` if the file
 * does not need to be modified (parse failure or no annotations added).
 */
export function annotateModule(
  code: string,
  filename: string,
): AnnotatedModule | null {
  let program: Program;
  try {
    // Use TS lang so the parser tolerates TS syntax (`as`, `satisfies`,
    // non-null assertions) even when scanning published .js dist files
    // — TS is a strict superset of JS for our purposes here.
    program = parseAst(code, { sourceType: "module", lang: "ts" }, filename);
  } catch {
    return null;
  }

  const s = new MagicString(code);
  let mutated = false;

  const annotateCall = (call: CallExpression | NewExpression) => {
    if (isIIFE(call)) return;
    // For `new X()`, anchor BEFORE the `new` keyword so we get
    // `/*#__PURE__*/ new X()` (matches babel-plugin-annotate-pure-calls).
    const anchor =
      call.type === "NewExpression" ? call.start : call.callee.start;
    if (alreadyAnnotated(code, anchor)) return;
    s.appendLeft(anchor, PURE_COMMENT);
    mutated = true;
  };

  const annotateExpression = (expr: Expression | null | undefined) => {
    if (!expr) return;
    switch (expr.type) {
      case "CallExpression":
      case "NewExpression":
        annotateCall(expr);
        return;
      case "SequenceExpression":
        for (const inner of expr.expressions) annotateExpression(inner);
        return;
      case "ParenthesizedExpression":
        annotateExpression(expr.expression);
        return;
      case "LogicalExpression":
        annotateExpression(expr.left);
        annotateExpression(expr.right);
        return;
      case "ConditionalExpression":
        annotateExpression(expr.consequent);
        annotateExpression(expr.alternate);
        return;
      case "AssignmentExpression":
        annotateExpression(expr.right);
        return;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
        annotateExpression(expr.expression);
        return;
      case "ChainExpression": {
        const inner = expr.expression;
        if (inner.type === "CallExpression") annotateCall(inner);
        return;
      }
      default:
        return;
    }
  };

  const visitTopLevel = (node: Statement) => {
    switch (node.type) {
      case "ExpressionStatement":
        annotateExpression((node as ExpressionStatement).expression);
        return;
      case "VariableDeclaration":
        for (const decl of (node as VariableDeclaration).declarations) {
          annotateExpression(decl.init);
        }
        return;
      case "ExportNamedDeclaration": {
        const decl = (node as ExportNamedDeclaration).declaration;
        if (decl) visitTopLevel(decl as Statement);
        return;
      }
      case "ExportDefaultDeclaration": {
        const decl = (node as ExportDefaultDeclaration).declaration;
        if (
          decl &&
          decl.type !== "FunctionDeclaration" &&
          decl.type !== "ClassDeclaration" &&
          decl.type !== "TSInterfaceDeclaration"
        ) {
          annotateExpression(decl as Expression);
        }
        return;
      }
      default:
        return;
    }
  };

  for (const node of program.body) {
    // Directive nodes (e.g. "use strict") have type "ExpressionStatement"
    // with a `directive` field and a string literal expression — they
    // cannot contain calls, so visiting them is a safe no-op.
    visitTopLevel(node as Statement);
  }

  if (!mutated) return null;
  return {
    code: s.toString(),
    map: s.generateMap({ source: filename, hires: true, includeContent: true }),
  };
}

function isIIFE(node: CallExpression | NewExpression): boolean {
  let callee: Expression = node.callee;
  while (callee.type === "ParenthesizedExpression") {
    callee = callee.expression;
  }
  return (
    callee.type === "FunctionExpression" ||
    callee.type === "ArrowFunctionExpression"
  );
}

function alreadyAnnotated(code: string, pos: number): boolean {
  const start = Math.max(0, pos - 32);
  const slice = code.slice(start, pos);
  return slice.includes("/*#__PURE__*/") || slice.includes("/*@__PURE__*/");
}
