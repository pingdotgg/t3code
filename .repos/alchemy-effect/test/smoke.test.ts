/**
 * Smoke test suite that exercises `alchemy destroy → deploy → destroy` in each
 * example directory with both `bun` and `pnpm`. Commands run in-place against
 * whatever is currently installed in the workspace; stdio is inherited so
 * output streams directly to the terminal.
 *
 * Modes:
 *   default              → test against the workspace `workspace:*` deps as-is
 *   SMOKE_CANARY=1       → pack + publish alchemy / better-auth / pr-package
 *                          tarballs to pkg.ing under a fresh tag, add the
 *                          pkg.ing URLs to the root workspace catalog, rewrite
 *                          each example's `workspace:*` refs to `catalog:`,
 *                          run a single root install, then `git checkout` the
 *                          mutated package.json files and reinstall once on
 *                          the way out.
 *
 * Env vars:
 *   SMOKE_RUNTIME    `bun` or `pnpm`                        (default: "bun")
 *   SMOKE_CANARY     "1" to enable canary mode              (default: off)
 *   SMOKE_STAGE      stage prefix, e.g. `pr-123` or `main`  (default: "smoke")
 *   PKGING_HOST      pkg.ing host                           (default: pkg.ing)
 *
 * Run with: `bun test ./test/smoke.test.ts`.
 */
import { $ } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TIMEOUT = 10 * 60 * 1000;

const examples = [
  "aws-lambda",
  "aws-lambda-httpapi",
  "aws-lambda-rpc",
  "cloudflare-git-artifacts",
  "cloudflare-neon-drizzle",
  "cloudflare-secrets-store",
  "cloudflare-tanstack",
  "cloudflare-vue",
  // "cloudflare-solidstart",
  // "cloudflare-solidjs-ssr",
  "cloudflare-worker-async",
  "cloudflare-worker",
];
const ALL_RUNTIMES = ["bun", "pnpm"] as const;
type Runtime = (typeof ALL_RUNTIMES)[number];

// `SMOKE_RUNTIME` is the CI escape hatch — the matrix workflow runs one
// job per runtime so each can do its own `<runtime> install` and isolate
// from the other. Unset locally, the test runs both runtimes against
// each example with `bun` going first so it doesn't race `pnpm` on
// shared build outputs (vite `dist/`, `.alchemy/`).
const RUNTIMES: readonly Runtime[] = (() => {
  const filter = process.env.SMOKE_RUNTIME?.trim();
  if (!filter) return ALL_RUNTIMES;
  if (filter !== "bun" && filter !== "pnpm") {
    throw new Error(`SMOKE_RUNTIME must be "bun" or "pnpm" (got: ${filter})`);
  }
  return [filter];
})();

const PUBLISHED = [
  { dir: "alchemy", name: "alchemy" },
  { dir: "better-auth", name: "@alchemy.run/better-auth" },
  { dir: "pr-package", name: "@alchemy.run/pr-package" },
] as const;

const canary = process.env.SMOKE_CANARY === "1";
const host = process.env.PKGING_HOST ?? "pkg.ing";

async function run(
  cmd: string[] | readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<number> {
  const proc = Bun.spawn([...cmd], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ALCHEMY_NO_TUI: "1", ...env },
  });
  return await proc.exited;
}

// Install every active runtime so each runtime's exec works against a
// node_modules layout it understands. Bun runs first because it writes
// the flat layout; pnpm 11 then layers its `.pnpm` virtual store on top
// so `pnpm exec` doesn't trip its implicit `runDepsStatusCheck` install
// inside an example directory at test time. When `SMOKE_RUNTIME` pins a
// single runtime, only that one installs.
//
// Canary mode mutates example package.json files at runtime, so the
// lockfile is intentionally stale during the run — `--no-frozen-lockfile`
// lets the install resolve the new `catalog:` refs. CI defaults pnpm to
// frozen-lockfile, which would otherwise fail with ERR_PNPM_OUTDATED_LOCKFILE.
//
// `Bun.spawn` has no TTY, so pnpm 11 aborts non-interactive `node_modules`
// removal with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` unless we set
// `CI=1`. Only forwarded to pnpm — alchemy's `loadFromEnv` short-circuits
// to env-only credentials when `CI=true`, which would break local runs
// that rely on the AWS SDK credential chain.
type InstallStep = { cmd: readonly string[]; env?: Record<string, string> };
const installCmds = (): readonly InstallStep[] => {
  const cmds: InstallStep[] = [];
  if (RUNTIMES.includes("bun")) {
    cmds.push({ cmd: ["bun", "install", "--no-frozen-lockfile"] });
  }
  if (RUNTIMES.includes("pnpm")) {
    cmds.push({
      cmd: ["pnpm", "install", "--no-frozen-lockfile"],
      env: { CI: "1" },
    });
  }
  return cmds;
};

