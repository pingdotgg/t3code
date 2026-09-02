import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * Every Claude instance shares one continuation group. A thread can move
 * between Claude config directories because the adapter carries the session
 * transcript into the target directory before resuming
 * (see `carryOverClaudeSessionTranscript`).
 */
export const CLAUDE_CONTINUATION_GROUP_KEY = "claude:session-transcript";

/**
 * Claude Code keeps one transcript per session under
 * `<config dir>/projects/<project dir>/<session id>.jsonl`, where the project
 * dir is the session cwd with every non-alphanumeric character replaced by `-`.
 */
export function claudeProjectDirectoryName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ClaudeSessionTranscriptCarryOver {
  readonly fromHomePath: string;
  readonly toHomePath: string;
  readonly sessionId: string;
  readonly cwd: string | undefined;
}

/**
 * Copy a session transcript (and its sidecar directory holding subagent
 * transcripts and tool results) from one Claude config directory into
 * another so `--resume` works there. Returns `false` when the source has no
 * transcript for the session, so the caller can fall through to the normal
 * resume path and let Claude Code report the missing session.
 */
export const carryOverClaudeSessionTranscript = Effect.fn("carryOverClaudeSessionTranscript")(
  function* (
    input: ClaudeSessionTranscriptCarryOver,
  ): Effect.fn.Return<boolean, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (input.fromHomePath === input.toHomePath) return false;

    const fromProjects = path.join(input.fromHomePath, "projects");
    const transcriptName = `${input.sessionId}.jsonl`;
    const preferredProject = input.cwd ? claudeProjectDirectoryName(input.cwd) : undefined;
    const candidates = preferredProject ? [preferredProject] : [];
    if (yield* fileSystem.exists(fromProjects)) {
      for (const entry of yield* fileSystem.readDirectory(fromProjects)) {
        if (entry !== preferredProject) candidates.push(entry);
      }
    }

    for (const project of candidates) {
      const fromTranscript = path.join(fromProjects, project, transcriptName);
      if (!(yield* fileSystem.exists(fromTranscript))) continue;

      const toProject = path.join(input.toHomePath, "projects", project);
      yield* fileSystem.makeDirectory(toProject, { recursive: true });
      yield* fileSystem.copyFile(fromTranscript, path.join(toProject, transcriptName));

      const fromSidecar = path.join(fromProjects, project, input.sessionId);
      if (yield* fileSystem.exists(fromSidecar)) {
        yield* fileSystem.copy(fromSidecar, path.join(toProject, input.sessionId), {
          overwrite: true,
        });
      }
      return true;
    }
    return false;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);
