import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
export const JJ_MINIMUM_VERSION = "0.42.0";

export type JjAvailability =
  | { readonly _tag: "available"; readonly version: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unsupported-version"; readonly version: string };

const VERSION_PATTERN = /^jj (\d+)\.(\d+)\.(\d+)/;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_OUTPUT_BYTES = 4_096;

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

/**
 * Probes `jj --version` at most once per server lifetime. Takes a cwd because jj refuses to run
 * without a valid existing working directory, even for `--version`; callers always have a resolved
 * workspace root in hand.
 */
export const makeJjAvailability = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const cached = yield* Ref.make(Option.none<JjAvailability>());
  const probeLock = yield* Semaphore.make(1);

  const probe = Effect.fn("JjAvailability.probe")(function* (cwd: string) {
    const result = yield* JjProcess.jjCommand(process, "JjAvailability.probe", cwd, ["--version"], {
      allowNonZeroExit: true,
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      maxOutputBytes: VERSION_PROBE_MAX_OUTPUT_BYTES,
    }).pipe(Effect.orElseSucceed(() => null));

    if (result === null || result.exitCode !== 0) {
      return { _tag: "missing" } as const;
    }

    const version = parseJjVersion(result.stdout);
    if (version === null) {
      return { _tag: "missing" } as const;
    }

    return isJjVersionSupported(version)
      ? ({ _tag: "available", version } as const)
      : ({ _tag: "unsupported-version", version } as const);
  });

  return Effect.fn("JjAvailability.availability")(function* (
    cwd: string,
  ): Effect.fn.Return<JjAvailability, never> {
    const known = yield* Ref.get(cached);
    if (Option.isSome(known)) {
      return known.value;
    }

    return yield* probeLock.withPermits(1)(
      Effect.gen(function* () {
        const raced = yield* Ref.get(cached);
        if (Option.isSome(raced)) {
          return raced.value;
        }
        const availability = yield* probe(cwd);
        yield* Ref.set(cached, Option.some(availability));
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
  if (input.availability._tag === "unsupported-version") {
    return `Jujutsu ${input.availability.version} is older than the supported minimum ${JJ_MINIMUM_VERSION}. Upgrade jj to use this repository in T3 Code.`;
  }
  if (!input.colocated) {
    return "T3 Code supports colocated Jujutsu repositories. Run `jj git init --colocate` in this repository, or open its Git checkout instead.";
  }
  return null;
}