const installAll = async (): Promise<void> => {
  for (const { cmd, env } of installCmds()) {
    expect(await run(cmd, ROOT, env)).toBe(0);
  }
};

const ROOT_PKG_PATH = path.join(ROOT, "package.json");
const examplePkgPath = (e: string) =>
  path.join(ROOT, "examples", e, "package.json");

type Pkg = {
  workspaces?: { catalog?: Record<string, string> };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const readJson = async <T>(p: string): Promise<T> =>
  JSON.parse(await fs.readFile(p, "utf8")) as T;
const writeJson = async (p: string, v: unknown) =>
  fs.writeFile(p, `${JSON.stringify(v, null, 2)}\n`);

const PNPM_WORKSPACE_PATH = path.join(ROOT, "pnpm-workspace.yaml");

/**
 * pnpm 11 runs an implicit `runDepsStatusCheck` before every `pnpm exec`,
 * which performs a hidden `pnpm install`. Bun's catalog config lives in
 * `package.json#workspaces.catalog` — pnpm doesn't read it. So we mirror
 * the bun catalog (and workspaces list) into a `pnpm-workspace.yaml` for
 * the duration of the suite. Generated, never checked in; cleaned up in
 * `afterAll` and on SIGINT/SIGTERM.
 *
 * Delegates to `scripts/pnpm-workspace.ts` so the file shape (pinned
 * catalog versions resolved from `bun.lock`, build-script allowlist) is
 * identical to what CI's pre-`pnpm install` step writes — otherwise the
 * smoke test would clobber CI's pinned catalogs with loose ranges and
 * trip `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on every per-example install.
 */
const writePnpmWorkspace = async () => {
  const code = await run(
    ["bun", path.join(ROOT, "scripts", "pnpm-workspace.ts")],
    ROOT,
  );
  if (code !== 0) {
    throw new Error(`scripts/pnpm-workspace.ts exited with code ${code}`);
  }
};

const removePnpmWorkspace = async () => {
  const code = await run(
    ["bun", path.join(ROOT, "scripts", "pnpm-workspace.ts"), "--remove"],
    ROOT,
  );
  if (code !== 0) {
    // Best-effort — never fail teardown over a missing file.
    await fs.rm(PNPM_WORKSPACE_PATH, { force: true });
  }
};

if (canary) {
  beforeAll(async () => {
    // CI passes PR_PACKAGE_TOKEN directly via env (matches pr-package.yaml);
    // locally we fall back to `doppler` so contributors don't have to export
    // the secret manually. Either path works.
    let token = process.env.PR_PACKAGE_TOKEN?.trim() ?? "";
    if (!token) {
      try {
        token = (
          await $`doppler secrets get PR_PACKAGE_TOKEN --plain -p alchemy-v2 -c dev`
            .quiet()
            .text()
        ).trim();
      } catch {
        // doppler not installed / not authed — leave token empty, error below
      }
    }
    if (!token) {
      throw new Error(
        "PR_PACKAGE_TOKEN is not set in env and `doppler -p alchemy-v2 -c dev` did not return one. " +
          "Either export PR_PACKAGE_TOKEN, run `bun download:env`, or invoke via `doppler run`.",
      );
    }

    const sha = (await $`git rev-parse HEAD`.quiet().text()).trim().slice(0, 7);
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\..*/, "");
    const tag = `canary-${sha}-${stamp}`;
    const tags = JSON.stringify([tag, "canary"]);
    console.log(`→ canary tag: ${tag} (host=${host})`);

    expect(await run(["bun", "run", "build:packages"], ROOT)).toBe(0);

    for (const { dir, name } of PUBLISHED) {
      const pkgDir = path.join(ROOT, "packages", dir);
      for (const f of await fs.readdir(pkgDir)) {
        if (f.endsWith(".tgz")) await fs.rm(path.join(pkgDir, f));
      }
      expect(
        await run(["bun", "pm", "pack", "--destination", "."], pkgDir),
      ).toBe(0);
      const tgz = (await fs.readdir(pkgDir)).find((f) => f.endsWith(".tgz"));
      if (!tgz) throw new Error(`no tgz produced in ${pkgDir}`);
      const abs = path.join(pkgDir, tgz);
      console.log(`→ publish ${name} (${tgz})`);
      const res = await fetch(`https://${host}/projects/${name}/packages`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tags": tags,
          "X-TTL": "1 hour",
          "Content-Type": "application/gzip",
        },
        body: Bun.file(abs),
      });
      if (!res.ok) {
        throw new Error(
          `publish ${name} failed: ${res.status} ${res.statusText}\n${await res.text()}`,
        );
      }
    }

    // Add the canary tarball URLs to the root catalog and rewrite each
    // example's `workspace:*` ref for a published package to `catalog:`.
    // One install at the root then resolves every example at once — much
    // faster than `<runtime> add` per (example × published package).
    const rootPkg = await readJson<Pkg>(ROOT_PKG_PATH);
    rootPkg.workspaces ??= {};
    rootPkg.workspaces.catalog ??= {};
    for (const { name } of PUBLISHED) {
      rootPkg.workspaces.catalog[name] = `https://${host}/${name}/${tag}`;
    }
    await writeJson(ROOT_PKG_PATH, rootPkg);

    for (const example of examples) {
      const p = examplePkgPath(example);
      const pkg = await readJson<Pkg>(p);
      let mutated = false;
      for (const k of ["dependencies", "devDependencies"] as const) {
        const deps = pkg[k];
        if (!deps) continue;
        for (const [n, v] of Object.entries(deps)) {
          if (v === "workspace:*" && PUBLISHED.some((pp) => pp.name === n)) {
            deps[n] = "catalog:";
            mutated = true;
          }
        }
      }
      if (mutated) await writeJson(p, pkg);
    }

    // Mirror the new catalog entries into pnpm-workspace.yaml so the
    // pnpm leg sees them too.
    await writePnpmWorkspace();

    await installAll();
  }, TIMEOUT);
}

