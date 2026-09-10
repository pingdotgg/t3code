// Node cp preserves relative symlink targets; Effect FileSystem.copy cannot do that.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

class QuickChatWorkspaceError extends Schema.TaggedError<QuickChatWorkspaceError>()(
  "QuickChatWorkspaceError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const PromotionNote = Schema.Struct({
  cwd: Schema.String,
  filesPath: Schema.NullOr(Schema.String),
});
const decodeNote = Schema.decodeUnknownEffect(Schema.fromJsonString(PromotionNote));
const encodeNote = Schema.encodeEffect(Schema.fromJsonString(PromotionNote));
const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** Owns only quick-chat scratch directories and their pending provider context. */
export const makeQuickChatWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const key = (threadId: ThreadId) => Buffer.from(threadId).toString("base64url");
  const directory = (threadId: ThreadId) =>
    path.join(config.stateDir, "quick-chats", key(threadId));
  const notePath = (threadId: ThreadId) =>
    path.join(config.stateDir, "quick-chat-promotions", `${key(threadId)}.json`);
  const removeDirectory = (threadId: ThreadId) =>
    fs.remove(directory(threadId), { recursive: true, force: true });
  const clearNote = (threadId: ThreadId) =>
    fs
      .remove(notePath(threadId), { force: true })
      .pipe(Effect.andThen(fs.remove(`${notePath(threadId)}.tmp`, { force: true })));
  const remove = Effect.fn("QuickChatWorkspace.remove")(function* (threadId: ThreadId) {
    yield* removeDirectory(threadId);
    yield* clearNote(threadId);
  });
  const prepare = Effect.fn("QuickChatWorkspace.prepare")(function* (
    threadId: ThreadId,
    cwd: string,
  ) {
    const source = directory(threadId);
    if (yield* fs.exists(notePath(threadId))) {
      return yield* new QuickChatWorkspaceError({
        detail: "A previous quick-chat transfer needs recovery before retrying.",
      });
    }
    if (yield* fs.exists(source)) {
      const expected = path.join(yield* fs.realPath(path.dirname(source)), key(threadId));
      const resolvedSource = yield* fs.realPath(source);
      const relativeTarget = path.relative(resolvedSource, yield* fs.realPath(cwd));
      if (
        relativeTarget === "" ||
        (!path.isAbsolute(relativeTarget) &&
          relativeTarget !== ".." &&
          !relativeTarget.startsWith(`..${path.sep}`))
      ) {
        return yield* new QuickChatWorkspaceError({
          detail: "The project workspace must be outside the quick-chat workspace.",
        });
      }
      if (resolvedSource !== expected)
        return yield* new QuickChatWorkspaceError({
          detail: "Quick-chat workspace must not be a symbolic link.",
        });
    }
    const entries = (yield* fs.exists(source)) ? yield* fs.readDirectory(source) : [];
    let filesPath: string | null = null;
    let ownsDestination = false;
    const rollback = Effect.gen(function* () {
      if (ownsDestination && filesPath !== null)
        yield* fs.remove(filesPath, { recursive: true, force: true });
      yield* clearNote(threadId);
    });
    yield* Effect.gen(function* () {
      if (entries.length > 0) {
        const parent = path.join(cwd, "quick-chat-files");
        yield* fs.makeDirectory(parent, { recursive: true });
        if (
          (yield* fs.realPath(parent)) !== path.join(yield* fs.realPath(cwd), "quick-chat-files")
        ) {
          return yield* new QuickChatWorkspaceError({
            detail: "The quick-chat-files destination must not be a symbolic link.",
          });
        }
        const destination = path.join(parent, key(threadId));
        filesPath = destination;
        // Reserve a new directory. Never merge into or overwrite project files.
        yield* fs.makeDirectory(filesPath);
        ownsDestination = true;
        yield* Effect.tryPromise({
          try: async () => {
            for (const entry of entries)
              await NodeFSP.cp(path.join(source, entry), path.join(destination, entry), {
                recursive: true,
                force: false,
                errorOnExist: true,
                preserveTimestamps: true,
                verbatimSymlinks: true,
              });
          },
          catch: (cause) =>
            new QuickChatWorkspaceError({ detail: "Could not copy quick-chat files.", cause }),
        }).pipe(Effect.uninterruptible);
      }
      yield* fs.makeDirectory(path.dirname(notePath(threadId)), { recursive: true });
      const temporaryNote = `${notePath(threadId)}.tmp`;
      yield* fs.writeFileString(temporaryNote, yield* encodeNote({ cwd, filesPath }));
      yield* fs.rename(temporaryNote, notePath(threadId));
    }).pipe(
      Effect.onError(() =>
        rollback.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove incomplete quick-chat transfer", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
    );
    return { rollback, commit: removeDirectory(threadId) };
  });
  const pendingNote = Effect.fn("QuickChatWorkspace.pendingNote")(function* (
    threadId: ThreadId,
    cwd: string,
  ) {
    if (!(yield* fs.exists(notePath(threadId)))) return null;
    const note = yield* decodeNote(yield* fs.readFileString(notePath(threadId)));

    // Complete cleanup if the server stopped after the metadata commit.
    yield* removeDirectory(threadId);
    return `[T3 Code workspace update]\nThis conversation was promoted from a quick chat to a project. Your working directory is now ${quotePath(cwd)}. ${note.filesPath === null ? "The previous quick-chat workspace contained no files." : `All files from your previous workspace ${quotePath(directory(threadId))} are now in ${quotePath(note.filesPath)}. Use this new location for those files; you may organize them into the project as needed.`}\n[/T3 Code workspace update]`;
  });
  return { directory, prepare, pendingNote, clearNote, remove };
});
