import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off -- FileSystem.remove uses rm; native rmdir is needed to refuse deletion if a directory becomes nonempty.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

class AgentInstructionFileError extends Schema.TaggedError<AgentInstructionFileError>()(
  "AgentInstructionFileError",
  { message: Schema.String },
) {}

export function agentInstructionRelativePath(threadId: string): string {
  const key = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
  return `.agents/t3/${key}/AGENT.md`;
}

// A chat owns one generated file, never a project-wide AGENTS.md or another chat's directory.
export const syncAgentInstructionFile = Effect.fn("syncAgentInstructionFile")(function* (input: {
  cwd: string;
  threadId: string;
  instructions: string;
  settled: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(input.cwd);
  const relativePath = agentInstructionRelativePath(input.threadId);
  const segments = relativePath.split("/");
  const marker = `<!-- T3 managed instructions: ${segments[2]} -->`;
  let parent = root;
  for (const segment of segments.slice(0, input.instructions.trim() ? -1 : 2)) {
    parent = path.join(parent, segment);
    if (!(yield* fs.exists(parent))) {
      if (input.settled) return;
      yield* fs.makeDirectory(parent, { recursive: true });
    }
    const actual = yield* fs.realPath(parent);
    if (actual !== parent)
      return yield* Effect.fail(
        new AgentInstructionFileError({
          message: "Agent instruction directories must not be symlinks.",
        }),
      );
  }
  if (!input.settled) {
    // This directory holds runtime material, not changes the coding agent should commit.
    yield* fs
      .writeFileString(path.join(root, ".agents", "t3", ".gitignore"), "*\n", { flag: "wx" })
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }
  const file = path.join(root, relativePath);
  if (yield* fs.exists(file)) {
    if ((yield* fs.realPath(file)) !== file)
      return yield* Effect.fail(
        new AgentInstructionFileError({ message: "Agent instruction file must not be a symlink." }),
      );
    const previous = yield* fs.readFileString(file);
    if (!previous.startsWith(`${marker}\n`))
      return yield* Effect.fail(
        new AgentInstructionFileError({
          message: "Refusing to replace an unmanaged agent instruction file.",
        }),
      );
    if (input.settled) {
      yield* fs.remove(file);
      // Preserve handoff documents and any user-added files. Only remove empty directories.
      for (const directory of [parent, path.dirname(parent), path.dirname(path.dirname(parent))]) {
        const removed = yield* Effect.tryPromise(async () => {
          try {
            if ((await NodeFSP.readdir(directory)).length !== 0) return false;
            await NodeFSP.rmdir(directory);
            return true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
            throw error;
          }
        });
        if (!removed) break;
      }
    }
    return;
  }
  if (!input.settled && input.instructions.trim()) {
    yield* fs.writeFileString(file, `${marker}\n\n${input.instructions.trim()}\n`, { flag: "wx" });
  }
});
