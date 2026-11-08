import {
  NOTE_MAX_BYTES,
  NOTES_LIST_LIMIT,
  NotesError,
  type NotesListInput,
  type NotesListResult,
  type NotesReadInput,
  type NotesReadResult,
  type NotesWriteInput,
  type NotesWriteResult,
  type NoteSummary,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";

const SNIPPET_RADIUS = 60;

export class NotesService extends Context.Service<
  NotesService,
  {
    readonly list: (input: NotesListInput) => Effect.Effect<NotesListResult, NotesError>;
    readonly read: (input: NotesReadInput) => Effect.Effect<NotesReadResult, NotesError>;
    readonly write: (input: NotesWriteInput) => Effect.Effect<NotesWriteResult, NotesError>;
  }
>()("t3/notes/NotesService") {}

const isMarkdown = (name: string) => name.toLowerCase().endsWith(".md");
const noteTitle = (relativePath: string) =>
  (relativePath.split("/").at(-1) ?? relativePath).replace(/\.md$/i, "");

function snippetAround(content: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(content.length, index + length + SNIPPET_RADIUS);
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < content.length ? "…" : ""}`;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const resolveVault = Effect.fn("NotesService.resolveVault")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new NotesError({ reason: "read-failed", cause })),
    );
    if (settings.notesVaultPath === "") return yield* new NotesError({ reason: "unconfigured" });
    const expanded = expandHomePath(settings.notesVaultPath, yield* HostProcess.HomeDirectory);
    if (!path.isAbsolute(expanded)) return yield* new NotesError({ reason: "vault-missing" });
    const vault = yield* fileSystem
      .realPath(expanded)
      .pipe(Effect.mapError((cause) => new NotesError({ reason: "vault-missing", cause })));
    const info = yield* fileSystem
      .stat(vault)
      .pipe(Effect.mapError((cause) => new NotesError({ reason: "vault-missing", cause })));
    if (info.type !== "Directory") return yield* new NotesError({ reason: "vault-missing" });
    return vault;
  });

  const isInsideVault = (vault: string, target: string) => {
    const relative = path.relative(vault, target);
    return !(
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };

  // Untraced: recursion runs once per folder inside NotesService.list's span.
  // Symlinks are skipped so the walk cannot leave the vault or loop.
  const collectMarkdownFiles = Effect.fnUntraced(function* (
    directory: string,
  ): Effect.fn.Return<ReadonlyArray<string>, NotesError> {
    const entries = yield* fileSystem
      .readDirectoryEntries(directory)
      .pipe(Effect.mapError((cause) => new NotesError({ reason: "read-failed", cause })));
    const nested = yield* Effect.forEach(
      entries,
      (entry) => {
        if (entry.name.startsWith(".")) return Effect.succeed([]);
        const absolute = path.join(directory, entry.name);
        if (entry.type === "Directory") return collectMarkdownFiles(absolute);
        return Effect.succeed(entry.type === "File" && isMarkdown(entry.name) ? [absolute] : []);
      },
      { concurrency: 8 },
    );
    return nested.flat();
  });

  const list = Effect.fn("NotesService.list")(function* (input: NotesListInput) {
    const vault = yield* resolveVault();
    const files = yield* collectMarkdownFiles(vault);
    const query = input.query?.toLowerCase() ?? "";
    // ponytail: scans every note per search; add an index if vaults outgrow this.
    const summaries = yield* Effect.forEach(
      files,
      Effect.fnUntraced(function* (absolute) {
        const info = yield* fileSystem.stat(absolute).pipe(Effect.option);
        if (info._tag === "None") return null;
        const relativePath = path.relative(vault, absolute).split(path.sep).join("/");
        const summary: NoteSummary = {
          path: relativePath,
          title: noteTitle(relativePath),
          modifiedAt: info.value.mtime._tag === "Some" ? info.value.mtime.value.getTime() : 0,
          size: Number(info.value.size),
        };
        if (query === "" || relativePath.toLowerCase().includes(query)) return summary;
        if (summary.size > NOTE_MAX_BYTES) return null;
        const content = yield* fileSystem.readFileString(absolute).pipe(Effect.option);
        if (content._tag === "None") return null;
        const index = content.value.toLowerCase().indexOf(query);
        if (index < 0) return null;
        return { ...summary, snippet: snippetAround(content.value, index, query.length) };
      }),
      { concurrency: 16 },
    );
    const notes = summaries
      .filter((note) => note !== null)
      .toSorted((a, b) => b.modifiedAt - a.modifiedAt);
    return { notes: notes.slice(0, NOTES_LIST_LIMIT), truncated: notes.length > NOTES_LIST_LIMIT };
  });

  const read = Effect.fn("NotesService.read")(function* (input: NotesReadInput) {
    const vault = yield* resolveVault();
    if (!isMarkdown(input.path)) return yield* new NotesError({ reason: "not-markdown" });
    if (path.isAbsolute(input.path)) return yield* new NotesError({ reason: "outside-vault" });
    const real = yield* fileSystem.realPath(path.join(vault, input.path)).pipe(
      Effect.mapError(
        (cause) =>
          new NotesError({
            reason: cause.reason._tag === "NotFound" ? "not-found" : "read-failed",
            cause,
          }),
      ),
    );
    if (!isInsideVault(vault, real)) return yield* new NotesError({ reason: "outside-vault" });
    const relative = path.relative(vault, real);
    // A note inside the vault can still be a symlink to a file that is not Markdown.
    if (!isMarkdown(real)) return yield* new NotesError({ reason: "not-markdown" });
    const info = yield* fileSystem
      .stat(real)
      .pipe(Effect.mapError((cause) => new NotesError({ reason: "read-failed", cause })));
    if (info.type !== "File") return yield* new NotesError({ reason: "not-markdown" });
    if (Number(info.size) > NOTE_MAX_BYTES) return yield* new NotesError({ reason: "too-large" });
    const content = yield* fileSystem
      .readFileString(real)
      .pipe(Effect.mapError((cause) => new NotesError({ reason: "read-failed", cause })));
    const relativePath = relative.split(path.sep).join("/");
    return {
      path: relativePath,
      title: noteTitle(relativePath),
      content,
      modifiedAt: info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0,
    };
  });

  const write = Effect.fn("NotesService.write")(function* (input: NotesWriteInput) {
    const vault = yield* resolveVault();
    if (!isMarkdown(input.path)) return yield* new NotesError({ reason: "not-markdown" });
    if (path.isAbsolute(input.path)) return yield* new NotesError({ reason: "outside-vault" });
    const target = path.join(vault, input.path);
    if (!isInsideVault(vault, target)) return yield* new NotesError({ reason: "outside-vault" });
    const writeFailed = (cause: unknown) => new NotesError({ reason: "write-failed", cause });
    const parent = path.dirname(target);
    yield* fileSystem.makeDirectory(parent, { recursive: true }).pipe(Effect.mapError(writeFailed));
    // A symlinked folder inside the vault could still point outside it.
    const realParent = yield* fileSystem.realPath(parent).pipe(Effect.mapError(writeFailed));
    if (realParent !== vault && !isInsideVault(vault, realParent)) {
      return yield* new NotesError({ reason: "outside-vault" });
    }
    const exists = yield* fileSystem.exists(target).pipe(Effect.mapError(writeFailed));
    if (exists) {
      if (input.createOnly === true) return yield* new NotesError({ reason: "already-exists" });
      const real = yield* fileSystem.realPath(target).pipe(Effect.mapError(writeFailed));
      if (!isInsideVault(vault, real)) return yield* new NotesError({ reason: "outside-vault" });
      if (!isMarkdown(real)) return yield* new NotesError({ reason: "not-markdown" });
    }
    yield* fileSystem.writeFileString(target, input.content).pipe(Effect.mapError(writeFailed));
    return { path: path.relative(vault, target).split(path.sep).join("/") };
  });

  return NotesService.of({ list, read, write });
});

export const layer = Layer.effect(NotesService, make);
