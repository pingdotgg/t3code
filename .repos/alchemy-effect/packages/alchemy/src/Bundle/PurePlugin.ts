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
import * as fs from "node:fs/promises";
import * as path from "node:path";
import picomatch from "picomatch";
import type * as rolldown from "rolldown";
import { RolldownMagicString } from "rolldown";
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
   * Only calls whose result is used (variable initializers, exports) are
   * annotated in the auto-detected package. Top-level calls whose result
   * is discarded (e.g. Hono/Express-style `app.get("/", handler)` route
   * registrations) are preserved unless the package explicitly declares
   * `"sideEffects": false` (or `[]`) in its `package.json`.
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
      const inputs = inputFilePaths(opts);
      for (const input of inputs) entryPaths.add(input);
      if (!autoDetect) return null;
      const candidates = [
        ...inputs.map((input) => path.dirname(input)),
        opts.cwd ?? process.cwd(),
      ];
      for (const dir of candidates) {
        const info = await resolvePackageInfo(dir, pkgInfoCache);
        if (info === null || info.name === null) continue;
        if (!patterns.includes(info.name)) {
          patterns.push(info.name);
          isMatch = picomatch(patterns);
        }
        break;
      }
      return null;
    },
    transform: {
      filter: { id: SUPPORTED_FILE_RE },
      async handler(code, id, meta) {
        const cleanId = stripIdSuffix(id);
        const info = await resolvePackageInfo(
          path.dirname(cleanId),
          pkgInfoCache,
        );
        // A nameless package.json (e.g. a nested `dist/package.json`
        // holding only `{"type": "module"}`) can't be matched against the
        // configured patterns — fall back to the path-derived
        // `node_modules/<pkg>` name when one exists.
        const name = info?.name ?? packageNameFromId(cleanId);
        if (name === null || !isMatch(name)) return null;

        // Only override `moduleSideEffects` when the owning package
        // explicitly opts in via `sideEffects: false` / `[]`. Marking
        // arbitrary modules side-effect-free could erase intentional
        // registrations / mutations the author made at the top level of
        // files in packages that did not declare so.
        const isEntry = entryPaths.has(cleanId);
        const sideEffectFreePkg = isSideEffectFree(info?.sideEffects);
        const markSideEffectFree =
          markSideEffectFreeOpt && !isEntry && sideEffectFreePkg;

        const anchors = collectPureAnchorsCached(code, cleanId);
        // Annotating a call whose result is BOUND (variable initializer,
        // export) only lets the minifier drop it when the binding itself
        // is unused — safe everywhere. Annotating a call whose result is
        // DISCARDED (a bare expression statement like `app.get("/", h)`)
        // is an instruction to delete the call under minification, so it
        // is only applied when the owning package explicitly declared
        // itself side-effect free, and never to entry modules, whose side
        // effects we always preserve (#949).
        const annotateDiscarded = !isEntry && sideEffectFreePkg;
        const positions =
          anchors === null
            ? []
            : annotateDiscarded
              ? [...anchors.bound, ...anchors.discarded]
              : anchors.bound;
        if (positions.length === 0) {
          // Metadata-only result: omitting `code` tells rolldown the
          // source was NOT transformed, so no sourcemap is expected and
          // no SOURCEMAP_BROKEN warning is emitted.
          return markSideEffectFree ? { moduleSideEffects: false } : null;
        }
        // `meta.magicString` is rolldown's native (Rust) MagicString over
        // `code`. Returning it as `code` hands sourcemap generation to
        // rolldown's native side (computed on a background thread). The
        // fallback covers direct hook invocations (unit tests).
        const s = meta.magicString ?? new RolldownMagicString(code);
        for (const anchor of positions) s.appendLeft(anchor, PURE_COMMENT);
        return {
          code: s,
          moduleSideEffects: markSideEffectFree ? false : null,
        };
      },
    },
  };
};