/**
 * Restore the root + example package.json files via `git checkout` and
 * reinstall once. No-op when nothing has been mutated (non-canary mode).
 */
const restoreWorkspaceDeps = async () => {
  if (!canary) return;
  const paths = [ROOT_PKG_PATH, ...examples.map(examplePkgPath)];
  await run(["git", "checkout", "--", ...paths], ROOT);
  await writePnpmWorkspace();
  for (const { cmd, env } of installCmds()) {
    await run(cmd, ROOT, env);
  }
};

// Always-on setup: write `pnpm-workspace.yaml` mirroring bun's catalog so
// `pnpm exec` works in CI (pnpm 11's deps-status check otherwise fails on
// `catalog:` deps it doesn't know about).
beforeAll(writePnpmWorkspace, TIMEOUT);

// Always restore + clean up on a normal end-of-suite, regardless of canary
// mode.
afterAll(async () => {
  await restoreWorkspaceDeps();
  await removePnpmWorkspace();
}, TIMEOUT);

// Also restore + clean up if the suite is interrupted (Ctrl+C / SIGTERM).
let restoring = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (restoring) return;
    restoring = true;
    Promise.allSettled([restoreWorkspaceDeps(), removePnpmWorkspace()])
      .catch((err) => console.error("teardown failed:", err))
      .finally(() => process.exit(130));
  });
}

// One `test.concurrent` per (example, runtime) so failures point at the
// specific runtime that broke. Examples run in parallel, but within a
// single example the runtimes are chained on a per-example promise so bun
// finishes its destroy → deploy → destroy before pnpm starts in the same
// directory (otherwise both runs race on shared build outputs like
// vite's `dist/` and `.alchemy/`).
// ────────────────────────────────────────────────────────────────────────
// Monorepo smoke tests
//
// The monorepo examples (`monorepo-single-stack`, `monorepo-multi-stack`)
// can't be tested in-place like the flat examples above — they ship with
// a `_package.json` instead of `package.json` so the root workspace
// install doesn't try to wire them in as nested workspaces with their
// own `workspace:*` graphs.
//
// For each (monorepo, runtime) pair we:
//   1. `bun pm pack` `packages/alchemy` once → tarball
//   2. copy the example to a fresh temp dir (skipping build artifacts)
//   3. rename `_package.json` → `package.json`
//   4. rewrite every `alchemy: workspace:*` ref to `file:<tarball>`
//      and substitute `catalog:` refs against the root catalog
//   5. write `pnpm-workspace.yaml` when running under pnpm
//   6. install with the runtime, then run destroy → deploy → destroy
//
// `monorepo-single-stack` has one `alchemy.run.ts` at the root.
// `monorepo-multi-stack` has one per package; deploy backend → frontend,
// destroy frontend → backend.
// ────────────────────────────────────────────────────────────────────────

