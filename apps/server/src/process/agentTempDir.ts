import { ThreadId } from "@t3tools/contracts";
import { AgentTempDir, type AgentTempDirShape } from "@t3tools/shared/AgentTempDir";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

// Agents and their tools default to /tmp, which is RAM on many Linux machines and fills
// its quota (every tool call then fails with EDQUOT). Each thread gets a disk-backed
// directory instead: inside its linked worktree, which removing the worktree deletes,
// or under the server's state directory. Claude Code reads CLAUDE_CODE_TMPDIR, not TMPDIR.

/**
 * Thread ids like `thread:delegated-task:…` contain `:`, which breaks PATH-style lists and
 * DYLD variables built from TMPDIR, so unsafe ids become a sanitised name plus a short hash.
 */
function agentTempFolderName(threadId: string) {
  if (/^[A-Za-z0-9._-]+$/.test(threadId)) return threadId;
  const hash = (Hash.string(threadId) >>> 0).toString(16).padStart(8, "0");
  return `${threadId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64)}-${hash}`;
}

/** Subagent chains share a worktree, so each thread keeps its own folder within it. */
function agentTempDirectories(
  path: Path.Path,
  input: {
    readonly stateDir: string;
    readonly threadId: string;
    readonly worktreePath: string | null;
  },
) {
  const roots = [
    ...(input.worktreePath === null ? [] : [path.join(input.worktreePath, ".t3", "tmp")]),
    path.join(input.stateDir, "tmp"),
  ];
  const folder = agentTempFolderName(input.threadId);
  // Folders named by the raw id predate the safe name; cleanup still removes them.
  const folders = folder === input.threadId ? [folder] : [folder, input.threadId];
  return {
    launch: path.join(roots[0]!, folder),
    all: roots.flatMap((root) => folders.map((name) => path.join(root, name))),
  };
}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  // Windows temp is per-user and on disk, and its tools read TEMP/TMP rather than TMPDIR.
  if (platform === "win32") return AgentTempDir.defaultValue();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;

  // A linked worktree's `.git` is a file; only there is the folder deleted with the checkout.
  const linkedWorktree = (cwd: string | undefined) =>
    cwd === undefined
      ? Effect.succeed(null)
      : fileSystem.stat(path.join(cwd, ".git")).pipe(
          Effect.map((info) => (info.type === "File" ? cwd : null)),
          Effect.orElseSucceed(() => null),
        );

  const environment: AgentTempDirShape["environment"] = Effect.fn("AgentTempDir.environment")(
    function* (input) {
      const worktreePath = yield* linkedWorktree(input.cwd);
      const { launch } = agentTempDirectories(path, {
        stateDir,
        threadId: input.threadId,
        worktreePath,
      });
      const ready = yield* fileSystem.makeDirectory(launch, { recursive: true }).pipe(
        // Ignores itself and every thread's folder, so the user's repository never
        // shows them and `git worktree remove` still treats the worktree as clean.
        Effect.andThen(
          worktreePath === null
            ? Effect.void
            : fileSystem.writeFileString(path.join(path.dirname(launch), ".gitignore"), "*\n"),
        ),
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Could not create the agent temp directory; agents keep the default", {
            directory: launch,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      return ready ? { TMPDIR: launch, CLAUDE_CODE_TMPDIR: launch } : {};
    },
  );

  return { environment } satisfies AgentTempDirShape;
});

export const layer = Layer.effect(AgentTempDir, make);

/** Deletes a thread's temp folders once it settles; a reopened thread gets a fresh one. */
export const removeThreadTempDirectories = Effect.fn("AgentTempDir.removeThreadTempDirectories")(
  function* (threadId: ThreadId) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const thread = yield* (yield* ProjectionStoreV2).getThreadShell(threadId);
    const { all } = agentTempDirectories(path, {
      stateDir,
      threadId,
      worktreePath: thread?.worktreePath ?? null,
    });
    yield* Effect.forEach(all, (directory) =>
      fileSystem.remove(directory, { recursive: true, force: true }),
    );
  },
);

export const layerSettledCleanup = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestratorV2;
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | ProjectionStoreV2
    >();
    yield* engine.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "thread.settled"),
      Stream.runForEach((event) =>
        removeThreadTempDirectories(event.threadId).pipe(
          Effect.provide(services),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove a settled thread's agent temp directory", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Agent temp directory cleanup stream failed", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
