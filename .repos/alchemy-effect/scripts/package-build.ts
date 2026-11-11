// Shared build plumbing for the workspace packages under packages/.
//
// Each package's `scripts/build.ts` (its `build:package` script) declares its
// options and compile steps and hands them to `build`, which:
//
// 1. Generates `publishConfig.exports` from the package's source `exports`.
//    In the workspace, `exports` points straight at `src/*.ts` so every
//    consumer runs from source without a build. Published tarballs swap in
//    `publishConfig.exports`, which resolves to the compiled output and keeps
//    the `bun` (and, where enabled, `worker`) conditions on source.
// 2. Copies the repository's LICENSE, NOTICE and, where needed,
//    THIRD_PARTY_LICENSES.md and README.md into the package.
// 3. Runs the compile steps in order.
// 4. For packages consumed from their build output, writes
//    `<outDir>/.build-stamp`, which `ensure-built.ts` compares against the
//    sources to decide whether a rebuild is needed.
//
// Every phase is timed. Each timing is printed as it finishes, prefixed with
// the package name, and the build's timings are appended to the package's
// `.cache/build-timings.jsonl`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, CommandLine } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;

/** A named compile step, run with the package directory as cwd. */
export interface Step {
  readonly name: string;
  readonly run: (packageDirectory: string) => Effect.Effect<void, unknown, Services>;
}

export interface BuildOptions {
  /** Generate `publishConfig.exports` from `exports`. */
  readonly exports?: {
    /**
     * Also generate the workspace `exports` from `src/`: the root, one entry
     * per directory index (`./S3` → `./src/S3/index.ts`), the `sourceOnly`
     * subpaths, and `./*` for every other file. Published packages block
     * every `internal/` directory.
     */
    readonly generate?: boolean;
    /** Add a `worker` condition on source for Worker bundlers. */
    readonly worker?: boolean;
    /** Subpaths that resolve to source in every condition. */
    readonly sourceOnly?: ReadonlyArray<string>;
  };
  /** Copy THIRD_PARTY_LICENSES.md into the package. */
  readonly thirdPartyLicenses?: boolean;
  /** Copy README.md into the package. */
  readonly readme?: boolean;
  /**
   * Output directory consumed from its build output in the workspace. A
   * successful build writes its `.build-stamp` (see ensure-built.ts).
   */
  readonly stamp?: string;
  readonly steps: ReadonlyArray<Step>;
}

/** File recording a successful build inside a stamped output directory. */
export const stampFile = ".build-stamp";

const workspaceRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, "..");
});

/** Give a step a readable name for the timing logs. */
export const named = (name: string, step: Step): Step => ({ ...step, name });

/**
 * Build a command that runs on every platform. node_modules/.bin entries and
 * pnpm are `.cmd` shims on Windows, which only a shell can run, and a shell
 * takes one script, so the arguments are joined into it there.
 */
export const command = Effect.fn(function* (
  bin: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions,
) {
  if (process.platform !== "win32") return ChildProcess.make(bin, args, options);
  const script = yield* Effect.fromResult(CommandLine.join([bin, ...args], { format: "windows" }));
  return ChildProcess.make(script, [], { ...options, shell: true });
});

/** Run a command; fails when it exits non-zero. */
export const exec = (bin: string, ...args: Array<string>): Step => ({
  name: [bin, ...args].join(" "),
  run: Effect.fn(function* (packageDirectory) {
    const spawner = yield* ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      yield* command(bin, args, {
        cwd: packageDirectory,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`${bin} exited with code ${exitCode}`));
    }
  }),
});

/**
 * Run the TypeScript compiler: tsrs where it ships a native binary, `tsc`
 * elsewhere (Windows, Intel macOS).
 */
export const typescript = (...args: Array<string>): Step =>
  exec(
    ["darwin-arm64", "linux-x64", "linux-arm64"].includes(`${process.platform}-${process.arch}`)
      ? "tsrs"
      : "tsc",
    ...args,
  );

