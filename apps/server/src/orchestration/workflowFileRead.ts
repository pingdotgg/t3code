// @effect-diagnostics nodeBuiltinImport:off
/**
 * Contained reads of files the Claude harness persisted for a workflow run.
 *
 * Containment rules (lifted from the reviewed #3650 inspection service):
 * - the resolved realpath must live under ~/.claude/projects (where the
 *   Claude harness persists workflow scripts and member transcripts) —
 *   realpath re-containment defeats symlink escapes, including a symlinked
 *   leaf file;
 * - only the caller's expected extension is served;
 * - reads are size-capped rather than failed, with a truncation marker.
 *
 * The client-supplied path is a hint from the workflow's runHandles; it is
 * never trusted beyond these checks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationWorkflowFileError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

function workflowFilesRoot(): string {
  return NodePath.join(NodeOS.homedir(), ".claude", "projects");
}

export const readContainedWorkflowFile = Effect.fn("orchestration.readContainedWorkflowFile")(
  function* (input: {
    readonly path: string;
    readonly extension: string;
    readonly byteCap: number;
  }) {
    const { byteCap } = input;
    const requested = input.path;

    if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== input.extension) {
      return yield* Effect.fail(
        new OrchestrationWorkflowFileError({ reason: "invalid-path", path: requested }),
      );
    }

    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(workflowFilesRoot()),
      catch: (cause) =>
        new OrchestrationWorkflowFileError({
          reason: "root-unavailable",
          path: requested,
          cause,
        }),
    });

    // Realpath the FILE itself (not just its directory): a symlink named
    // like a transcript inside a contained directory must not escape.
    const resolved = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(requested),
      catch: (cause) =>
        new OrchestrationWorkflowFileError({ reason: "not-found", path: requested, cause }),
    });

    if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
      return yield* Effect.fail(
        new OrchestrationWorkflowFileError({ reason: "outside-root", path: resolved }),
      );
    }
    if (NodePath.extname(resolved) !== input.extension) {
      return yield* Effect.fail(
        new OrchestrationWorkflowFileError({ reason: "wrong-extension", path: resolved }),
      );
    }

    // fd inode vs path inode catches a swapped leaf, not a swapped intermediate
    // dir; root is 0700 ~/.claude, so that already needs the uid we run as.
    // Both containment checks fail with their own tagged reason; "read-failed"
    // is reserved for genuine platform failures with the real cause attached.
    const read = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(resolved, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) {
            return { failure: "not-regular-file" as const };
          }
          const pathStat = await NodeFSP.lstat(resolved);
          if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
            return { failure: "changed-during-read" as const };
          }
          const truncated = stat.size > byteCap;
          const buffer = Buffer.alloc(Math.min(stat.size, byteCap));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return {
            contents: buffer.subarray(0, bytesRead).toString("utf8"),
            truncated,
          };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new OrchestrationWorkflowFileError({ reason: "read-failed", path: resolved, cause }),
    });
    if ("failure" in read) {
      return yield* new OrchestrationWorkflowFileError({ reason: read.failure, path: resolved });
    }

    return { path: resolved, contents: read.contents, truncated: read.truncated };
  },
);