type Monorepo = {
  name: "monorepo-single-stack" | "monorepo-multi-stack";
  // The directories (relative to the monorepo root) where `alchemy
  // {deploy,destroy}` must run, in deploy order. Destroy runs in
  // reverse.
  deployDirs: readonly string[];
};

const monorepos: readonly Monorepo[] = [
  { name: "monorepo-single-stack", deployDirs: ["."] },
  { name: "monorepo-multi-stack", deployDirs: ["backend", "frontend"] },
];

let alchemyTarball: string | undefined;

beforeAll(async () => {
  const pkgDir = path.join(ROOT, "packages", "alchemy");
  for (const f of await fs.readdir(pkgDir)) {
    if (f.endsWith(".tgz")) await fs.rm(path.join(pkgDir, f));
  }
  // pnpm resolves `alchemy` via `lib/` (node import condition) so it
  // must reflect current `src/`; bun pm pack does not run a build.
  expect(await run(["bun", "run", "build"], pkgDir)).toBe(0);
  expect(await run(["bun", "pm", "pack", "--destination", "."], pkgDir)).toBe(
    0,
  );
  const tgz = (await fs.readdir(pkgDir)).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`bun pm pack produced no tarball in ${pkgDir}`);
  alchemyTarball = path.join(pkgDir, tgz);
}, TIMEOUT);

const SKIP_COPY = new Set([
  "node_modules",
  "dist",
  ".alchemy",
  ".turbo",
  ".wrangler",
  "tsconfig.tsbuildinfo",
]);

const copyMonorepo = async (src: string, dst: string): Promise<void> => {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyMonorepo(s, d);
    } else if (entry.isSymbolicLink()) {
      // Skip — likely a workspace symlink that won't exist in the copy.
    } else {
      await fs.copyFile(s, d);
    }
  }
};

const PUBLISHED_NAMES = new Set<string>(PUBLISHED.map((p) => p.name));

const resolveCatalog = (rootCatalog: Record<string, string>) => {
  return (deps: Record<string, string> | undefined): boolean => {
    if (!deps) return false;
    let mutated = false;
    for (const [name, version] of Object.entries(deps)) {
      const isPublished = PUBLISHED_NAMES.has(name);
      if (
        isPublished &&
        (version === "workspace:*" || version === "catalog:")
      ) {
        // In canary mode the root catalog has been rewritten with
        // pkg.ing URLs (see canary `beforeAll`); resolve through it
        // so the monorepo install actually exercises the canary
        // install path. Otherwise fall back to the locally-packed
        // tarball for `alchemy` so monorepos still test against the
        // workspace's current source on a non-canary run.
        const fromCatalog = rootCatalog[name];
        if (canary && fromCatalog) {
          deps[name] = fromCatalog;
        } else if (name === "alchemy") {
          if (!alchemyTarball) throw new Error("alchemy tarball not built");
          deps[name] = `file:${alchemyTarball}`;
        } else {
          throw new Error(
            `dependency ${name} is "${version}" but no entry in root catalog (canary=${canary})`,
          );
        }
        mutated = true;
      } else if (version === "catalog:") {
        const resolved = rootCatalog[name];
        if (!resolved) {
          throw new Error(
            `dependency ${name} is "catalog:" but no entry in root catalog`,
          );
        }
        deps[name] = resolved;
        mutated = true;
      }
    }
    return mutated;
  };
};

const rewritePackageJson = async (
  pkgPath: string,
  resolve: (deps: Record<string, string> | undefined) => boolean,
): Promise<void> => {
  const pkg = await readJson<
    Pkg & { peerDependencies?: Record<string, string> }
  >(pkgPath);
  const a = resolve(pkg.dependencies);
  const b = resolve(pkg.devDependencies);
  const c = resolve(pkg.peerDependencies);
  if (a || b || c) await writeJson(pkgPath, pkg);
};

