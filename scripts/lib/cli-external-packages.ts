/**
 * The single source of truth for packages the server CLI bundle must NOT inline.
 *
 * Two consumers derive from this list, and they must never disagree:
 *
 * - apps/server/vite.config.ts decides what stays external to the bundle.
 * - scripts/build-desktop-artifact.ts selects the runtime dependency roots for
 *   the Windows server sidecar.
 *
 * A runtime package that is external but absent from the sidecar fails as soon
 * as Node resolves it from the emitted bundle. Keeping both consumers on one
 * list prevents packaging from drifting away from the bundle boundary.
 *
 * Entries are matched as prefixes (`id.startsWith(prefix)`), so they also cover
 * a package's platform-specific siblings — `node-gyp-build` covers
 * `node-gyp-build-optional-packages`, `@yuuang/` covers every `ffi-rs-*` binding.
 */
/**
 * External because Node actually loads them from disk at runtime.
 *
 * Native addons (.node), the JS wrappers that dlopen them by real path, and —
 * critically — the ordinary JS packages those wrappers require. An external
 * package is loaded from the real filesystem, so its own `require` also
 * resolves from the real filesystem; a dependency that was bundled away exists
 * only inside the emitted bundle and is unreachable there. This closure is
 * enforced by a test, not by inspection.
 */
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@clerk/electron-passkeys",
  "@msgpackr-extract/",
  "msgpackr-extract",
  "node-gyp-build",
  "node-addon-api",
  // Required by node-gyp-build-optional-packages. Not native, but in the
  // closure: without it, WSL gets MODULE_NOT_FOUND while Windows is fine.
  "detect-libc",
  // ws's optional accelerators. Nothing in this repo declares them, so they are
  // not in the staged production install and the packaged app does not ship
  // them either way -- ws wraps the require in try/catch and falls back to its
  // JS paths. They are listed because they were being inlined from the dev
  // store: both carry binding.gyp and prebuilds and load through
  // node-gyp-build, and a native loader inlined into a bundle chunk searches
  // for prebuilds that cannot be beside it. Listing them keeps that from
  // becoming real if either is ever declared as a dependency.
  "bufferutil",
  "utf-8-validate",
] as const;

export function isRuntimeExternalCliDependency(id: string): boolean {
  return CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Bun's own module namespace, supplied by the Bun runtime rather than by disk.
 *
 * `@effect/platform-bun` and `@effect/sql-sqlite-bun` used to be external for
 * exactly one reason: they import `bun` and `bun:sqlite`, which cannot resolve
 * while bundling for Node. Externalizing the packages to dodge that was wrong.
 * Both import `effect`, so a Bun-hosted server loaded a *second* `effect` from
 * node_modules beside the bundle. Effect hangs each request's pre-response
 * handler off a module-level WeakMap, so the bundled copy wrote handlers the
 * platform server's copy never read: CORS headers, gzip and auth headers all
 * vanished from real responses while OPTIONS preflight (answered inline, no
 * WeakMap) kept working.
 *
 * Externalizing the `bun:*` specifiers instead keeps a single `effect` graph.
 * Nothing has to resolve them at build time, and nothing has to resolve them
 * under Node either: every import of a Bun module sits behind a
 * `typeof Bun !== "undefined"` dynamic import, so it lands in a chunk that only
 * a Bun-hosted server loads.
 */
export function isBunRuntimeModule(id: string): boolean {
  return id === "bun" || id.startsWith("bun:");
}

/**
 * True when `id` must stay out of the bundle.
 *
 * This has to be wired to the bundler's `neverBundle`, not just to
 * `alwaysBundle`. `alwaysBundle` only forces packages IN — returning false from
 * it means "no opinion", and the default then applies: a declared dependency
 * stays external, but a transitive one gets bundled. That is how
 * msgpackr-extract, node-gyp-build-optional-packages and detect-libc ended up
 * inlined while node-pty (a declared dependency) stayed external.
 */
export function isExternalCliDependency(id: string): boolean {
  return isBunRuntimeModule(id) || isRuntimeExternalCliDependency(id);
}

/** True when the CLI bundle should inline `id` rather than leave it external. */
export function shouldBundleCliDependency(id: string): boolean {
  if (id.startsWith("node:")) return false;
  return !isExternalCliDependency(id);
}

/** Select direct dependency roots whose runtime closure belongs in the sidecar. */
export function selectCliRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isRuntimeExternalCliDependency(name)),
  );
}

