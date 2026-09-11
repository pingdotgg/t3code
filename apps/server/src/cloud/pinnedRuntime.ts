import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

/**
 * A pinned runtime is an exact `t3@<version>` npm-installed into
 * <baseDir>/runtime/versions/<version>. The boot service points its unit or
 * launch agent here, and server self-update installs the target version here before
 * switching over, never `npx t3`, whose cache is ephemeral and whose
 * registry fetch at boot would make startup depend on the network.
 */

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
const PINNED_RUNTIME_VIEW_TIMEOUT = Duration.seconds(60);
/** Keep failures diagnosable without dumping an entire npm log into the CLI. */
const PINNED_RUNTIME_OUTPUT_TAIL_CHARS = 2048;
// Boot-service setup and remote update can construct separate layers. Serialize
// the complete install transaction across every caller in this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
): PinnedRuntimePaths {
  const versionDir = path.join(baseDir, PINNED_RUNTIME_DIR, "versions", version);
  return {
    versionDir,
    entryPath: path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedError<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    outputTail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const base =
      this.exitCode === undefined
        ? `Pinned runtime install failed while ${this.step}.`
        : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
    return this.outputTail === undefined || this.outputTail.length === 0
      ? base
      : `${base}\n${this.outputTail}`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedError<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * npm only honors `overrides` on the root project. Published `t3` carries Effect
 * pins, but they are ignored when `t3` is installed as a dependency into an empty
 * staging directory — caret ranges then float onto incompatible Effect RCs.
 * Re-apply only plain Effect package pins at the staging root before install.
 * Nested selectors (`pkg>dep`) and removal overrides (`-`) are publish-time
 * monorepo policy and are rejected by npm when copied into this staging root.
 */
function selectEffectOverrides(overrides: Record<string, unknown>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" || value === "-" || value.length === 0) continue;
    if (key === "effect" || /^@effect\/[^>]+$/.test(key)) {
      selected[key] = value;
    }
  }
  return selected;
}

function stderrOutputTail(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= PINNED_RUNTIME_OUTPUT_TAIL_CHARS) return trimmed;
  return trimmed.slice(trimmed.length - PINNED_RUNTIME_OUTPUT_TAIL_CHARS);
}

/**
 * Installs `t3@<version>` into the pinned runtime directory unless a complete
 * install is already there, and returns its paths. The sentinel is written
 * only after npm exits 0; checking the entry file alone is not enough. npm
 * extracts files before running native builds (node-pty), so a killed
 * install leaves a plausible-looking but broken tree behind.
 */
interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
}

const runNpm = (
  runner: ProcessRunner.ProcessRunner["Service"],
  args: ReadonlyArray<string>,
  timeout: Duration.Input,
) =>
  runner.run({ command: "npm", args, timeout }).pipe(
    Effect.catchTags({
      ProcessSpawnError: (error) =>
        error.cause instanceof PlatformError.PlatformError && error.cause.reason._tag === "NotFound"
          ? // pnpm-managed Node installations do not include npm. Keep npm
            // installation semantics for the pinned runtime and native builds.
            runner.run({
              command: "pnpm",
              args: ["--package=npm@11", "dlx", "npm", ...args],
              timeout,
            })
          : Effect.fail(error),
    }),
  );