const setupMonorepo = async (
  m: Monorepo,
  runtime: Runtime,
): Promise<string> => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `alchemy-${m.name}-`));
  const dst = path.join(tmp, m.name);
  await copyMonorepo(path.join(ROOT, "examples", m.name), dst);

  // _package.json → package.json at root
  const tmpRootPkg = path.join(dst, "_package.json");
  const finalRootPkg = path.join(dst, "package.json");
  await fs.rename(tmpRootPkg, finalRootPkg);

  // Resolve `catalog:` refs using the example's own catalog first (it's
  // the source of truth — `examples/monorepo-*/_package.json#workspaces.catalog`),
  // falling back to the repo-root catalog for anything the example doesn't
  // pin. Drop the example's `alchemy` catalog entry — it points at
  // `file:../packages/alchemy` which doesn't exist in the temp checkout.
  // `resolveCatalog` then rewrites `alchemy` (and other PUBLISHED refs)
  // to either the canary pkg.ing URL (canary mode) or the locally-packed
  // tarball (default).
  const rootPkg = await readJson<Pkg>(ROOT_PKG_PATH);
  const rootCatalog = rootPkg.workspaces?.catalog ?? {};
  const copyRootPkg = await readJson<Pkg>(finalRootPkg);
  const exampleCatalog = copyRootPkg.workspaces?.catalog ?? {};
  delete exampleCatalog.alchemy;
  if (copyRootPkg.workspaces) {
    copyRootPkg.workspaces.catalog = exampleCatalog;
    await writeJson(finalRootPkg, copyRootPkg);
  }
  const mergedCatalog: Record<string, string> = {
    ...rootCatalog,
    ...exampleCatalog,
  };
  const resolve = resolveCatalog(mergedCatalog);

  // Root may declare deps too (single-stack runs `alchemy` from the
  // root, so it needs `node_modules/.bin/alchemy` hoisted there).
  await rewritePackageJson(finalRootPkg, resolve);
  for (const sub of ["backend", "frontend"] as const) {
    await rewritePackageJson(path.join(dst, sub, "package.json"), resolve);
  }

  if (runtime === "pnpm") {
    // Mirror scripts/pnpm-workspace.ts — pnpm 11 fails install
    // (`ERR_PNPM_IGNORED_BUILDS`) on `workerd` / `msgpackr-extract` /
    // `esbuild` / `sharp` unless their build scripts are explicitly
    // allowlisted.
    const builds = [
      "@parcel/watcher",
      "esbuild",
      "msgpackr-extract",
      "sharp",
      "workerd",
    ];
    const yaml = [
      "onlyBuiltDependencies:",
      ...builds.map((n) => `  - ${JSON.stringify(n)}`),
      "",
      "allowBuilds:",
      ...builds.map((n) => `  ${JSON.stringify(n)}: true`),
      "",
      "packages:",
      "  - backend",
      "  - frontend",
      "",
    ].join("\n");
    await fs.writeFile(path.join(dst, "pnpm-workspace.yaml"), yaml);
  }

  expect(
    await run(
      runtime === "bun"
        ? ["bun", "install"]
        : ["pnpm", "install", "--no-frozen-lockfile"],
      dst,
    ),
  ).toBe(0);

  // The frontend's Vite build resolves the backend via its `import`
  // condition (`./lib/*.js`), so the workspace must be compiled
  // (`tsc -b` at the root walks the project references) before any
  // deploy runs.
  expect(
    await run(
      runtime === "bun" ? ["bun", "run", "build"] : ["pnpm", "run", "build"],
      dst,
    ),
  ).toBe(0);

  return dst;
};

