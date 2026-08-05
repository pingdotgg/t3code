// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const decodeTranscriptEntry = Schema.decodeUnknownExit(
  Schema.fromJsonString(
    Schema.Struct({
      cwd: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);

export type ClaudeSessionRecoveryResult = "available" | "rehomed" | "missing";

function latestTranscriptCwd(transcript: string): { readonly cwd: string | undefined } {
  let end = transcript.length;
  while (end > 0) {
    const newline = transcript.lastIndexOf("\n", end - 1);
    const decoded = decodeTranscriptEntry(transcript.slice(newline + 1, end));
    if (Exit.isSuccess(decoded) && typeof decoded.value.cwd === "string") {
      return { cwd: decoded.value.cwd };
    }
    end = newline;
  }
  return { cwd: undefined };
}

function claudeProjectDirectoryName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const isDirectory = Effect.fn("isDirectory")(function* (candidate: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(candidate).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
});

const modifiedAtMillis = Effect.fn("modifiedAtMillis")(function* (candidate: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(candidate).pipe(
    Effect.map((info) =>
      Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() }),
    ),
    Effect.orElseSucceed(() => 0),
  );
});

const readTranscriptTail = Effect.fn("readTranscriptTail")(function* (transcriptPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const size = (yield* fileSystem.stat(transcriptPath)).size;
  const bytesToRead = size < FileSystem.MiB(8) ? size : FileSystem.MiB(8);
  return yield* fileSystem
    .stream(transcriptPath, {
      offset: size - bytesToRead,
      bytesToRead,
    })
    .pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (content, chunk) => content + chunk,
      ),
    );
});

export const recoverClaudeSession = Effect.fn("recoverClaudeSession")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly sessionId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = input.environment.CLAUDE_CONFIG_DIR?.trim();
  const configDirectory = configured
    ? path.resolve(input.cwd, configured)
    : path.join(NodeOS.homedir(), ".claude");
  const projectsDirectory = path.join(configDirectory, "projects");
  const targetDirectory = path.join(
    projectsDirectory,
    claudeProjectDirectoryName(path.resolve(input.cwd)),
  );
  const targetTranscript = path.join(targetDirectory, `${input.sessionId}.jsonl`);

  if (yield* fileSystem.exists(targetTranscript)) {
    return "available";
  }
  if (!(yield* fileSystem.exists(projectsDirectory))) {
    return "missing";
  }

  const orphanedTranscripts: Array<{ readonly path: string; readonly modifiedAtMillis: number }> =
    [];
  for (const entry of yield* fileSystem.readDirectory(projectsDirectory)) {
    const transcriptPath = path.join(projectsDirectory, entry, `${input.sessionId}.jsonl`);
    if (!(yield* fileSystem.exists(transcriptPath).pipe(Effect.orElseSucceed(() => false)))) {
      continue;
    }
    const { cwd: transcriptCwd } = latestTranscriptCwd(yield* readTranscriptTail(transcriptPath));
    if (transcriptCwd === undefined) {
      continue;
    }
    if (yield* isDirectory(transcriptCwd)) {
      return "available";
    }
    orphanedTranscripts.push({
      path: transcriptPath,
      modifiedAtMillis: yield* modifiedAtMillis(transcriptPath),
    });
  }

  const sourceTranscript = orphanedTranscripts.sort(
    (left, right) => right.modifiedAtMillis - left.modifiedAtMillis,
  )[0]?.path;
  if (!sourceTranscript) {
    return "missing";
  }

  yield* fileSystem.makeDirectory(targetDirectory, { recursive: true });
  yield* fileSystem.copyFile(sourceTranscript, targetTranscript);
  return "rehomed";
});
