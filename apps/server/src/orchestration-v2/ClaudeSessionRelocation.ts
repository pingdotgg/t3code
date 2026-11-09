import type { ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "../terminal/Manager.ts";
import type * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

class ClaudeSessionRelocationError extends Schema.TaggedError<ClaudeSessionRelocationError>()(
  "ClaudeSessionRelocationError",
  {
    reason: Schema.Literals(["relative-config-dir", "provider-thread-changed", "foreign-session"]),
    path: Schema.optional(Schema.String),
  },
) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSessionRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
);
const errnoCode = (error: PlatformError.PlatformError) =>
  (error.cause as NodeJS.ErrnoException | undefined)?.code;
const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";
type CopyDirectory = (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError>;
const projectDirOverride = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$)[A-Za-z0-9_-]{1,64}$/i;

export function claudeConfigDirRefusal(path: Path.Path, environment: NodeJS.ProcessEnv) {
  const configDir = environment.CLAUDE_CONFIG_DIR;
  return configDir !== undefined && !path.isAbsolute(configDir)
    ? `CLAUDE_CONFIG_DIR ("${configDir}") is not an absolute path, so Claude's configuration folder would change with the working folder.`
    : undefined;
}

export function claudeProjectDirName(folder: string, environment: NodeJS.ProcessEnv): string {
  const { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PROJECT_DIR_NAME: override } = environment;
  if (configDir && override && projectDirOverride.test(override)) return override;
  const name = folder.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < folder.length; i++) hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

// Claude Code 2.1.319's relocateSessionTranscript; the SDK has no relocation call.
const relocateClaudeTranscript = Effect.fn("ClaudeSessionRelocation.relocateTranscript")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly sessionId: string;
    readonly oldFolder: string;
    readonly newFolder: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const configDir =
      input.environment.CLAUDE_CONFIG_DIR ?? path.join(yield* HostProcess.HomeDirectory, ".claude");
    const projectsDir = path.join(configDir.normalize("NFC"), "projects");
    const projectDir = (folder: string) =>
      path.join(projectsDir, claudeProjectDirName(folder, input.environment));
    const resolveFolder = (folder: string) =>
      fileSystem.realPath(folder).pipe(
        Effect.orElseSucceed(() => path.resolve(folder)),
        Effect.map((resolved) => (platform === "darwin" ? resolved.normalize("NFC") : resolved)),
      );
    const setAside = Effect.fnUntraced(function* (destination: string) {
      const now = yield* DateTime.now;
      const aside = `${destination}.superseded-${DateTime.toEpochMillis(now)}`;
      return yield* fileSystem.rename(destination, aside).pipe(
        Effect.andThen(
          fileSystem.utimes(aside, DateTime.toDate(now), DateTime.toDate(now)).pipe(Effect.ignore),
        ),
        Effect.as(aside),
        Effect.catchIf(isNotFound, () => Effect.undefined),
      );
    });
    const restore = (aside: string | undefined, destination: string) =>
      aside === undefined ? Effect.void : fileSystem.rename(aside, destination).pipe(Effect.ignore);
    const copyDirectory: CopyDirectory = Effect.fnUntraced(function* (from: string, to: string) {
      yield* fileSystem.makeDirectory(to, { recursive: true, mode: 0o700 });
      for (const entry of yield* fileSystem.readDirectoryEntries(from)) {
        yield* (entry.type === "Directory" ? copyDirectory : fileSystem.copyFile)(
          path.join(from, entry.name),
          path.join(to, entry.name),
        );
      }
    });
    const renameWithFallbacks = (from: string, to: string) =>
      fileSystem.rename(from, to).pipe(
        Effect.catch((error) => {
          const code = errnoCode(error);
          if (code === "EEXIST" || code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY") {
            return setAside(to).pipe(
              Effect.orElseSucceed(() => undefined),
              Effect.flatMap((aside) =>
                fileSystem.rename(from, to).pipe(Effect.tapError(() => restore(aside, to))),
              ),
            );
          }
          if (code !== "EXDEV") return Effect.fail(error);
          return fileSystem.copyFile(from, to).pipe(
            Effect.catchIf(
              (copyError) => ["EISDIR", "ENOTSUP", "EPERM"].includes(errnoCode(copyError) ?? ""),
              () =>
                Effect.flatMap(setAside(to), (aside) =>
                  copyDirectory(from, to).pipe(
                    Effect.tapError(() =>
                      aside === undefined
                        ? Effect.void
                        : fileSystem
                            .remove(to, { recursive: true, force: true })
                            .pipe(Effect.ignore, Effect.andThen(restore(aside, to))),
                    ),
                  ),
                ),
            ),
            Effect.andThen(fileSystem.remove(from, { recursive: true, force: true })),
          );
        }),
      );

    const relocatedCwd = yield* resolveFolder(input.newFolder);
    const oldDir = projectDir(yield* resolveFolder(input.oldFolder));
    const newDir = projectDir(relocatedCwd);
    const oldFile = path.join(oldDir, `${input.sessionId}.jsonl`);
    const newFile = path.join(newDir, `${input.sessionId}.jsonl`);
    const record = encodeJson({ type: "relocated", sessionId: input.sessionId, relocatedCwd });
    const sourcePresent = yield* fileSystem.exists(oldFile);
    if (!sourcePresent && !(yield* fileSystem.exists(newFile))) return;
    if (sourcePresent && oldDir !== newDir) {
      yield* fileSystem.makeDirectory(newDir, { recursive: true, mode: 0o700 });
      const [from, to] = yield* Effect.all([fileSystem.stat(oldDir), fileSystem.stat(newDir)]);
      const sameDirectory = from.dev === to.dev && Equal.equals(from.ino, to.ino);
      const superseded = sameDirectory ? undefined : yield* setAside(newFile);
      yield* renameWithFallbacks(oldFile, newFile).pipe(
        Effect.tapError(() => restore(superseded, newFile)),
      );
    }
    const contents = yield* fileSystem.readFileString(newFile);
    // As the SDK does, read which session a transcript belongs to from its first sessionId.
    const owner = Arr.findFirst(contents.split("\n"), (line) => decodeSessionRecord(line));
    if (!sourcePresent && Option.getOrUndefined(owner)?.sessionId !== input.sessionId) {
      return yield* new ClaudeSessionRelocationError({ reason: "foreign-session", path: newFile });
    }
    if (oldDir !== newDir) {
      yield* renameWithFallbacks(
        path.join(oldDir, input.sessionId),
        path.join(newDir, input.sessionId),
      ).pipe(
        Effect.catchIf(isNotFound, () => Effect.void),
        Effect.tapError((cause) =>
          Effect.logWarning("orchestration-v2.claude-relocation.subagent-folder-failed", { cause }),
        ),
      );
    }
    // Like Claude, end a torn last line before appending; a whole last line that is the record
    // needs only its newline.
    const tail = `\n${contents}`;
    if (!tail.endsWith(`\n${record}\n`)) {
      yield* fileSystem
        .writeFileString(
          newFile,
          tail.endsWith(`\n${record}`) ? "\n" : `${/[^\n]$/.test(contents) ? "\n" : ""}${record}\n`,
          { flag: "a" },
        )
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("orchestration-v2.claude-relocation.record-failed", { cause }),
          ),
        );
    }
  },
);