/** Copy a file, paths relative to the package directory. */
export const copy = (from: string, to: string): Step => ({
  name: `copy ${from} → ${to}`,
  run: Effect.fn(function* (packageDirectory) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.copyFile(path.join(packageDirectory, from), path.join(packageDirectory, to));
  }),
});

/** Directories under `src/`, relative to it, skipping `internal/` trees. */
const sourceDirectories = Effect.fn(function* (sourceDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(sourceDirectory, { recursive: true });
  const directories: Array<string> = [];
  for (const entry of entries.sort()) {
    const info = yield* fs.stat(path.join(sourceDirectory, entry));
    if (info.type === "Directory") directories.push(entry.split(path.sep).join("/"));
  }
  return directories;
});

const isInternal = (directory: string) => directory.split("/").includes("internal");

const generateExports = Effect.fn(function* (
  packageDirectory: string,
  options: NonNullable<BuildOptions["exports"]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceDirectory = path.join(packageDirectory, "src");
  const directories = yield* sourceDirectories(sourceDirectory);

  const indexes: Array<string> = [];
  for (const directory of directories) {
    if (isInternal(directory)) continue;
    if (yield* fs.exists(path.join(sourceDirectory, directory, "index.ts"))) {
      indexes.push(directory);
    }
  }

  return {
    ...((yield* fs.exists(path.join(sourceDirectory, "index.ts")))
      ? { ".": "./src/index.ts" }
      : {}),
    ...Object.fromEntries(
      (options.sourceOnly ?? []).map((subpath) => [subpath, `./src/${subpath.slice(2)}.ts`]),
    ),
    ...Object.fromEntries(
      indexes
        .sort((a, b) => a.localeCompare(b))
        .map((directory) => [`./${directory}`, `./src/${directory}/index.ts`]),
    ),
    "./*": "./src/*.ts",
    "./package.json": "./package.json",
  } as Record<string, string | null>;
});

/**
 * `null` entries blocking everything named `internal` from the published
 * package: each `internal/` directory, a root `internal.ts` (`./internal`),
 * and `internal.ts` at any depth below it (one pattern key ending in
 * `/internal`, which outranks `./*`).
 */
const internalBlocks = Effect.fn(function* (packageDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceDirectory = path.join(packageDirectory, "src");
  const directories = yield* sourceDirectories(sourceDirectory);
  const files = (yield* fs.readDirectory(sourceDirectory, { recursive: true })).map((file) =>
    file.split(path.sep).join("/"),
  );
  return {
    ...Object.fromEntries(
      directories
        .filter((directory) => directory.split("/").at(-1) === "internal")
        .filter((directory) => !isInternal(directory.split("/").slice(0, -1).join("/")))
        .map((directory) => [`./${directory}/*`, null]),
    ),
    ...(files.includes("internal.ts") ? { "./internal": null } : {}),
    ...(files.some(
      (file) => file.endsWith("/internal.ts") && !isInternal(file.slice(0, file.lastIndexOf("/"))),
    )
      ? { "./*/internal": null }
      : {}),
  };
});