/** Strips rolldown's `?query` / `#hash` suffixes from a module id. */
const stripIdSuffix = (id: string): string => id.replace(/[?#].*$/, "");

/**
 * Returns the absolute paths of every real entry module declared on the
 * rolldown input options. Handles all three input shapes (string, array,
 * `{ name -> path }` record) and skips `\0`-prefixed virtual ids (e.g.
 * the ones `virtualEntryPlugin` substitutes in its `pre` options hook).
 */
function inputFilePaths(opts: rolldown.InputOptions): string[] {
  const raw: unknown[] =
    typeof opts.input === "string"
      ? [opts.input]
      : Array.isArray(opts.input)
        ? opts.input
        : opts.input && typeof opts.input === "object"
          ? Object.values(opts.input)
          : [];
  const cwd = opts.cwd ?? process.cwd();
  return raw
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && !entry.startsWith("\0"),
    )
    .map((entry) => path.resolve(cwd, entry));
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

/**
 * Resolves the owning {@link PackageInfo} for a directory by walking up
 * to the nearest `package.json`. This is what makes the plugin work for
 * workspace-linked sources (e.g. our own `packages/alchemy/src/**` when
 * consumers import via the `worker`/`bun` conditions which resolve to
 * `.ts`).
 *
 * Caches both positive and negative results per directory. Every visited
 * directory is a descendant-or-self of the directory where the walk
 * stops (found `package.json`, cache hit, `node_modules` boundary, or
 * filesystem root), so backfilling all of them with the result never
 * poisons sibling packages.
 */
export async function resolvePackageInfo(
  startDir: string,
  cache: Map<string, PackageInfo | null>,
): Promise<PackageInfo | null> {
  let dir = path.resolve(startDir);
  const visited: string[] = [];
  let result: PackageInfo | null = null;
  // Hard ceiling to prevent runaway walks on weird paths.
  for (let i = 0; i < 64; i++) {
    // Never walk above a `node_modules` boundary: the owning package of a
    // `node_modules/<pkg>/...` id lives at or below `<pkg>`. Climbing past
    // it can latch onto an unrelated package.json higher up (e.g. a stray
    // one at the filesystem root).
    if (path.basename(dir) === "node_modules") break;
    const cached = cache.get(dir);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    visited.push(dir);
    const info = await readPackageJson(path.join(dir, "package.json"));
    if (info !== null) {
      result = info;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const v of visited) cache.set(v, result);
  return result;
}

async function readPackageJson(file: string): Promise<PackageInfo | null> {
  try {
    const contents = await fs.readFile(file, "utf8");
    const json = JSON.parse(contents) as {
      name?: unknown;
      sideEffects?: unknown;
    };
    return {
      name: typeof json.name === "string" ? json.name : null,
      sideEffects: json.sideEffects,
    };
  } catch {
    // package.json missing or unreadable.
    return null;
  }
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
 * Process-wide memo of {@link collectPureAnchors} results keyed by module id.
 *
 * Parsing with oxc dominates the plugin's main-thread CPU (it showed up as
 * ~60% of the profile of a test run), and the same modules — effect/alchemy
 * dist files — are re-scanned for EVERY bundle built in the process. The
 * single-process test runner builds dozens of worker bundles per run, so
 * this cache eliminates all repeat parses. The stored `code` is compared on
 * lookup, so a changed file (e.g. dev watch mode) never serves a stale
 * result.
 */
const anchorsCache = new Map<
  string,
  { readonly code: string; readonly anchors: PureAnchors | null }
>();
const ANCHORS_CACHE_MAX = 10_000;

const collectPureAnchorsCached = (
  code: string,
  filename: string,
): PureAnchors | null => {
  const cached = anchorsCache.get(filename);
  if (cached !== undefined && cached.code === code) {
    return cached.anchors;
  }
  const anchors = collectPureAnchors(code, filename);
  if (anchorsCache.size >= ANCHORS_CACHE_MAX) {
    anchorsCache.clear();
  }
  anchorsCache.set(filename, { code, anchors });
  return anchors;
};

/**
 * Offsets at which `/*#__PURE__*\/` may be inserted, split by whether the
 * call's result is consumed.
 */
export interface PureAnchors {
  /**
   * Calls whose result is bound — variable initializers, exports,
   * assignment right-hand sides. Annotating these only lets the minifier
   * drop the call when the binding itself is unused, so it is safe for
   * any module.
   */
  readonly bound: number[];
  /**
   * Top-level calls whose result is discarded (bare expression
   * statements such as `app.get("/", handler)`). Annotating these tells
   * the minifier the whole statement is deletable, so they are only safe
   * in packages that explicitly declare `sideEffects: false` / `[]`.
   */
  readonly discarded: number[];
}

/**
 * Parses `code` and returns the offsets at which `/*#__PURE__*\/` must be
 * inserted — before every top-level `CallExpression` callee / `new`
 * keyword — classified by whether the call result is bound or discarded.
 * Returns `null` if the file does not need to be modified (parse failure
 * or no annotations needed).
 */
export function collectPureAnchors(
  code: string,
  filename: string,
): PureAnchors | null {
  let program: Program;
  try {
    // Use TS lang so the parser tolerates TS syntax (`as`, `satisfies`,
    // non-null assertions) even when scanning published .js dist files
    // — TS is a strict superset of JS for our purposes here.
    program = parseAst(code, { sourceType: "module", lang: "ts" }, filename);
  } catch {
    return null;
  }

  const bound: number[] = [];
  const discarded: number[] = [];

  const visitCall = (
    call: CallExpression | NewExpression,
    isDiscarded: boolean,
  ) => {
    if (isIIFE(call)) return;
    // For `new X()`, anchor BEFORE the `new` keyword so we get
    // `/*#__PURE__*/ new X()` (matches babel-plugin-annotate-pure-calls).
    const anchor =
      call.type === "NewExpression" ? call.start : call.callee.start;
    if (alreadyAnnotated(code, anchor)) return;
    (isDiscarded ? discarded : bound).push(anchor);
  };

  const visitExpression = (
    expr: Expression | null | undefined,
    isDiscarded: boolean,
  ) => {
    if (!expr) return;
    switch (expr.type) {
      case "CallExpression":
      case "NewExpression":
        visitCall(expr, isDiscarded);
        return;
      case "SequenceExpression": {
        // All but the last expression's results are always discarded;
        // the last one takes the surrounding context.
        const exprs = expr.expressions;
        for (let i = 0; i < exprs.length; i++) {
          visitExpression(exprs[i], i < exprs.length - 1 ? true : isDiscarded);
        }
        return;
      }
      case "ParenthesizedExpression":
        visitExpression(expr.expression, isDiscarded);
        return;
      case "LogicalExpression":
        visitExpression(expr.left, isDiscarded);
        visitExpression(expr.right, isDiscarded);
        return;
      case "ConditionalExpression":
        visitExpression(expr.consequent, isDiscarded);
        visitExpression(expr.alternate, isDiscarded);
        return;
      case "AssignmentExpression":
        // The right-hand side's result is stored in the target, so it is
        // bound even when the assignment appears in statement position.
        visitExpression(expr.right, false);
        return;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
        visitExpression(expr.expression, isDiscarded);
        return;
      case "ChainExpression": {
        const inner = expr.expression;
        if (inner.type === "CallExpression") visitCall(inner, isDiscarded);
        return;
      }
      default:
        return;
    }
  };

  const visitTopLevel = (node: Statement) => {
    switch (node.type) {
      case "ExpressionStatement":
        visitExpression((node as ExpressionStatement).expression, true);
        return;
      case "VariableDeclaration":
        for (const decl of (node as VariableDeclaration).declarations) {
          visitExpression(decl.init, false);
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
          visitExpression(decl as Expression, false);
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

  return bound.length === 0 && discarded.length === 0
    ? null
    : { bound, discarded };
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
