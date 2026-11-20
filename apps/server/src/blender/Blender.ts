import {
  BLENDER_MINIMUM_VERSION,
  type BlenderExecutableSource,
  type BlenderProbeFailure,
  type BlenderStatus,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

const PROBE_TIMEOUT = "15 seconds";
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
// Blender may print startup warnings before its version line.
const VERSION_LINE = /^Blender (\d+)\.(\d+)(?:\.(\d+))?/m;

/**
 * The environment's Blender integration. Settings and agents read availability through it; jobs
 * (edit, export, render) will run through the executable it resolves.
 */
export class Blender extends Context.Service<
  Blender,
  {
    /** Resolves and probes Blender with `--version`. Never spawns while the integration is off. */
    readonly status: Effect.Effect<BlenderStatus, ServerSettingsError>;
  }
>()("t3/blender/Blender") {}

interface ResolvedExecutable {
  readonly executablePath: string;
  readonly source: BlenderExecutableSource;
}

const versionAtLeast = (major: number, minor: number) =>
  major > BLENDER_MINIMUM_VERSION.major ||
  (major === BLENDER_MINIMUM_VERSION.major && minor >= BLENDER_MINIMUM_VERSION.minor);

/** Standard install locations after PATH, most specific first. */
const standardInstallCandidates = Effect.fn("Blender.standardInstallCandidates")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Blender.app/Contents/MacOS/Blender",
        path.join(home, "Applications", "Blender.app", "Contents", "MacOS", "Blender"),
      ];
    case "win32": {
      // Installers put each release in its own "Blender X.Y" folder; prefer the newest.
      const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].flatMap((root) =>
        root ? [path.join(root, "Blender Foundation")] : [],
      );
      const candidates: string[] = [];
      for (const root of roots) {
        const releases = (yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [])))
          .flatMap((name) => {
            const match = /^Blender (\d+)\.(\d+)$/.exec(name);
            return match ? [{ name, major: Number(match[1]), minor: Number(match[2]) }] : [];
          })
          .toSorted((a, b) => b.major - a.major || b.minor - a.minor);
        candidates.push(...releases.map(({ name }) => path.join(root, name, "blender.exe")));
      }
      return candidates;
    }
    default:
      return [
        "/snap/bin/blender",
        "/var/lib/flatpak/exports/bin/org.blender.Blender",
        path.join(home, ".local", "share", "flatpak", "exports", "bin", "org.blender.Blender"),
        "/opt/blender/blender",
      ];
  }
});

/** An override is used as given and never falls back to detection. */
const resolveExecutable = Effect.fn("Blender.resolveExecutable")(function* (override: string) {
  if (override.length > 0) {
    const executablePath = yield* resolveCommandPath(override);
    return executablePath === null
      ? null
      : ({ executablePath, source: "override" } satisfies ResolvedExecutable);
  }
  const onPath = yield* resolveCommandPath("blender");
  if (onPath !== null)
    return { executablePath: onPath, source: "path" } satisfies ResolvedExecutable;
  for (const candidate of yield* standardInstallCandidates()) {
    const executablePath = yield* resolveCommandPath(candidate);
    if (executablePath !== null) {
      return { executablePath, source: "standard-install" } satisfies ResolvedExecutable;
    }
  }
  return null;
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Probes start on client request, so concurrent reads share one Blender process at a time.
  const probeLock = yield* Semaphore.make(1);

  const probe = Effect.fn("Blender.probe")(function* (resolved: ResolvedExecutable) {
    const failed = (reason: BlenderProbeFailure, exitCode?: number): BlenderStatus => ({
      _tag: "ProbeFailed",
      ...resolved,
      reason,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
    const output = yield* runner
      .run({
        command: resolved.executablePath,
        args: ["--version"],
        timeout: PROBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.tapError((error) => Effect.logInfo("Blender probe failed", { tag: error._tag })),
        Effect.option,
      );
    if (output._tag === "None") return failed("spawn-failed");
    const { timedOut, code, stdout } = output.value;
    if (timedOut) return failed("timed-out");
    if (code !== 0) return failed("nonzero-exit", code === null ? undefined : Number(code));
    const match = VERSION_LINE.exec(stdout);
    if (match === null) return failed("unrecognized-output");
    const [, major = "", minor = "", patch] = match;
    const version = [major, minor, ...(patch === undefined ? [] : [patch])].join(".");
    return versionAtLeast(Number(major), Number(minor))
      ? ({ _tag: "Available", ...resolved, version } satisfies BlenderStatus)
      : ({
          _tag: "Unsupported",
          ...resolved,
          version,
          minimumVersion: `${BLENDER_MINIMUM_VERSION.major}.${BLENDER_MINIMUM_VERSION.minor}`,
        } satisfies BlenderStatus);
  });

  const status = Effect.gen(function* () {
    const { blender } = yield* settings.getSettings;
    if (!blender.enabled) return { _tag: "Disabled" } satisfies BlenderStatus;
    const resolved = yield* resolveExecutable(blender.executablePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (resolved === null) {
      return {
        _tag: "NotFound",
        source: blender.executablePath.length > 0 ? "override" : "detection",
      } satisfies BlenderStatus;
    }
    return yield* probeLock.withPermit(probe(resolved));
  }).pipe(Effect.withSpan("Blender.status"));

  return Blender.of({ status });
});

export const layer = Layer.effect(Blender, make);