const resolveTargetEffectOverrides = Effect.fn("cloud.pinned_runtime.resolve_effect_overrides")(
  function* (input: {
    readonly version: string;
    readonly runner: ProcessRunner.ProcessRunner["Service"];
  }) {
    const viewStep = "resolving Effect overrides for the pinned t3 runtime";
    const viewArgs = ["view", `t3@${input.version}`, "overrides", "--json"];
    const result = yield* runNpm(input.runner, viewArgs, PINNED_RUNTIME_VIEW_TIMEOUT).pipe(
      Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: viewStep, cause })),
      Effect.filterOrFail(
        (output) => output.code === 0,
        (output) =>
          new PinnedRuntimeInstallError({
            step: viewStep,
            exitCode: Number(output.code),
            stdoutLength: output.stdout.length,
            stderrLength: output.stderr.length,
            outputTail: stderrOutputTail(output.stderr),
          }),
      ),
    );

    let parsed: unknown;
    try {
      const trimmed = result.stdout.trim();
      parsed = trimmed.length === 0 ? {} : JSON.parse(trimmed);
    } catch (cause) {
      return yield* new PinnedRuntimeInstallError({
        step: "decoding Effect overrides for the pinned t3 runtime",
        cause,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        outputTail: stderrOutputTail(result.stderr),
      });
    }

    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return yield* new PinnedRuntimeInstallError({
        step: "decoding Effect overrides for the pinned t3 runtime",
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        outputTail: stderrOutputTail(result.stderr),
      });
    }
    const record = parsed as Record<string, unknown>;
    // `npm view <pkg> overrides --json` usually returns the map itself; some
    // npm versions wrap it as `{ overrides: { … } }`.
    const overrides =
      record.overrides !== undefined &&
      typeof record.overrides === "object" &&
      record.overrides !== null &&
      !Array.isArray(record.overrides)
        ? (record.overrides as Record<string, unknown>)
        : record;
    return selectEffectOverrides(overrides);
  },
);

const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const { fs, runner } = input;
  const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version);
  const [versionDirExists, entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.versionDir),
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(
    Effect.mapError(
      (cause) => new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
    ),
  );
  const alreadyPinned =
    entryExists && Option.isSome(sentinel) && sentinel.value.trim() === input.version;
  if (alreadyPinned) {
    yield* input.validate(paths);
    return paths;
  }
  if (versionDirExists) {
    yield* fs.remove(paths.versionDir, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "removing an incomplete pinned runtime",
            cause,
          }),
      ),
    );
  }

  const versionsDir = input.path.dirname(paths.versionDir);
  yield* fs.makeDirectory(versionsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: "preparing the pinned runtime directory",
          cause,
        }),
    ),
  );
  const stagingDir = yield* fs
    .makeTempDirectory({
      directory: versionsDir,
      prefix: ".staging-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "preparing the pinned runtime directory",
            cause,
          }),
      ),
    );
  const stagingPaths: PinnedRuntimePaths = {
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, "node_modules", "t3", "dist", "bin.mjs"),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };

  return yield* Effect.gen(function* () {
    const overrides = yield* resolveTargetEffectOverrides({
      version: input.version,
      runner,
    });
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed npm install manifest.
    const stagingManifest = `${JSON.stringify(
      {
        dependencies: { t3: input.version },
        overrides,
      },
      null,
      2,
    )}\n`;
    yield* fs.writeFileString(input.path.join(stagingDir, "package.json"), stagingManifest).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "writing the pinned runtime install manifest",
            cause,
          }),
      ),
    );

    const installStep = "installing the pinned t3 runtime (this can take a few minutes)";
    const installArgs = ["install", "--prefix", stagingDir, "--no-fund", "--no-audit"];
    yield* runNpm(runner, installArgs, PINNED_RUNTIME_INSTALL_TIMEOUT).pipe(
      Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: installStep, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new PinnedRuntimeInstallError({
            step: installStep,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
            outputTail: stderrOutputTail(result.stderr),
          }),
      ),
    );

    yield* input.validate(stagingPaths);
    yield* fs
      .writeFileString(stagingPaths.sentinelPath, `${input.version}\n`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording the completed install", cause }),
        ),
      );
    const published = yield* fs.rename(stagingDir, paths.versionDir).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.all([
          fs.exists(paths.entryPath),
          fs.readFileString(paths.sentinelPath).pipe(Effect.option),
        ]).pipe(
          Effect.mapError(
            (checkCause) =>
              new PinnedRuntimeInstallError({
                step: "checking a concurrently published pinned runtime",
                cause: checkCause,
              }),
          ),
          Effect.flatMap(([publishedEntryExists, publishedSentinel]) =>
            publishedEntryExists &&
            Option.isSome(publishedSentinel) &&
            publishedSentinel.value.trim() === input.version
              ? Effect.succeed(false)
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "publishing the pinned runtime",
                    cause,
                  }),
                ),
          ),
        ),
      ),
    );
    if (!published) yield* input.validate(paths);
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensurePinnedRuntimeInstalled = (input: PinnedRuntimeInstallInput) =>
  pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input));
