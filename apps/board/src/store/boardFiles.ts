import * as Result from "effect/Result";

import {
  type Board,
  BOARD_FILE,
  BOARDS_DIR,
  type BoardIssue,
  DEFAULT_BUILDER_CAP,
  parseBoard,
  serializeBoard,
  uniqueSlug,
} from "../domain/board";

/**
 * The engine's project file calls. Every path is relative to the project, because
 * `projects.listEntries` rejects an absolute `directoryPath` and `projects.writeFile` only writes
 * inside the project.
 */
export interface ProjectFiles {
  /** Entries under a project-relative directory, or null when it does not exist. */
  readonly list: (
    cwd: string,
    directory: string,
  ) => Promise<ReadonlyArray<{ readonly path: string; readonly kind: string }> | null>;
  /** The file's text, or null when it does not exist. */
  readonly read: (cwd: string, path: string) => Promise<string | null>;
  readonly write: (cwd: string, path: string, contents: string) => Promise<void>;
}

export type ListedBoard =
  | { readonly ok: true; readonly folder: string; readonly board: Board }
  | { readonly ok: false; readonly folder: string; readonly issue: BoardIssue };

export type ValidBoard = Extract<ListedBoard, { readonly ok: true }>;

const IGNORE_FILE = `${BOARDS_DIR}/.gitignore`;
const boardPath = (folder: string) => `${BOARDS_DIR}/${folder}/${BOARD_FILE}`;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

async function listFolders(files: ProjectFiles, cwd: string) {
  const entries = (await files.list(cwd, BOARDS_DIR)) ?? [];
  return {
    folders: entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => baseName(entry.path)),
    hasIgnoreFile: entries.some((entry) => entry.path === IGNORE_FILE),
  };
}

/** Boards read at once, which keeps a project with many boards from flooding the socket. */
const READ_BATCH = 8;

/** Every `.agentboard/<slug>/board.json` in the project. A broken one is listed with its issue. */
export async function listBoards(
  files: ProjectFiles,
  cwd: string,
): Promise<ReadonlyArray<ListedBoard>> {
  const { folders } = await listFolders(files, cwd);
  const readOne = async (folder: string): Promise<ListedBoard | null> => {
    const text = await files.read(cwd, boardPath(folder));
    if (text === null) return null;
    const parsed = parseBoard(text);
    return Result.isSuccess(parsed)
      ? { ok: true, folder, board: parsed.success }
      : { ok: false, folder, issue: parsed.failure };
  };
  const listed: Array<ListedBoard | null> = [];
  for (let start = 0; start < folders.length; start += READ_BATCH) {
    listed.push(...(await Promise.all(folders.slice(start, start + READ_BATCH).map(readOne))));
  }
  return listed
    .filter((board) => board !== null)
    .toSorted((a, b) => a.folder.localeCompare(b.folder));
}

export interface NewBoard {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Writes `.agentboard/<slug>/board.json`, and the `.gitignore` that keeps git out of the whole folder. */
export async function createBoard(
  files: ProjectFiles,
  cwd: string,
  input: NewBoard,
): Promise<ValidBoard> {
  const { folders, hasIgnoreFile } = await listFolders(files, cwd);
  const slug = uniqueSlug(input.name, folders);
  const board: Board = {
    ...input,
    slug,
    orchestratorThreadId: null,
    archived: false,
    builderCap: DEFAULT_BUILDER_CAP,
  };
  if (!hasIgnoreFile) await files.write(cwd, IGNORE_FILE, "*\n");
  await files.write(cwd, boardPath(slug), serializeBoard(board));
  return { ok: true, folder: slug, board };
}

export function writeBoard(files: ProjectFiles, cwd: string, folder: string, board: Board) {
  return files.write(cwd, boardPath(folder), serializeBoard(board));
}

/** Adds the names to the board's docs in the board's own file, read fresh so two sends in a row both count. */
export async function appendDocs(
  files: ProjectFiles,
  cwd: string,
  folder: string,
  names: ReadonlyArray<string>,
  sentAt: string,
): Promise<void> {
  const text = await files.read(cwd, boardPath(folder));
  if (text === null) throw new Error(`${boardPath(folder)} is missing.`);
  const parsed = parseBoard(text);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.message);
  const docs = parsed.success.docs ?? [];
  const added = names
    .filter((name, at) => !docs.some((doc) => doc.name === name) && names.indexOf(name) === at)
    .map((name) => ({ name, sentAt }));
  if (added.length === 0) return;
  await writeBoard(files, cwd, folder, { ...parsed.success, docs: [...docs, ...added] });
}
