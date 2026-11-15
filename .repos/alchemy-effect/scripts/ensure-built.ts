// Rebuilds workspace packages whose build output is missing or stale.
//
// Some packages are consumed from their build output even in the
// workspace: cloudflare-runtime's source imports its bundled workers from
// `dist/`, and frontend-frameworks only exports `dist/`. Commands that need
// them (tests, type checking, local deploys) run `ensure` first, which is a
// no-op unless a package or one of its workspace dependencies changed since
// its last build.
//
// Every successful build of these packages records itself in
// `<outDir>/.build-stamp` (see package-build.ts). A package is stale when
// that stamp is missing or older than any tracked or untracked-but-not-ignored
// file of the package or its workspace dependencies, test files excepted.
//
// Distilled SDKs are consumed the same way by bundlers: their `default`
// export condition points at `lib/`, which distilled's `scripts/bundle-lib.ts`
// turns from `tsc -b` output into the chunked layout npm ships, with the
// `distilled-lazy` stubs in `lib/services.lazy/` (only bundle-lib writes
// those). After the builds above, every distilled package that has a `lib/`
// but no bundle stamp newer than its source and its `lib/` is bundled. Stamps live in `node_modules/.cache/distilled-bundle/<package>`
// (bundle-lib prunes unknown files from `lib/`).
//
// Usage: pnpm -w ensure:built [package...]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command } from "effect/cli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { command as platformCommand, stampFile } from "./package-build.ts";

/** Packages consumed from their build output, by directory name under packages/. */
const packages = {
  "cloudflare-runtime": { outDir: "dist" },
  "frontend-frameworks": { outDir: "dist" },
} as const;

type PackageName = keyof typeof packages;
const packageNames = Object.keys(packages) as Array<PackageName>;

/** Changes to tests never affect build output. */
const isTestFile = (file: string) =>
  /(^|\/)(test|tests|__tests__)\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file);

const workspaceRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, "..");
});

/** Directories of a package and all of its workspace dependencies. */
const dependencyDirectories = Effect.fn(function* (root: string, name: PackageName) {
  const spawner = yield* ChildProcessSpawner;
  const output = yield* spawner.string(
    yield* platformCommand(
      "pnpm",
      [
        "ls",
        "-r",
        "--filter",
        `{./packages/${name}}...`,
        "--depth",
        "-1",
        "--json",
        "--loglevel",
        "error",
      ],
      { cwd: root },
    ),
  );
  return (JSON.parse(output) as Array<{ path: string }>).map((project) => project.path);
});

/** Newest modification time across a directory's source files. */
const newestSourceTime = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;

  // `git -C` also works inside submodules, which the parent repo can't list.
  const files = yield* spawner.lines(
    yield* platformCommand(
      "git",
      ["-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "."],
      { cwd: directory },
    ),
  );
  const times = yield* Effect.forEach(
    files.filter((file) => file !== "" && !isTestFile(file)),
    (file) =>
      fs.stat(path.join(directory, file)).pipe(
        Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
        // Deleted but still-tracked files have nothing to compare.
        Effect.orElseSucceed(() => 0),
      ),
    { concurrency: 64 },
  );
  return Math.max(0, ...times);
});

const stampTime = Effect.fn(function* (root: string, name: PackageName) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.stat(path.join(root, "packages", name, packages[name].outDir, stampFile)).pipe(
    Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
    Effect.option,
  );
});

const isStale = Effect.fn(function* (root: string, name: PackageName) {
  const stamp = yield* stampTime(root, name);
  if (Option.isNone(stamp)) return true;
  const directories = yield* dependencyDirectories(root, name);
  const newest = yield* Effect.forEach(directories, newestSourceTime, { concurrency: "unbounded" });
  return Math.max(...newest) > stamp.value;
});

/** Where the last successful bundle of a distilled package is recorded. */
const distilledStamp = (root: string, path: Path.Path, name: string) =>
  path.join(root, "node_modules", ".cache", "distilled-bundle", name);

/** Distilled packages whose bundled `lib/` is missing or older than their source. */
const staleDistilled = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const distilled = path.join(root, "submodules", "distilled");
  if (!(yield* fs.exists(path.join(distilled, "scripts", "bundle-lib.ts")))) return [];
  const names = yield* fs.readDirectory(path.join(distilled, "packages"));
  return yield* Effect.filter(
    names.filter((name) => name !== "core"),
    Effect.fnUntraced(function* (name) {
      const directory = path.join(distilled, "packages", name);
      if (!(yield* fs.exists(path.join(directory, "lib")))) return false;
      if (!(yield* fs.exists(path.join(directory, "src", "services")))) return false;
      const mtime = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
          Effect.option,
        );
      const stamp = yield* mtime(distilledStamp(root, path, name));
      if (Option.isNone(stamp)) return true;
      // A wiped and re-emitted `lib/` (fresh tsc output) is newer than the stamp.
      const lib = yield* mtime(path.join(directory, "lib"));
      if (Option.isSome(lib) && lib.value > stamp.value) return true;
      return (yield* newestSourceTime(path.join(directory, "src"))) > stamp.value;
    }),
    { concurrency: 16 },
  );
});

const bundleDistilled = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const stale = yield* staleDistilled(root);
  if (stale.length === 0) return;
  yield* Effect.logInfo(`Bundling stale distilled packages: ${stale.join(", ")}`);
  const pathEnv = yield* Effect.sync(() => process.env.PATH ?? "");
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "node",
      ["scripts/bundle-lib.ts", ...stale.map((name) => `packages/${name}`)],
      {
        cwd: path.join(root, "submodules", "distilled"),
        // bundle-lib resolves rolldown and the formatters from the workspace.
        env: {
          PATH: [path.join(root, "node_modules", ".bin"), pathEnv].join(
            process.platform === "win32" ? ";" : ":",
          ),
        },
        extendEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(new Error(`Distilled bundle failed with exit code ${exitCode}`));
  }
  yield* fs.makeDirectory(path.dirname(distilledStamp(root, path, stale[0]!)), {
    recursive: true,
  });
  yield* Effect.forEach(stale, (name) => fs.writeFileString(distilledStamp(root, path, name), ""));
});

const command = Command.make(
  "ensure-built",
  {
    packages: Argument.Literals("package", packageNames).pipe(
      Argument.withDescription("Packages to check (defaults to all output-consumed packages)"),
      Argument.atLeast(0),
    ),
  },
  Effect.fn(function* ({ packages: selected }) {
    const root = yield* workspaceRoot;
    const spawner = yield* ChildProcessSpawner;

    const candidates = selected.length > 0 ? selected : packageNames;
    const stale = yield* Effect.filter(candidates, (name) => isStale(root, name), {
      concurrency: "unbounded",
    });
    if (stale.length === 0) return yield* bundleDistilled(root);

    yield* Effect.logInfo(`Rebuilding stale packages: ${stale.join(", ")}`);
    const exitCode = yield* spawner.exitCode(
      yield* platformCommand(
        "pnpm",
        [
          "-r",
          ...stale.flatMap((name) => ["--filter", `{./packages/${name}}...`]),
          "run",
          "build:package",
        ],
        { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      ),
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`Build failed with exit code ${exitCode}`));
    }
    yield* bundleDistilled(root);
  }),
).pipe(Command.withDescription("Rebuild packages whose build output is missing or stale"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