const syncPublishExports = Effect.fn(function* (
  packageDirectory: string,
  options: NonNullable<BuildOptions["exports"]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const packageJsonPath = path.join(packageDirectory, "package.json");
  const packageJson = JSON.parse(yield* fs.readFileString(packageJsonPath)) as {
    exports: Record<string, string | null>;
    publishConfig?: Record<string, unknown>;
  };
  if (options.generate) {
    packageJson.exports = yield* generateExports(packageDirectory, options);
  }
  const tsconfig = JSON.parse(
    yield* fs.readFileString(path.join(packageDirectory, "tsconfig.json")),
  ) as { compilerOptions: { outDir: string } };
  const outDir = `./${path.normalize(tsconfig.compilerOptions.outDir)}/`;

  const exports = Object.fromEntries(
    Object.entries(packageJson.exports).map(([subpath, source]) => {
      // Non-source entries (bin scripts, package.json) publish as-is.
      if (source === null || !source.startsWith("./src/")) {
        return [subpath, source];
      }
      if (options.sourceOnly?.includes(subpath)) {
        return [subpath, { types: source, bun: source, default: source }];
      }

      const output = source.replace(/^\.\/src\//, outDir);
      return [
        subpath,
        {
          types: output.replace(/\.tsx?$/, ".d.ts"),
          bun: source,
          ...(options.worker ? { worker: source } : {}),
          default: output.replace(/\.tsx?$/, ".js"),
        },
      ];
    }),
  );

  // Blocks go just before `./*` so the published map reads top to bottom.
  const blocks = options.generate ? yield* internalBlocks(packageDirectory) : {};
  const published = Object.fromEntries(
    Object.entries(exports).flatMap((entry) =>
      entry[0] === "./*" ? [...Object.entries(blocks), entry] : [entry],
    ),
  );

  yield* fs.writeFileString(
    packageJsonPath,
    JSON.stringify(
      { ...packageJson, publishConfig: { ...packageJson.publishConfig, exports: published } },
      null,
      2,
    ) + "\n",
  );
});

const copyRepositoryFiles = Effect.fn(function* (packageDirectory: string, options: BuildOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* workspaceRoot;

  const files = [
    "LICENSE",
    "NOTICE",
    ...(options.thirdPartyLicenses ? ["THIRD_PARTY_LICENSES.md"] : []),
    ...(options.readme ? ["README.md"] : []),
  ];
  yield* Effect.forEach(files, (file) =>
    fs.copyFile(path.join(root, file), path.join(packageDirectory, file)),
  );
});

const writeStamp = Effect.fn(function* (packageDirectory: string, outDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(packageDirectory, outDir);
  yield* fs.makeDirectory(directory, { recursive: true });
  const at = yield* Effect.sync(() => new Date().toISOString());
  yield* fs.writeFileString(path.join(directory, stampFile), `${at}\n`);
});

const now = Effect.sync(() => Date.now());
const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

/** Build the package whose `scripts/` directory is `scriptsDirectory` (pass `import.meta.dirname`). */
export const build = (scriptsDirectory: string, options: BuildOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDirectory = path.resolve(scriptsDirectory, "..");
    const { name, version } = JSON.parse(
      yield* fs.readFileString(path.join(packageDirectory, "package.json")),
    ) as { name: string; version: string };

    // `scripts/sync-exports.ts` regenerates the export maps without building.
    if (process.env.PACKAGE_BUILD_EXPORTS_ONLY === "1") {
      if (options.exports) yield* syncPublishExports(packageDirectory, options.exports);
      return;
    }

    const phases: Array<Step> = [
      {
        name: "sync package files",
        run: Effect.fn(function* (directory) {
          if (options.exports) yield* syncPublishExports(directory, options.exports);
          yield* copyRepositoryFiles(directory, options);
        }),
      },
      ...options.steps,
      ...(options.stamp
        ? [
            {
              name: "write build stamp",
              run: (directory: string) => writeStamp(directory, options.stamp!),
            },
          ]
        : []),
    ];

    // Each line names its package: several packages build in parallel and
    // their output interleaves.
    const log = (message: string) => Console.log(`[build ${name}] ${message}`);

    yield* log(`start (v${version})`);
    const startedAt = yield* now;
    const timings: Array<{ name: string; ms: number }> = [];
    for (const phase of phases) {
      const phaseStartedAt = yield* now;
      yield* phase.run(packageDirectory);
      const ms = (yield* now) - phaseStartedAt;
      timings.push({ name: phase.name, ms });
      yield* log(`${phase.name}: ${formatSeconds(ms)}`);
    }
    const total = (yield* now) - startedAt;
    yield* log(`done in ${formatSeconds(total)}`);

    const cacheDirectory = path.join(packageDirectory, ".cache");
    yield* fs.makeDirectory(cacheDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(cacheDirectory, "build-timings.jsonl"),
      JSON.stringify({ at: new Date(startedAt).toISOString(), version, total, steps: timings }) +
        "\n",
      { flag: "a" },
    );
  }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
