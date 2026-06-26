import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";

import { writeFileStringAtomically } from "../atomicWrite.ts";

export class WorkspaceFileError extends Schema.TaggedErrorClass<WorkspaceFileError>()(
  "WorkspaceFileError",
  {
    workspaceFilePath: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `WorkspaceFile ${this.operation} failed for ${this.workspaceFilePath}: ${this.detail}`;
  }
}

export interface ResolvedWorkspaceFolder {
  /** The `path` exactly as written in the file (relative, absolute, or `~`-prefixed). */
  readonly rawPath: string;
  /** Display name — the explicit `name` field if present, else the resolved basename. */
  readonly name: string;
  /** Absolute, normalized path (relative paths resolved against the file's directory). */
  readonly absolutePath: string;
  /** Whether the resolved folder currently exists on disk as a directory. */
  readonly exists: boolean;
  /** Whether the resolved folder is a git repository (has a `.git` marker). */
  readonly isGit: boolean;
}

export interface ResolvedWorkspaceFile {
  /** Absolute, normalized path to the `.code-workspace` file. */
  readonly workspaceFilePath: string;
  /** Directory containing the file — the project's `workspaceRoot` anchor. */
  readonly anchorDir: string;
  /** Every resolved folder entry, in file order. Missing/non-git folders are surfaced, not dropped. */
  readonly folders: ReadonlyArray<ResolvedWorkspaceFolder>;
  /** Absolute paths of folders that exist and are git repos — the project's `repoRoots`. */
  readonly repoRoots: ReadonlyArray<string>;
  /** The parsed document, preserved verbatim so unknown keys round-trip on write. */
  readonly document: unknown;
}

export interface WorkspaceFileFolderEdit {
  readonly path: string;
  readonly name?: string | undefined;
}

export interface WorkspaceFileShape {
  /**
   * Read and resolve a `.code-workspace` file: parse JSONC, resolve every
   * folder path, and classify git vs non-git. Missing/renamed folders are
   * surfaced (`exists: false`) rather than causing a failure.
   */
  readonly read: (
    workspaceFilePath: string,
  ) => Effect.Effect<ResolvedWorkspaceFile, WorkspaceFileError>;

  /**
   * Produce a new document with its `folders` array replaced, preserving all
   * other (unknown) top-level keys such as `settings`. Pure; pair with `write`.
   */
  readonly withFolders: (
    document: unknown,
    folders: ReadonlyArray<WorkspaceFileFolderEdit>,
  ) => unknown;

  /** Serialize a document to pretty JSON and atomically write it to disk. */
  readonly write: (input: {
    readonly workspaceFilePath: string;
    readonly document: unknown;
  }) => Effect.Effect<void, WorkspaceFileError>;
}

export class WorkspaceFile extends Context.Service<WorkspaceFile, WorkspaceFileShape>()(
  "t3/workspace/WorkspaceFile",
) {}

const FOLDER_RESOLVE_CONCURRENCY = 16;

/** A single `folders[]` entry. Excess keys are ignored on decode but preserved
 * via the verbatim `document` round-trip. */
const CodeWorkspaceFolder = Schema.Struct({
  path: Schema.String,
  name: Schema.optional(Schema.String),
});

const decodeDocument = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));
const decodeFolders = Schema.decodeUnknownEffect(Schema.Array(CodeWorkspaceFolder));
const encodeDocument = Schema.encodeUnknownEffect(fromJsonStringPretty(Schema.Unknown));

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") return NodeOS.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\"))
    return path.join(NodeOS.homedir(), input.slice(2));
  return input;
}

export const makeWorkspaceFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const hasGitMarker = (absolutePath: string) =>
    fileSystem.stat(path.join(absolutePath, ".git")).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    );

  const directoryExists = (absolutePath: string) =>
    fileSystem.stat(absolutePath).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const read: WorkspaceFileShape["read"] = Effect.fn("WorkspaceFile.read")(
    function* (workspaceFilePath) {
      const absoluteFilePath = path.resolve(expandHomePath(workspaceFilePath.trim(), path));
      const anchorDir = path.dirname(absoluteFilePath);

      const raw = yield* fileSystem.readFileString(absoluteFilePath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileError({
              workspaceFilePath,
              operation: "WorkspaceFile.read:readFile",
              detail: cause.message,
              cause,
            }),
        ),
      );

      const document = yield* decodeDocument(raw).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileError({
              workspaceFilePath,
              operation: "WorkspaceFile.read:parse",
              detail: cause.message,
              cause,
            }),
        ),
      );

      const foldersInput =
        typeof document === "object" && document !== null && "folders" in document
          ? ((document as { folders: unknown }).folders ?? [])
          : [];

      const folderEntries = yield* decodeFolders(foldersInput).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileError({
              workspaceFilePath,
              operation: "WorkspaceFile.read:folders",
              detail: cause.message,
              cause,
            }),
        ),
      );

      const folders = yield* Effect.forEach(
        folderEntries,
        (entry) =>
          Effect.gen(function* () {
            const expanded = expandHomePath(entry.path.trim(), path);
            const absolutePath = path.isAbsolute(expanded)
              ? path.resolve(expanded)
              : path.resolve(anchorDir, expanded);
            const exists = yield* directoryExists(absolutePath);
            const isGit = exists ? yield* hasGitMarker(absolutePath) : false;
            return {
              rawPath: entry.path,
              name: entry.name?.trim() || path.basename(absolutePath),
              absolutePath,
              exists,
              isGit,
            } satisfies ResolvedWorkspaceFolder;
          }),
        { concurrency: FOLDER_RESOLVE_CONCURRENCY },
      );

      const repoRoots = folders
        .filter((folder) => folder.exists && folder.isGit)
        .map((folder) => folder.absolutePath);

      return {
        workspaceFilePath: absoluteFilePath,
        anchorDir,
        folders,
        repoRoots,
        document,
      };
    },
  );

  const withFolders: WorkspaceFileShape["withFolders"] = (document, folders) => {
    const base =
      typeof document === "object" && document !== null
        ? (document as Record<string, unknown>)
        : {};
    return {
      ...base,
      folders: folders.map((folder) =>
        folder.name === undefined
          ? { path: folder.path }
          : { path: folder.path, name: folder.name },
      ),
    };
  };

  const write: WorkspaceFileShape["write"] = Effect.fn("WorkspaceFile.write")(function* (input) {
    const absoluteFilePath = path.resolve(expandHomePath(input.workspaceFilePath.trim(), path));

    const contents = yield* encodeDocument(input.document).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileError({
            workspaceFilePath: input.workspaceFilePath,
            operation: "WorkspaceFile.write:encode",
            detail: cause.message,
            cause,
          }),
      ),
    );

    yield* writeFileStringAtomically({
      filePath: absoluteFilePath,
      contents: `${contents}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new WorkspaceFileError({
            workspaceFilePath: input.workspaceFilePath,
            operation: "WorkspaceFile.write:write",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  return { read, withFolders, write } satisfies WorkspaceFileShape;
});

export const WorkspaceFileLive = Layer.effect(WorkspaceFile, makeWorkspaceFile);
