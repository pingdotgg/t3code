import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

export class ModuleLoadError extends Data.TaggedError<"ModuleLoadError">(
  "ModuleLoadError",
)<{
  readonly specifier: string;
  readonly root: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Failed to load "${this.specifier}" from "${this.root}"`;
  }
}

/**
 * Whether Node treats `filePath` as CommonJS: `.cjs`, or `.js` whose nearest
 * `package.json` does not declare `"type": "module"`.
 */
const isCommonJsFile = (filePath: string): boolean => {
  if (filePath.endsWith(".cjs")) return true;
  if (!filePath.endsWith(".js")) return false;
  let directory = NodePath.dirname(filePath);
  for (;;) {
    const manifest = NodePath.join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        const { type } = JSON.parse(readFileSync(manifest, "utf8")) as {
          type?: unknown;
        };
        return type !== "module";
      } catch {
        return true;
      }
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
};

/**
 * Import a module from a *project's* dependency tree rather than our own —
 * the project's `vite`, `astro`, `waku`, `next`, etc. must be the instance
 * the framework integration drives, not whatever happens to be hoisted next
 * to this package.
 *
 * Resolution runs `createRequire(<root>/package.json).resolve(specifier)` and
 * imports the resolved absolute path as a `file://` URL (required for ESM
 * `import()` on Windows). If project-relative resolution fails (e.g. a
 * non-linked global install), it falls back to a bare `import(specifier)`.
 *
 * A CommonJS entry is loaded with `require`, not `import()`. Alchemy starts
 * every Node child with its Oxc loader (`module.registerHooks`), and once a
 * synchronous `load` hook exists Node's ESM loader runs *imported* CommonJS
 * through a re-invented `require` that lacks `require.extensions` and
 * `require.cache` (nodejs/node#59666) — `next` patches `require.extensions`
 * as it loads and dies with "Cannot read properties of undefined (reading
 * '.js')". The real CommonJS loader still consults the hooks, so project
 * TypeScript reached through `require()` keeps transpiling.
 */
export const loadProjectModule = <T = unknown>(
  root: string,
  specifier: string,
): Effect.Effect<T, ModuleLoadError> =>
  Effect.tryPromise({
    try: async () => {
      let primary: unknown;
      try {
        const require = createRequire(NodePath.resolve(root, "package.json"));
        const resolved = require.resolve(specifier);
        if (isCommonJsFile(resolved)) return require(resolved) as T;
        return (await import(
          /* @vite-ignore */ pathToFileURL(resolved).href
        )) as T;
      } catch (cause) {
        primary = cause;
      }
      try {
        // Fallback: a bare specifier resolves from our own module graph
        // (works for non-linked installs).
        return (await import(/* @vite-ignore */ specifier)) as T;
      } catch (fallback) {
        // The project-relative attempt is the meaningful failure — surface
        // it as the message and cause; the bare fallback failing only says
        // the specifier isn't in OUR graph, so it rides along in `errors`.
        const error = new AggregateError([primary, fallback], String(primary));
        error.cause = primary;
        throw error;
      }
    },
    catch: (cause) => new ModuleLoadError({ specifier, root, cause }),
  });

/**
 * Resolve the directory of a project's installed package (the directory
 * containing its `package.json`). Useful for deep paths that are not in the
 * package's exports map (e.g. `waku/dist/lib/vite-entries/entry.server.js`).
 */
export const resolveProjectPackageDirectory = (
  root: string,
  packageName: string,
): Effect.Effect<string, ModuleLoadError> =>
  Effect.try({
    try: () => {
      const require = createRequire(NodePath.resolve(root, "package.json"));
      return NodePath.dirname(require.resolve(`${packageName}/package.json`));
    },
    catch: (cause) =>
      new ModuleLoadError({
        specifier: `${packageName}/package.json`,
        root,
        cause,
      }),
  });

/**
 * Best-effort version of `packageName` as resolved from `fromDirectory`
 * (`undefined` when unresolvable). Used to feature-detect a dependency of a
 * project package — e.g. the Vite that Astro itself resolves — without
 * loading the module.
 */
export const resolveInstalledPackageVersion = (
  fromDirectory: string,
  packageName: string,
): Effect.Effect<string | undefined> =>
  Effect.sync(() => {
    try {
      const require = createRequire(
        NodePath.join(fromDirectory, "package.json"),
      );
      const pkg = require(`${packageName}/package.json`) as {
        version?: unknown;
      };
      return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
      return undefined;
    }
  });
