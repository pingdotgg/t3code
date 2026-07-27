import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import fg from "fast-glob";
import { fileURLToPath } from "node:url";
import path from "pathe";
import * as Bundle from "../../Bundle/Bundle.ts";
import { exec } from "../../Util/exec.ts";
import { sha256 } from "../../Util/sha256.ts";

/**
 * Whether a Worker `main` entry points at a Python module. Python Workers
 * skip the rolldown pipeline entirely — Cloudflare interprets `.py` sources
 * directly with Pyodide, so the "bundle" is just the source files plus the
 * vendored `python_modules/` directory.
 */
export const isPythonMain = (main: string | undefined): main is string =>
  main !== undefined && main.split("?")[0].endsWith(".py");

/**
 * The Pyodide cross-compilation targets uv understands, keyed by the Python
 * version the Workers runtime selects from the compatibility date/flags.
 * The wheel index does not have to match the exact Pyodide release the
 * runtime uses — only the ABI (emscripten-wasm32) must be compatible.
 * Mirrors pywrangler (cloudflare/workers-py `pywrangler/utils.py`).
 */
const PYODIDE_TARGETS = {
  "3.12": {
    interpreter: "cpython-3.12.7-emscripten-wasm32-musl",
    index: "https://index.pyodide.org/0.27.7",
  },
  "3.13": {
    interpreter: "cpython-3.13.2-emscripten-wasm32-musl",
    index: "https://index.pyodide.org/0.28.3",
  },
} as const;

// `python_workers_20250116` (Python 3.13 / Pyodide 0.28) is implied by
// `python_workers` for compatibility dates on or after this day.
const PYTHON_3_13_DEFAULT_ON = "2025-09-29";

/**
 * The Python version the Workers runtime will use for the given
 * compatibility settings — the same selection pywrangler performs.
 */
export const pythonVersionForCompatibility = (compatibility: {
  date: string;
  flags: string[];
}): keyof typeof PYODIDE_TARGETS => {
  if (compatibility.flags.includes("no_python_workers_20250116")) {
    return "3.12";
  }
  if (
    compatibility.flags.includes("python_workers_20250116") ||
    // ISO dates compare lexically.
    compatibility.date >= PYTHON_3_13_DEFAULT_ON
  ) {
    return "3.13";
  }
  return "3.12";
};

/**
 * The PyPI package pywrangler always adds to the vendored dependencies: it
 * provides the `workers` Python module (Request/Response/WorkerEntrypoint
 * wrappers) plus the JS shims under `python_modules/workers/` that
 * `import_from_javascript()` resolves.
 */
const MANAGED_SDK_PACKAGE = "workers-runtime-sdk";

export interface PythonWorkerBundleOptions {
  id: string;
  /** Path (or `file://` URL) to the Worker's `.py` entry module. */
  main: string;
  compatibility: {
    date: string;
    flags: string[];
  };
}

const resolveMain = (main: string) =>
  Effect.sync(() => {
    try {
      return fileURLToPath(main);
    } catch {
      return main;
    }
  }).pipe(Effect.map((p) => path.resolve(p)));

const uvError = (message: string) => (cause: unknown) =>
  new Bundle.BundleError({ message, cause });

/**
 * Run a `uv` command, failing with a {@link Bundle.BundleError} that
 * includes uv's output when the command exits non-zero, and with an
 * actionable install hint when the binary is missing entirely.
 */
