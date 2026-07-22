import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

/**
 * A pinned runtime is an exact `t3@<version>` npm-installed into
 * <baseDir>/runtime/versions/<version>. The boot service points its systemd
 * unit here, and server self-update installs the target version here before
 * switching over — never `npx t3`, whose cache is ephemeral and whose
 * registry fetch at boot would make startup depend on the network.
 */

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
// Boot-service setup and remote self-update share this module but can be
// constructed in separate layers. Serialize the complete check/install/
// sentinel transaction across all callers in this process.
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

export class PinnedRuntimeInstallError extends Schema.TaggedErrorClass<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

/**
 * Installs `t3@<version>` into the pinned runtime directory unless a complete
 * install is already there, and returns its paths. The sentinel is written
 * only after npm exits 0; checking the entry file alone is not enough — npm
 * extracts files before running native builds (node-pty), so a killed
 * install leaves a plausible-looking but broken tree behind.
 */
export const ensurePinnedRuntimeInstalled = Effect.fn("cloud.pinned_runtime.ensure_installed")(
  function* (input: {
    readonly baseDir: string;
    readonly version: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly runner: ProcessRunner.ProcessRunner["Service"];
  }) {
    const { fs, runner } = input;
    const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version);

    return yield* pinnedRuntimeInstallLock.withPermit(
      Effect.gen(function* () {
        const alreadyPinned = yield* Effect.all([
          fs.exists(paths.sentinelPath),
          fs.exists(paths.entryPath),
        ]).pipe(
          Effect.map(([sentinelExists, entryExists]) => sentinelExists && entryExists),
          Effect.mapError(
            (cause) =>
              new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
          ),
        );
        if (alreadyPinned) {
          return paths;
        }

        yield* fs.remove(paths.versionDir, { recursive: true, force: true }).pipe(
          Effect.andThen(fs.makeDirectory(paths.versionDir, { recursive: true })),
          Effect.mapError(
            (cause) =>
              new PinnedRuntimeInstallError({
                step: "preparing the pinned runtime directory",
                cause,
              }),
          ),
        );

        const installStep = "installing the pinned t3 runtime (this can take a few minutes)";
        yield* runner
          .run({
            command: "npm",
            args: [
              "install",
              "--prefix",
              paths.versionDir,
              "--no-fund",
              "--no-audit",
              `t3@${input.version}`,
            ],
            // Native deps (node-pty) can compile from source on slow boxes; the
            // ProcessRunner default of 60s would kill a healthy install.
            timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
          })
          .pipe(
            Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: installStep, cause })),
            Effect.filterOrFail(
              (result) => result.code === 0,
              (result) =>
                new PinnedRuntimeInstallError({
                  step: installStep,
                  exitCode: Number(result.code),
                  stdoutLength: result.stdout.length,
                  stderrLength: result.stderr.length,
                }),
            ),
            Effect.tapError(() =>
              fs.remove(paths.versionDir, { recursive: true, force: true }).pipe(Effect.ignore),
            ),
          );

        yield* fs
          .writeFileString(paths.sentinelPath, `${input.version}\n`)
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({ step: "recording the completed install", cause }),
            ),
          );

        return paths;
      }),
    );
  },
);

/** Removes one pinned runtime while holding the same process-wide lock used
 * by install/check/sentinel work, so cleanup cannot race another caller that
 * is materializing or reusing the runtime tree. */
export const removePinnedRuntimeInstallation = Effect.fn("cloud.pinned_runtime.remove")(
  function* (input: {
    readonly baseDir: string;
    readonly version: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version);
    yield* pinnedRuntimeInstallLock.withPermit(
      input.fs
        .remove(paths.versionDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PinnedRuntimeInstallError({ step: "removing the pinned runtime", cause }),
          ),
        ),
    );
  },
);
