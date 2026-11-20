import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewDiffChangeType, ReviewDiffPreviewSource } from "@t3tools/contracts";

export type Change = "added" | "modified" | "renamed" | "deleted";

export interface ChangeFile {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly previousPath: string | null;
  readonly change: Change;
  readonly additions: number;
  readonly deletions: number;
}

export interface ChangeDir {
  readonly kind: "dir";
  readonly name: string;
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly children: ReadonlyArray<ChangeNode>;
}

export type ChangeNode = ChangeFile | ChangeDir;

export interface ChangeSet {
  /** Folders first, then files, each by name, with every folder's counts summed over what is inside it. */
  readonly tree: ReadonlyArray<ChangeNode>;
  /** The files in the order the tree shows them. */
  readonly files: ReadonlyArray<ChangeFile>;
  readonly totals: {
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
  };
}

const CHANGE = {
  new: "added",
  deleted: "deleted",
  change: "modified",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
} as const satisfies Record<ReviewDiffChangeType, Change>;

type Stat = NonNullable<ReviewDiffPreviewSource["files"]>[number];

// An untracked-file overflow leaves the server's file list out, and the bounded patch is all it sends.
function statsOf(source: Pick<ReviewDiffPreviewSource, "files" | "diff">): ReadonlyArray<Stat> {
  if (source.files !== undefined) return source.files;
  if (source.diff.trim() === "") return [];
  return parsePatchFiles(source.diff).flatMap((patch) =>
    patch.files.map((file) => ({
      path: file.name,
      previousPath: file.prevName ?? null,
      changeType: file.type,
      additions: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
    })),
  );
}

const byKindThenName = (a: ChangeNode, b: ChangeNode) =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1;

interface DirDraft {
  readonly name: string;
  readonly path: string;
  additions: number;
  deletions: number;
  readonly dirs: Map<string, DirDraft>;
  readonly files: ChangeFile[];
}

function finish(draft: DirDraft): ChangeDir {
  const children: ChangeNode[] = [...draft.dirs.values()].map(finish);
  children.push(...draft.files);
  return {
    kind: "dir",
    name: draft.name,
    path: draft.path,
    additions: draft.additions,
    deletions: draft.deletions,
    children: children.toSorted(byKindThenName),
  };
}

/** A diff preview's files as a tree of folders with their added and removed line counts, and the totals. */
export function changeSetOf(
  source: Pick<ReviewDiffPreviewSource, "files" | "diff">,
  keep: (path: string) => boolean = () => true,
): ChangeSet {
  const files: ChangeFile[] = statsOf(source)
    .filter((stat) => keep(stat.path))
    .map((stat) => ({
      kind: "file",
      name: stat.path.slice(stat.path.lastIndexOf("/") + 1),
      path: stat.path,
      previousPath: stat.previousPath,
      change:
        stat.changeType !== undefined
          ? CHANGE[stat.changeType]
          : stat.previousPath !== null && stat.previousPath !== stat.path
            ? "renamed"
            : "modified",
      additions: stat.additions,
      deletions: stat.deletions,
    }));

  const top: DirDraft = {
    name: "",
    path: "",
    additions: 0,
    deletions: 0,
    dirs: new Map(),
    files: [],
  };
  for (const file of files) {
    let dir = top;
    for (const name of file.path.split("/").slice(0, -1)) {
      let next = dir.dirs.get(name);
      if (next === undefined) {
        next = {
          name,
          path: dir.path === "" ? name : `${dir.path}/${name}`,
          additions: 0,
          deletions: 0,
          dirs: new Map(),
          files: [],
        };
        dir.dirs.set(name, next);
      }
      next.additions += file.additions;
      next.deletions += file.deletions;
      dir = next;
    }
    dir.files.push(file);
  }

  const tree = finish(top).children;
  const ordered: ChangeFile[] = [];
  const walk = (nodes: ReadonlyArray<ChangeNode>) => {
    for (const node of nodes) {
      if (node.kind === "file") ordered.push(node);
      else walk(node.children);
    }
  };
  walk(tree);
  return {
    tree,
    files: ordered,
    totals: {
      files: ordered.length,
      additions: ordered.reduce((sum, file) => sum + file.additions, 0),
      deletions: ordered.reduce((sum, file) => sum + file.deletions, 0),
    },
  };
}

/** The first line of the new file that a diff touches, which is where the file view opens it. */
export function firstChangedLine(file: Pick<FileDiffMetadata, "hunks">): number {
  const hunk = file.hunks[0];
  if (hunk === undefined) return 1;
  const lead = hunk.hunkContent[0];
  return hunk.additionStart + (lead?.type === "context" ? lead.lines : 0);
}