const runUv = Effect.fn(function* (
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) {
  const result = yield* exec(
    ChildProcess.make("uv", args, {
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
    }),
  ).pipe(
    Effect.mapError(
      uvError(
        "Failed to run `uv` — Python Workers use uv (>= 0.8.10) to vendor " +
          "dependencies for Pyodide. Install it from https://docs.astral.sh/uv/ " +
          "and re-run.",
      ),
    ),
  );
  if (result.exitCode !== 0) {
    return yield* new Bundle.BundleError({
      message: `\`uv ${args.join(" ")}\` failed with exit code ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
    });
  }
  return result;
});

/**
 * Resolve the `python_modules/` directory to upload alongside a Python
 * Worker's sources:
 *
 * - If the Worker's directory already contains `python_modules/` (the
 *   user vendored it themselves, e.g. with `pywrangler sync` or any other
 *   tool that produces Wrangler's vendored layout), it is used as-is.
 * - Otherwise, if `pyproject.toml` exists, its `[project.dependencies]`
 *   are vendored with uv into a staging directory under `.alchemy/`:
 *   resolve against the Pyodide wheel index for the runtime's Python
 *   version (`uv pip compile` → `pylock.toml`), install the prebuilt
 *   wheels into an emscripten cross-venv (`uv venv` + `uv pip install
 *   --no-build`), and copy the venv's `site-packages` out. Re-vendoring
 *   is skipped while the `pyproject.toml` hash is unchanged.
 * - With neither, the Worker has no vendored dependencies (the `workers`
 *   SDK module built into the runtime is still importable).
 */
const resolvePythonModulesDir = Effect.fn(function* (
  options: PythonWorkerBundleOptions & { root: string },
) {
  const fs = yield* FileSystem.FileSystem;

  const userManaged = path.join(options.root, "python_modules");
  if (yield* orDefault(fs.exists(userManaged), false)) {
    return userManaged;
  }

  const pyproject = path.join(options.root, "pyproject.toml");
  if (!(yield* orDefault(fs.exists(pyproject), false))) {
    return undefined;
  }

  const pythonVersion = pythonVersionForCompatibility(options.compatibility);
  const target = PYODIDE_TARGETS[pythonVersion];
  const pyprojectContent = yield* fs
    .readFileString(pyproject)
    .pipe(Effect.mapError(uvError(`Failed to read "${pyproject}"`)));
  const inputHash = yield* sha256(
    `${pythonVersion}\0${target.index}\0${pyprojectContent}`,
  );

  const staging = path.resolve(".alchemy", "python", options.id);
  const vendorDir = path.join(staging, "python_modules");
  const tokenFile = path.join(staging, ".synced");

  const token = yield* orDefault(fs.readFileString(tokenFile), undefined);
  if (token === inputHash && (yield* orDefault(fs.exists(vendorDir), false))) {
    return vendorDir;
  }

  yield* Effect.logDebug(
    `[${options.id}] Vendoring Python dependencies for ${pythonVersion} (emscripten-wasm32) with uv`,
  );
  yield* fs
    .makeDirectory(staging, { recursive: true })
    .pipe(Effect.mapError(uvError(`Failed to create "${staging}"`)));

  // pywrangler always vendors the managed SDK package alongside the
  // project's own dependencies; passing it as a second requirements input
  // avoids mutating the user's pyproject.toml.
  const extraRequirements = path.join(staging, "requirements.extra.txt");
  yield* fs
    .writeFileString(extraRequirements, `${MANAGED_SDK_PACKAGE}\n`)
    .pipe(Effect.mapError(uvError(`Failed to write "${extraRequirements}"`)));

  // 1. Resolve to a pylock.toml against the Pyodide wheel index. `--no-build`
  //    restricts the resolution to prebuilt (pure-Python or emscripten) wheels
  //    — building a Pyodide-platformed wheel locally is not possible.
  const lockfile = path.join(staging, "pylock.toml");
  yield* runUv(
    [
      "pip",
      "compile",
      pyproject,
      extraRequirements,
      "--python",
      target.interpreter,
      "--extra-index-url",
      target.index,
      "--index-strategy",
      "unsafe-best-match",
      "--no-header",
      "--no-build",
      "-o",
      lockfile,
    ],
    { cwd: options.root },
  );

  // 2. Install the locked wheels into a fresh emscripten cross-venv.
  const venv = path.join(staging, "venv");
  yield* orDefault(fs.remove(venv, { recursive: true }), undefined);
  yield* runUv(["venv", venv, "--python", target.interpreter], {
    cwd: options.root,
  });
  yield* runUv(
    [
      "pip",
      "install",
      "--no-build",
      "-r",
      lockfile,
      "--preview-features",
      "pylock",
    ],
    { cwd: options.root, env: { VIRTUAL_ENV: venv } },
  );

  // 3. The venv's site-packages IS the vendored python_modules directory.
  const sitePackages =
    process.platform === "win32"
      ? path.join(venv, "Lib", "site-packages")
      : path.join(venv, "lib", `python${pythonVersion}`, "site-packages");
  yield* orDefault(fs.remove(vendorDir, { recursive: true }), undefined);
  yield* fs
    .copy(sitePackages, vendorDir)
    .pipe(
      Effect.mapError(
        uvError(`Failed to copy "${sitePackages}" to "${vendorDir}"`),
      ),
    );
  // Mark the directory as a virtual environment (pywrangler parity).
  yield* fs
    .writeFileString(path.join(vendorDir, "pyvenv.cfg"), "")
    .pipe(Effect.mapError(uvError("Failed to write pyvenv.cfg")));
  yield* fs
    .writeFileString(tokenFile, inputHash)
    .pipe(Effect.mapError(uvError(`Failed to write "${tokenFile}"`)));

  return vendorDir;
});

const orDefault = <A, B, R>(
  effect: Effect.Effect<A, unknown, R>,
  fallback: B,
): Effect.Effect<A | B, never, R> =>
  Effect.catchCause(effect, () => Effect.succeed(fallback));

const globFiles = (
  patterns: string[],
  options: { cwd: string; ignore?: string[]; dot?: boolean },
) =>
  Effect.tryPromise({
    try: () =>
      fg.glob(patterns, {
        cwd: options.cwd,
        onlyFiles: true,
        dot: options.dot ?? false,
        ignore: options.ignore,
      }),
    catch: (error) =>
      new Bundle.BundleError({
        message: `Failed to list Python worker files in "${options.cwd}"`,
        cause: error,
      }),
  }).pipe(
    Effect.map((names) =>
      names.map((name) => name.replaceAll("\\", "/")).sort(),
    ),
  );

/**
 * Read a Python Worker "bundle" from disk. There is no compilation step —
 * the output is:
 *
 * 1. the entry module (first, so it becomes `main_module`), then every
 *    other `.py` file under the entry's directory, read as text;
 * 2. every file of the resolved `python_modules/` directory (vendored
 *    wheels), read as bytes and named `python_modules/<relpath>` —
 *    Wrangler's vendored-module layout, which both the upload API and
 *    workerd resolve at runtime.
 */
export const readPythonWorkerBundle = Effect.fn(function* (
  options: PythonWorkerBundleOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const main = yield* resolveMain(options.main);
  const root = path.dirname(main);
  const entryName = path.basename(main);

  const readTextModule = Effect.fn(function* (name: string) {
    const content = yield* fs
      .readFileString(path.join(root, name))
      .pipe(
        Effect.mapError(
          uvError(
            `Failed to read Python worker module "${path.join(root, name)}"`,
          ),
        ),
      );
    const hash = yield* sha256(content);
    return { path: name, content, hash } satisfies Bundle.BundleFile;
  });

  const sources = globFiles(["**/*.py"], {
    cwd: root,
    ignore: [
      "**/__pycache__/**",
      "python_modules/**",
      "**/.venv*/**",
      "**/node_modules/**",
      "**/.alchemy/**",
    ],
  }).pipe(
    Effect.map((names) => names.filter((name) => name !== entryName)),
    Effect.flatMap(
      Effect.forEach(readTextModule, { concurrency: "unbounded" }),
    ),
  );

  const vendored = resolvePythonModulesDir({ ...options, root }).pipe(
    Effect.flatMap((vendorDir) => {
      if (!vendorDir) {
        return Effect.succeed([]);
      }
      const readVendoredModule = Effect.fn(function* (name: string) {
        const content = yield* fs
          .readFile(path.join(vendorDir, name))
          .pipe(
            Effect.mapError(
              uvError(
                `Failed to read vendored module "${path.join(vendorDir, name)}"`,
              ),
            ),
          );
        const hash = yield* sha256(content);
        return {
          path: `python_modules/${name}`,
          content,
          hash,
        } satisfies Bundle.BundleFile;
      });
      return globFiles(["**/*"], {
        cwd: vendorDir,
        dot: true,
        // Compiled bytecode is host-specific and excluded by Wrangler too.
        ignore: ["**/*.pyc", "**/__pycache__/**"],
      }).pipe(
        Effect.flatMap(
          Effect.forEach(readVendoredModule, { concurrency: "unbounded" }),
        ),
      );
    }),
  );

  const [entry, additional, vendoredFiles] = yield* Effect.all(
    [readTextModule(entryName), sources, vendored],
    { concurrency: "unbounded" },
  );
  return yield* Bundle.bundleOutputFromFiles([
    entry,
    ...additional,
    ...vendoredFiles,
  ]);
});

/**
 * Watch a Python Worker for changes: emits the initial build, then
 * rebuilds whenever a file under the entry's directory changes (debounced).
 * Mirrors the {@link Bundle.BundleWatchEvent} protocol of the rolldown
 * watcher so local dev can consume either stream interchangeably.
 */
export const watchPythonWorkerBundle = (options: PythonWorkerBundleOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const main = yield* resolveMain(options.main);
      const root = path.dirname(main);
      const build = readPythonWorkerBundle(options).pipe(
        Effect.map(
          (output): Bundle.BundleWatchEvent => ({ _tag: "Success", output }),
        ),
        Effect.catch((error) =>
          Effect.succeed<Bundle.BundleWatchEvent>({ _tag: "Error", error }),
        ),
      );
      const rebuilds = fs.watch(root).pipe(
        Stream.filter(
          (event) =>
            !event.path.includes("__pycache__") &&
            !event.path.includes("/python_modules/"),
        ),
        Stream.debounce("200 millis"),
        Stream.flatMap(() =>
          Stream.make({ _tag: "Start" } as Bundle.BundleWatchEvent).pipe(
            Stream.concat(Stream.fromEffect(build)),
          ),
        ),
        Stream.catchCause(() => Stream.empty),
      );
      return Stream.fromEffect(build).pipe(Stream.concat(rebuilds));
    }),
  );