/**
 * Scan an emitted bundle chunk for runtime-external packages that were inlined.
 *
 * Configuring the bundler is not the same as checking what it produced. The
 * `alwaysBundle` predicate only forces packages IN; returning false from it
 * means "no opinion", so a transitive dependency still gets bundled by default.
 * msgpackr-extract, node-gyp-build-optional-packages and detect-libc were
 * inlined that way while every list-based test passed, which is why this reads
 * the artifact instead.
 *
 * `regionCount` is reported so the caller can tell "nothing was inlined" apart
 * from "the marker format changed and this scan no longer sees anything".
 *
 * `inlinedPackages` is every package seen in a region, which lets the caller
 * check the opposite direction too. Verifying only that externals are absent
 * would still pass if the bundler reverted to leaving everything external: the
 * scan would see source-file regions, report nothing inlined, and the packaged
 * backends would then fail with ERR_MODULE_NOT_FOUND because those packages
 * are not in the selected sidecar closure either.
 */
export function findInlinedExternalPackages(source: string): {
  readonly regionCount: number;
  readonly inlined: ReadonlyArray<string>;
  readonly inlinedPackages: ReadonlyArray<string>;
} {
  // Rolldown marks each inlined module with a `//#region <path>` comment.
  const regionPattern = /\/\/#region\s+(\S+)/g;
  const packagePattern = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g;

  let regionCount = 0;
  const inlined = new Set<string>();
  const inlinedPackages = new Set<string>();
  for (const region of source.matchAll(regionPattern)) {
    regionCount += 1;
    const regionPath = region[1] ?? "";
    for (const candidate of regionPath.matchAll(packagePattern)) {
      const name = candidate[1];
      if (name === undefined || name === ".pnpm") continue;
      inlinedPackages.add(name);
      if (isExternalCliDependency(name)) inlined.add(name);
    }
  }

  return {
    regionCount,
    inlined: [...inlined].sort(),
    inlinedPackages: [...inlinedPackages].sort(),
  };
}

/**
 * Walk the emitted chunk graph and report Bun modules the Node runtime can reach.
 *
 * Bundling `@effect/platform-bun` and `@effect/sql-sqlite-bun` moved a
 * `bun:sqlite` import from node_modules into the bundle. That is only safe
 * because rolldown keeps it in a chunk reached solely through `import()`, which
 * Node never evaluates. Nothing else enforces that: a stray static import of
 * `@effect/sql-sqlite-bun/SqliteClient` from an eagerly loaded module would
 * hoist `bun:sqlite` into the entry chunk and every `node bin.mjs` would die
 * with ERR_UNSUPPORTED_ESM_URL_SCHEME. Rolldown only warns about the merge
 * (INEFFECTIVE_DYNAMIC_IMPORT) and still exits 0.
 *
 * So this follows static edges only — `import`/`export ... from "./chunk.mjs"`
 * — from the entry chunks, exactly the graph Node loads eagerly, and reports
 * any Bun specifier inside it. Dynamic `import("./chunk.mjs")` is deliberately
 * not an edge.
 *
 * `chunks` maps chunk file name to source; `reachable` is returned so a caller
 * can tell "no violations" apart from "the walk never left the entry".
 */
export function findEagerBunRuntimeImports(
  chunks: ReadonlyMap<string, string>,
  entryChunks: Iterable<string>,
): {
  readonly reachable: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<{ readonly chunk: string; readonly specifier: string }>;
} {
  // Anchored at a line start so `import(...)` and specifier strings inside
  // bundled code cannot match. `[^;]*?` keeps a match inside one statement
  // while still spanning the line breaks rolldown puts in long import lists.
  const staticImportPattern =
    /^[ \t]*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm;

  const seen = new Set<string>();
  const queue = [...entryChunks];
  const violations: Array<{ chunk: string; specifier: string }> = [];

  for (const chunk of queue) {
    if (seen.has(chunk)) continue;
    seen.add(chunk);

    const source = chunks.get(chunk);
    if (source === undefined) continue;

    for (const match of source.matchAll(staticImportPattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined) continue;

      if (specifier.startsWith(".")) {
        // Chunks are emitted flat beside their entry, so the basename is the key.
        const target = specifier.slice(specifier.lastIndexOf("/") + 1);
        if (!seen.has(target)) queue.push(target);
        continue;
      }

      if (isBunRuntimeModule(specifier)) violations.push({ chunk, specifier });
    }
  }

  return {
    reachable: [...seen].filter((chunk) => chunks.has(chunk)).sort(),
    violations,
  };
}
