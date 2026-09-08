import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { spawn } from "node:child_process";
import * as pathe from "pathe";
import { parse as parseYaml } from "yaml";

const repoRoot = pathe.resolve(import.meta.dirname, "../../../../..");

const run = (options: {
  cmd: string;
  args: string[];
  cwd: string;
}): Effect.Effect<string, Error> =>
  Effect.callback<string, Error>((resume) => {
    const child = spawn(options.cmd, options.args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("close", (code) =>
      resume(
        code === 0
          ? Effect.succeed(output)
          : Effect.fail(
              new Error(
                `${options.cmd} ${options.args.join(" ")} exited ${code}:\n${output}`,
              ),
            ),
      ),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

type WorkspaceCatalogs = {
  catalogs?: Record<string, Record<string, string>>;
};

/**
 * Rewrite `catalog:<name>` versions in a cloned fixture's package.json to
 * the concrete versions from the repo `pnpm-workspace.yaml`. The clone
 * sits outside the workspace, so bun cannot see pnpm catalogs.
 */
const rewriteCatalogVersions = Effect.fn(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = parseYaml(
    yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml")),
  ) as WorkspaceCatalogs;
  const pkgPath = path.join(rootDir, "package.json");
  const pkg = JSON.parse(yield* fs.readFileString(pkgPath)) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const missing: string[] = [];
  const rewrite = (deps: Record<string, string> | undefined) => {
    if (deps === undefined) {
      return;
    }
    for (const [name, version] of Object.entries(deps)) {
      if (!version.startsWith("catalog:")) {
        continue;
      }
      const catalog = version.slice("catalog:".length);
      const resolved = workspace.catalogs?.[catalog]?.[name];
      if (resolved === undefined) {
        missing.push(`${name}@${version}`);
        continue;
      }
      deps[name] = resolved;
    }
  };
  rewrite(pkg.dependencies);
  rewrite(pkg.devDependencies);
  if (missing.length > 0) {
    return yield* Effect.fail(
      new Error(`unresolved catalog versions: ${missing.join(", ")}`),
    );
  }
  yield* fs.writeFileString(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
});

/**
 * Install a cloned Next.js fixture as a standalone app: resolve its
 * `catalog:` versions from the repo workspace, then run a hoisted
 * `bun install` so Next/OpenNext see a plain node_modules tree.
 *
 * Clones must sit *outside* the repo — an in-workspace temp dir makes
 * Next treat the alchemy monorepo as the workspace root and look up the
 * root's typescript (catalog:build = tsgo, which has no JS compiler API).
 * The fixture instead depends on `typescript: catalog:frontend` (5.x,
 * ships `lib/typescript.js`), which Next requires.
 */
export const prepareNextjsFixture = Effect.fn(function* (rootDir: string) {
  yield* rewriteCatalogVersions(rootDir);
  yield* run({
    cmd: "bun",
    args: ["install", "--linker=hoisted"],
    cwd: rootDir,
  });
});