for (const m of monorepos) {
  let prev: Promise<unknown> = Promise.resolve();
  for (const runtime of RUNTIMES) {
    const stagePrefix = (process.env.SMOKE_STAGE ?? "smoke")
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase();
    const stage = `${stagePrefix}-${runtime}-${m.name}`
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase();
    const cmd = (action: "destroy" | "deploy") =>
      runtime === "bun"
        ? ["bun", "alchemy", action, "--stage", stage, "--yes"]
        : ["pnpm", "exec", "alchemy", action, "--stage", stage, "--yes"];

    const myPrev = prev;
    let release!: () => void;
    prev = new Promise<void>((r) => {
      release = r;
    });

    test.concurrent(
      `${m.name} (${runtime}): destroy → deploy → destroy`,
      async () => {
        await myPrev.catch(() => {});
        const dst = await setupMonorepo(m, runtime);
        try {
          const deployOrder = m.deployDirs.map((d) => path.join(dst, d));
          const destroyOrder = [...deployOrder].reverse();
          for (const d of destroyOrder) {
            expect(await run(cmd("destroy"), d)).toBe(0);
          }
          for (const d of deployOrder) {
            expect(await run(cmd("deploy"), d)).toBe(0);
          }
          for (const d of destroyOrder) {
            expect(await run(cmd("destroy"), d)).toBe(0);
          }
        } finally {
          release();
          // Best-effort cleanup of the temp checkout; leave it on
          // failure so a developer can inspect.
          await fs.rm(path.dirname(dst), { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
}

// Some examples model the production "shared infra + per-PR compute"
// pattern via cross-stage references (e.g. `cloudflare-neon-drizzle`
// has a `pr-*` stage that references a long-lived `staging-*` stage
// owning the Neon project). To keep tests isolated from one another,
// each test owns *both* stages — `staging-${stage}` is deployed first,
// then the main stage, then both are torn down in reverse order so the
// dependency edge (pr → staging) is respected.
//
// We only set up the pre-stage when the main stage starts with `pr-`,
// because that's the only branch in the example that crosses stages.
// Local `smoke-*` and `dev_<user>` stages just stand up their own
// project inline and don't need the pre-stage.
const PRE_DEPLOY_STAGES: Record<string, (stage: string) => string[]> = {
  "cloudflare-neon-drizzle": (stage) =>
    stage.startsWith("pr-") ? [`staging-${stage}`] : [],
};

for (const example of examples) {
  const cwd = path.join(ROOT, "examples", example);
  let prev: Promise<unknown> = Promise.resolve();
  for (const runtime of RUNTIMES) {
    // Prefix the stage with $SMOKE_STAGE when provided so PR runs
    // (`pr-<n>-…`) and main runs (`main-…`) never collide on the same
    // cloud resource. Locally falls back to a fixed `smoke` prefix.
    const stagePrefix = (process.env.SMOKE_STAGE ?? "smoke")
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase();
    const stage = `${stagePrefix}-${runtime}-${example}`
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase();
    const cmd = (action: "destroy" | "deploy", stageOverride = stage) =>
      runtime === "bun"
        ? ["bun", "alchemy", action, "--stage", stageOverride, "--yes"]
        : [
            "pnpm",
            "exec",
            "alchemy",
            action,
            "--stage",
            stageOverride,
            "--yes",
          ];
    const preStages = PRE_DEPLOY_STAGES[example]?.(stage) ?? [];

    const myPrev = prev;
    let release!: () => void;
    prev = new Promise<void>((r) => {
      release = r;
    });

    test.concurrent(
      `${example} (${runtime}): destroy → deploy → destroy`,
      async () => {
        // Wait for the previous runtime in this example to release the
        // shared working directory. `catch(() => {})` so a failed earlier
        // runtime doesn't cascade-fail every later runtime — the failure
        // is already attributed to the right test.
        await myPrev.catch(() => {});
        try {
          // Clean up any leftovers across all stages before deploying.
          // Order: dependents (main) first, dependencies (pre-stages) last.
          expect(await run(cmd("destroy"), cwd)).toBe(0);
          for (const s of [...preStages].reverse()) {
            expect(await run(cmd("destroy", s), cwd)).toBe(0);
          }
          // Deploy: pre-stages first (data plane), main last (compute).
          for (const s of preStages) {
            expect(await run(cmd("deploy", s), cwd)).toBe(0);
          }
          expect(await run(cmd("deploy"), cwd)).toBe(0);
          // Tear down in reverse so cross-stage refs stay resolvable
          // until the dependent stage is gone.
          expect(await run(cmd("destroy"), cwd)).toBe(0);
          for (const s of [...preStages].reverse()) {
            expect(await run(cmd("destroy", s), cwd)).toBe(0);
          }
        } finally {
          release();
        }
      },
      TIMEOUT,
    );
  }
}
