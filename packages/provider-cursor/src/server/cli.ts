import type { CursorSettings } from "../settings.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  isCommandMissingCause,
  spawnAndCollect,
  type CommandResult,
} from "@t3tools/provider-core/server/snapshotProbe";

const CURSOR_DEFAULT_BINARY = "cursor-agent";
const ABOUT_TIMEOUT_MS = 12_000;

export function resolveCursorBinaryPath(
  cursorSettings: Pick<CursorSettings, "binaryPath">,
): string {
  const configured = cursorSettings.binaryPath?.trim();
  return configured && configured.length > 0 ? configured : CURSOR_DEFAULT_BINARY;
}

export interface CursorCliAbout {
  readonly version: string | null;
  readonly latestVersion: string | null;
  readonly latestStatus: string | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractAboutField(plain: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s{2,}(.+)$`, "mi").exec(plain);
  return nonEmpty(match?.[1]?.replace(/\s*\(.*\)\s*$/, ""));
}

function isCursorAboutJsonFormatUnsupported(result: CommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

export function parseCursorAboutOutput(result: CommandResult): CursorCliAbout {
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        cliVersion?: unknown;
        latestVersion?: unknown;
        latestStatus?: unknown;
      };
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          version: nonEmpty(parsed.cliVersion),
          latestVersion: nonEmpty(parsed.latestVersion),
          latestStatus: nonEmpty(parsed.latestStatus)?.toLowerCase() ?? null,
        };
      }
    } catch {
      // Fall through to the plain-text about table.
    }
  }

  const plain = trimmed.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
  return {
    version: extractAboutField(plain, "CLI Version"),
    latestVersion: extractAboutField(plain, "Latest"),
    latestStatus: null,
  };
}

/** Date builds sort by YYYYMMDD; same-day builds with different hashes are not ordered. */
export function compareCursorVersions(current: string, latest: string): number {
  const parse = (version: string) => {
    const match = /^(\d{4})\.(\d{2})\.(\d{2})(?:-([0-9a-f]+))?$/i.exec(version.trim());
    if (!match) return null;
    return {
      date: Number(`${match[1]}${match[2]}${match[3]}`),
      hash: match[4]?.toLowerCase() ?? "",
    };
  };
  const left = parse(current);
  const right = parse(latest);
  if (!left || !right) {
    return current === latest ? 0 : current < latest ? -1 : 1;
  }
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  if (left.hash === right.hash) return 0;
  // Same calendar build with a different hash: treat the advertised latest as newer.
  return -1;
}

export const probeCursorCliAbout = Effect.fn("probeCursorCliAbout")(function* (
  cursorSettings: Pick<CursorSettings, "binaryPath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<CursorCliAbout | null, never, ChildProcessSpawner.ChildProcessSpawner> {
  const binaryPath = resolveCursorBinaryPath(cursorSettings);
  const env = environment ?? {};
  const run = (args: ReadonlyArray<string>) =>
    resolveSpawnCommand(binaryPath, args, { env, extendEnv: true }).pipe(
      Effect.flatMap((resolved) =>
        spawnAndCollect(
          binaryPath,
          ChildProcess.make(resolved.command, resolved.args, {
            env,
            extendEnv: true,
            shell: resolved.shell,
          }),
        ),
      ),
    );

  const aboutResult = yield* run(["about", "--format", "json"]).pipe(
    Effect.filterOrElse(
      (result) => !isCursorAboutJsonFormatUnsupported(result),
      () => run(["about"]),
    ),
    Effect.timeoutOption(ABOUT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(aboutResult)) {
    if (!isCommandMissingCause(aboutResult.failure)) {
      yield* Effect.logWarning("Cursor Agent CLI about probe failed", {
        binaryPath,
      });
    }
    return null;
  }
  if (Option.isNone(aboutResult.success)) {
    yield* Effect.logWarning("Cursor Agent CLI about probe timed out", {
      binaryPath,
      timeoutMs: ABOUT_TIMEOUT_MS,
    });
    return null;
  }
  return parseCursorAboutOutput(aboutResult.success.value);
});
