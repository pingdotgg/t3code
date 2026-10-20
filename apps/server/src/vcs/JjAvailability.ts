import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as JjProcess from "./JjProcess.ts";
import * as VcsProcess from "./VcsProcess.ts";

/**
 * The floor is the version every command, revset and template in the jj lane was verified against.
 * Lowering it requires a CI job that runs the jj suite against the new floor binary
 * (`.github/actions/setup-jj` takes a `version` input), not a guess about which release first
 * shipped `json()`, `stringify()` or `bookmark track --remote=`.
 */
const JJ_MINIMUM_VERSION = "0.46.0";

export type JjAvailability =
  | { readonly _tag: "available"; readonly version: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "broken"; readonly detail: string }
  | { readonly _tag: "unsupported-version"; readonly version: string };

const VERSION_PATTERN = /^jj (\d+)\.(\d+)\.(\d+)/;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_OUTPUT_BYTES = 4_096;
const UNUSABLE_PROBE_TTL_MS = 30_000;

// Discovery and the driver share a process service, but own separate probe lifetimes.
const invalidationVersions = new WeakMap<VcsProcess.VcsProcess["Service"], number>();

/** Makes the driver's next availability read re-probe after a Settings environment rescan. */
export function invalidateJjAvailability(process: VcsProcess.VcsProcess["Service"]): void {
  invalidationVersions.set(process, (invalidationVersions.get(process) ?? 0) + 1);
}

interface CachedAvailability {
  readonly availability: JjAvailability;
  readonly expiresAt: number;
  readonly invalidationVersion: number;
}

/**
 * Reads `major.minor.patch` out of a `jj --version` banner, ignoring the `-<hash>` suffix a source
 * build prints. `null` when the output is not a jj version banner at all.
 */
export function parseJjVersion(versionOutput: string): string | null {
  const line = versionOutput.split(/\r?\n/g).find((candidate) => candidate.trim().length > 0);
  const match = line === undefined ? null : VERSION_PATTERN.exec(line.trim());
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function versionParts(version: string): ReadonlyArray<number> {
  return version.split(".").map((part) => Number(part));
}

/** Whether a version parsed by {@link parseJjVersion} meets {@link JJ_MINIMUM_VERSION}. */
export function isJjVersionSupported(version: string): boolean {
  const observed = versionParts(version);
  const required = versionParts(JJ_MINIMUM_VERSION);
  for (let index = 0; index < required.length; index += 1) {
    const left = observed[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return true;
}

/** Caches usable binaries until rescan, and unusable probes briefly to avoid polling storms. */
export const makeJjAvailability = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const cached = yield* Ref.make(new Map<string, CachedAvailability>());
  const probeLock = yield* Semaphore.make(1);

  const readCached = (cwd: string) =>
    Effect.gen(function* () {
      const known = Option.fromUndefinedOr((yield* Ref.get(cached)).get(cwd));
      const now = yield* Clock.currentTimeMillis;
      return Option.filter(
        known,
        (entry) =>
          entry.expiresAt > now &&
          entry.invalidationVersion === (invalidationVersions.get(process) ?? 0),
      );
    });
  const probe = Effect.fn("JjAvailability.probe")(function* (cwd: string) {
    const result = yield* JjProcess.jjCommand(process, "JjAvailability.probe", cwd, ["--version"], {
      allowNonZeroExit: true,
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      maxOutputBytes: VERSION_PROBE_MAX_OUTPUT_BYTES,
    }).pipe(Effect.catch((error) => Effect.succeed(error)));

    if ("_tag" in result) {
      if (
        result._tag === "VcsProcessSpawnError" &&
        ((result.cause instanceof PlatformError.PlatformError &&
          result.cause.reason._tag === "NotFound") ||
          (typeof result.cause === "object" &&
            result.cause !== null &&
            "code" in result.cause &&
            result.cause.code === "ENOENT"))
      ) {
        return { _tag: "missing" } as const;
      }
      return { _tag: "broken", detail: result.message } as const;
    }
    if (result.exitCode !== 0) {
      return {
        _tag: "broken",
        detail: result.stderr.trim() || "Jujutsu version probe failed.",
      } as const;
    }

    const version = parseJjVersion(result.stdout);
    if (version === null) {
      return {
        _tag: "broken",
        detail: result.stderr.trim() || "Jujutsu version probe returned an invalid version banner.",
      } as const;
    }

    return isJjVersionSupported(version)
      ? ({ _tag: "available", version } as const)
      : ({ _tag: "unsupported-version", version } as const);
  });

  return Effect.fn("JjAvailability.availability")(function* (
    cwd: string,
  ): Effect.fn.Return<JjAvailability, never> {
    const known = yield* readCached(cwd);
    if (Option.isSome(known)) {
      return known.value.availability;
    }

    return yield* probeLock.withPermits(1)(
      Effect.gen(function* () {
        const raced = yield* readCached(cwd);
        if (Option.isSome(raced)) {
          return raced.value.availability;
        }
        const invalidationVersion = invalidationVersions.get(process) ?? 0;
        const availability = yield* probe(cwd);
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(cached, (entries) => {
          const next = new Map(entries);
          next.delete(cwd);
          if (next.size >= 64) {
            const oldest = next.keys().next();
            if (!oldest.done) next.delete(oldest.value);
          }
          next.set(cwd, {
            availability,
            expiresAt: availability._tag === "available" ? Infinity : now + UNUSABLE_PROBE_TTL_MS,
            invalidationVersion,
          });
          return next;
        });
        return availability;
      }),
    );
  });
});

/** The user-facing string that lands in `VcsStatusLocalResult.vcs.unsupportedReason`. */
export function jjUnsupportedReason(input: {
  readonly availability: JjAvailability;
  readonly colocated: boolean;
}): string | null {
  if (input.availability._tag === "missing") {
    return "Jujutsu is not installed on this server. Install jj, then rescan in Settings → Source Control.";
  }
  if (input.availability._tag === "broken") {
    return input.availability.detail;
  }
  if (input.availability._tag === "unsupported-version") {
    return `Jujutsu ${input.availability.version} is older than the supported minimum ${JJ_MINIMUM_VERSION}. Upgrade jj to use this repository in T3 Code.`;
  }
  if (!input.colocated) {
    return "T3 Code supports colocated Jujutsu repositories. Run `jj git init --colocate` in this repository, or open its Git checkout instead.";
  }
  return null;
}