export const relocateClaudeSessionStorage = Effect.fn(
  "ClaudeSessionRelocation.relocateSessionStorage",
)(function* (
  threadId: ThreadId,
  request: Extract<
    EffectOutbox.OrchestrationEffectRequestV2,
    { readonly type: "provider-session.relocate-storage" }
  >,
) {
  if (request.driver !== "claudeAgent") return;
  const path = yield* Path.Path;
  const environment = yield* resolveProviderInstanceTerminalEnvironment({
    serverSettings: yield* ServerSettings.ServerSettingsService,
    path,
    rawProviderInstanceId: request.providerInstanceId,
    env: (yield* HostProcess.Environment) as Record<string, string>,
  });
  if (claudeConfigDirRefusal(path, environment) !== undefined) {
    return yield* new ClaudeSessionRelocationError({ reason: "relative-config-dir" });
  }
  yield* relocateClaudeTranscript({
    environment,
    sessionId: request.nativeSessionId,
    oldFolder: request.oldFolder,
    newFolder: request.newFolder,
  });
  const { providerThreads } =
    yield* (yield* ThreadManagementService.ThreadManagementService).getThreadRecords(threadId, [
      "providerThreads",
    ]);
  const providerThread = providerThreads.find((row) => row.id === request.providerThreadId);
  if (providerThread === undefined) return;
  const now = yield* DateTime.now;
  const { committed } = yield* (yield* EventSink.EventSinkV2).writeIfProviderThreadUnchanged({
    expected: providerThread,
    events: [
      {
        id: yield* (yield* IdAllocator.IdAllocatorV2).allocate.event({ threadId }),
        type: "provider-thread.updated",
        threadId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: now,
        payload: { ...providerThread, nativeStorageFolder: request.newFolder, updatedAt: now },
      },
    ],
  });
  if (!committed) {
    return yield* new ClaudeSessionRelocationError({ reason: "provider-thread-changed" });
  }
});
