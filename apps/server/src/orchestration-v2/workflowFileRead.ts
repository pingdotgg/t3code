// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { OrchestrationWorkflowFileError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

export interface WorkflowFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function workflowFilesRoot(home: string, configDir?: string): string {
  return NodePath.join(configDir?.trim() || NodePath.join(home, ".claude"), "projects");
}

export const readContainedWorkflowFile = Effect.fn("orchestration.readContainedWorkflowFile")(
  function* (input: {
    readonly path: string;
    readonly extension: string;
    readonly byteCap: number;
    readonly tail?: boolean;
    readonly configDir?: string;
    /**
     * Read only complete lines from this byte offset of the file `identity`
     * names. A different file (shrunk or another inode) is read from 0.
     */
    readonly fromOffset?: {
      readonly offset: number;
      readonly identity: WorkflowFileIdentity | null;
    };
  }) {
    if (!NodePath.isAbsolute(input.path) || NodePath.extname(input.path) !== input.extension) {
      return yield* new OrchestrationWorkflowFileError({
        reason: "invalid-path",
        path: input.path,
      });
    }

    const home = yield* HostProcess.HomeDirectory;
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(workflowFilesRoot(home, input.configDir)),
      catch: (cause) =>
        new OrchestrationWorkflowFileError({
          reason: "root-unavailable",
          path: input.path,
          cause,
        }),
    });

    // Realpath the FILE itself (not just its directory): a symlink named
    // like a transcript inside a contained directory must not escape.
    const resolved = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.path),
      catch: (cause) =>
        new OrchestrationWorkflowFileError({ reason: "not-found", path: input.path, cause }),
    });

    if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
      return yield* new OrchestrationWorkflowFileError({ reason: "outside-root", path: resolved });
    }
    if (NodePath.extname(resolved) !== input.extension) {
      return yield* new OrchestrationWorkflowFileError({
        reason: "wrong-extension",
        path: resolved,
      });
    }

    // fd inode vs path inode catches a swapped leaf, not a swapped intermediate
    // dir; root is 0700 ~/.claude, so that already needs the uid we run as.
    const read = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(
          resolved,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) {
            return { failure: "not-regular-file" as const };
          }
          const pathStat = await NodeFSP.lstat(resolved);
          if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
            return { failure: "changed-during-read" as const };
          }
          const identity = { dev: stat.dev, ino: stat.ino };
          if (input.fromOffset !== undefined) {
            const previous = input.fromOffset.identity;
            const start =
              previous !== null &&
              previous.dev === identity.dev &&
              previous.ino === identity.ino &&
              input.fromOffset.offset <= stat.size
                ? input.fromOffset.offset
                : 0;
            const buffer = Buffer.alloc(Math.min(stat.size - start, input.byteCap));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            const read = buffer.subarray(0, bytesRead);
            // A writer may be mid-line; leave it for the next read. A single
            // line over the cap is skipped so the cursor can't stall on it.
            const lineEnd = read.lastIndexOf(0x0a) + 1;
            const consumed = lineEnd === 0 && bytesRead === input.byteCap ? bytesRead : lineEnd;
            return {
              contents: read.subarray(0, lineEnd).toString("utf8"),
              // Only the cap can leave complete lines unread; a half-written
              // last line is not truncation.
              truncated: stat.size - start > input.byteCap,
              startOffset: start,
              endOffset: start + consumed,
              identity,
            };
          }
          const buffer = Buffer.alloc(Math.min(stat.size, input.byteCap + (input.tail ? 1 : 0)));
          const truncated = stat.size > buffer.length;
          const offset = input.tail ? stat.size - buffer.length : 0;
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          return {
            contents: buffer.subarray(0, bytesRead).toString("utf8"),
            truncated,
            startOffset: offset,
            endOffset: offset + bytesRead,
            identity,
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

    return {
      path: resolved,
      contents: read.contents,
      truncated: read.truncated,
      startOffset: read.startOffset,
      endOffset: read.endOffset,
      identity: read.identity,
    };
  },
);
