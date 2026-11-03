import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Find all copies: a moved workspace can leave the same conversation in several projects. */
export const findClaudeTranscripts = Effect.fn("findClaudeTranscripts")(function* (
  projectsDirectory: string,
  sessionId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const matches: string[] = [];
  for (const project of yield* fs.readDirectory(projectsDirectory)) {
    const candidate = path.join(projectsDirectory, project, `${sessionId}.jsonl`);
    // Stray files beside project directories fail with ENOTDIR.
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
      matches.push(candidate);
  }
  return matches;
});
