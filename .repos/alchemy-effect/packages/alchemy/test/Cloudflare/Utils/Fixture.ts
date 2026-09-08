import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as YAML from "yaml";

/**
 * Resolve `catalog:` dependency specifiers in a cloned fixture's
 * `package.json` to the concrete versions pinned in the workspace's
 * `pnpm-workspace.yaml`. Fixtures keep `catalog:` refs so versions stay
 * single-sourced, but a clone that installs OUTSIDE the workspace (e.g.
 * the Nextjs fixture, cloned to the OS temp dir so OpenNext's output
 * tracing sees a plain node_modules tree) has no workspace context —
 * `bun install` fails on every `catalog:` ref without this rewrite.
 */
const resolveCatalogSpecifiers = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(dir, "package.json");
  if (!(yield* fs.exists(manifestPath))) {
    return;
  }
  // Fixture.ts lives at packages/alchemy/test/Cloudflare/Utils/ — the
  // workspace root (and its pnpm-workspace.yaml) is five levels up.
  const workspaceYaml = path.join(
    import.meta.dirname,
    "../../../../..",
    "pnpm-workspace.yaml",
  );
  const workspace = YAML.parse(yield* fs.readFileString(workspaceYaml)) as {
    catalog?: Record<string, string>;
    catalogs?: Record<string, Record<string, string>>;
  };
  const manifest = JSON.parse(yield* fs.readFileString(manifestPath)) as {
    [section: string]: unknown;
  };
  let changed = false;
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = manifest[section] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!spec.startsWith("catalog:")) continue;
      const catalogName = spec.slice("catalog:".length);
      const version =
        catalogName === ""
          ? workspace.catalog?.[name]
          : workspace.catalogs?.[catalogName]?.[name];
      if (version === undefined) {
        return yield* Effect.fail(
          new Error(
            `cloneFixture: ${name} uses "${spec}" but pnpm-workspace.yaml has no such catalog entry`,
          ),
        );
      }
      deps[name] = version;
      changed = true;
    }
  }
  if (changed) {
    yield* fs.writeFileString(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
});

/**
 * Recursively copy `sourceDir` into a fresh `fs.makeTempDirectory`
 * (with `prefix`), preserving file modes. Returns the absolute path of
 * the new temp directory.
 *
 * Used by tests that want to mutate a fixture's `src/` files without
 * polluting the source-controlled fixture or racing with other tests
 * sharing the same fixture path.
 *
 * - `tempRoot`, when provided, places the temp dir under a specific
 *   parent directory instead of the OS temp root. This matters for
 *   Vite tests because Vite's `vite:build-html` plugin can't express
 *   project roots that sit outside the current working directory; an
 *   under-workspace temp dir keeps the relative path representable.
 * - `entries`, when provided, restricts the copy to a specific subset
 *   of top-level entries. Defaults to copying everything in
 *   `sourceDir`.
 */
export const cloneFixture = Effect.fn(function* (
  sourceDir: string,
  options: {
    prefix: string;
    tempRoot?: string;
    entries?: string[];
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (options.tempRoot) {
    yield* fs.makeDirectory(options.tempRoot, { recursive: true });
  }
  // Realpath the temp dir: macOS temp roots are symlinks (/tmp, /var/folders
  // → /private/...), and file watchers (Turbopack HMR) report events under
  // the real path — a symlinked project root never sees invalidations.
  const dir = yield* fs.realPath(
    yield* fs.makeTempDirectory({
      prefix: options.prefix,
      directory: options.tempRoot,
    }),
  );

  const entries = options.entries ?? (yield* fs.readDirectory(sourceDir));

  const copyTree = (relativePath: string): Effect.Effect<void, any, any> =>
    Effect.gen(function* () {
      const from = path.join(sourceDir, relativePath);
      const to = path.join(dir, relativePath);
      const stat = yield* fs.stat(from);
      if (stat.type === "Directory") {
        yield* fs.makeDirectory(to, { recursive: true });
        const children = yield* fs.readDirectory(from);
        for (const child of children) {
          yield* copyTree(path.join(relativePath, child));
        }
      } else {
        const contents = yield* fs.readFile(from);
        yield* fs.writeFile(to, contents);
        // Preserve executable bit so copied build scripts still run.
        const mode = Number(stat.mode);
        if (mode & 0o111) {
          yield* fs.chmod(to, mode);
        }
      }
    });

  for (const entry of entries) {
    yield* copyTree(entry);
  }

  yield* resolveCatalogSpecifiers(dir);

  yield* Effect.addFinalizer(
    Exit.match({
      onSuccess: () => Effect.ignore(fs.remove(dir, { recursive: true })),
      onFailure: () => Effect.void,
    }),
  );

  return dir;
});
