// Fold a flat list of changed files into a directory tree, mirroring the web's
// ChangedFilesTree. Pure so the tree shape + collapse flattening are unit-tested
// without a renderer. Single-child directory chains compact into one segment
// ("a/b/c") the way the web tree does, so deep nesting doesn't waste rows.

export interface TreeFileInput {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface FileLeaf {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface DirNode {
  readonly kind: "dir";
  readonly name: string;
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly children: ReadonlyArray<TreeNode>;
}

export type TreeNode = DirNode | FileLeaf;

interface MutableDir {
  name: string;
  path: string;
  readonly dirs: Map<string, MutableDir>;
  readonly files: FileLeaf[];
}

function emptyDir(name: string, path: string): MutableDir {
  return { name, path, dirs: new Map(), files: [] };
}

/** Build a directory tree (dirs first, then files; alpha within each) from changed files. */
export function buildFileTree(files: ReadonlyArray<TreeFileInput>): ReadonlyArray<TreeNode> {
  const root = emptyDir("", "");
  for (const file of files) {
    const segments = file.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const fileName = segments.at(-1) as string;
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      const childPath = cursor.path ? `${cursor.path}/${segment}` : segment;
      let next = cursor.dirs.get(segment);
      if (!next) {
        next = emptyDir(segment, childPath);
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push({
      kind: "file",
      name: fileName,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    });
  }
  // The root is a virtual container — return its children, never compact it.
  return finalizeChildren(root);
}

/** Sort + finalize a directory's children: dirs first (alpha), then files (alpha). */
function finalizeChildren(dir: MutableDir): TreeNode[] {
  const childDirs = [...dir.dirs.values()]
    .map(finalizeDir)
    .sort((a, b) => a.name.localeCompare(b.name));
  const childFiles = [...dir.files].sort((a, b) => a.name.localeCompare(b.name));
  return [...childDirs, ...childFiles];
}

function finalizeDir(dir: MutableDir): DirNode {
  // Compact a single-child directory chain (a → b → c) into one "a/b/c" node.
  let compacted = dir;
  while (compacted.files.length === 0 && compacted.dirs.size === 1) {
    const onlyChild = [...compacted.dirs.values()][0] as MutableDir;
    compacted = {
      name: `${compacted.name}/${onlyChild.name}`,
      path: onlyChild.path,
      dirs: onlyChild.dirs,
      files: onlyChild.files,
    };
  }

  const children = finalizeChildren(compacted);
  let additions = 0;
  let deletions = 0;
  for (const child of children) {
    additions += child.additions;
    deletions += child.deletions;
  }
  return {
    kind: "dir",
    name: compacted.name,
    path: compacted.path,
    additions,
    deletions,
    children,
  };
}

/** Every directory path in the tree, e.g. for an initial expand-all state. */
export function collectDirPaths(nodes: ReadonlyArray<TreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "dir") {
      paths.push(node.path);
      paths.push(...collectDirPaths(node.children));
    }
  }
  return paths;
}

export interface FlatTreeRow {
  readonly kind: "dir" | "file";
  readonly name: string;
  readonly path: string;
  readonly depth: number;
  readonly additions: number;
  readonly deletions: number;
  /** For dir rows only: whether its children are hidden. */
  readonly collapsed: boolean;
}

/**
 * Depth-first flatten for rendering, skipping the children of collapsed dirs.
 * `collapsedDirs` holds the dir paths whose children are hidden.
 */
export function flattenFileTree(
  nodes: ReadonlyArray<TreeNode>,
  collapsedDirs: ReadonlySet<string>,
  depth = 0,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  for (const node of nodes) {
    if (node.kind === "dir") {
      const collapsed = collapsedDirs.has(node.path);
      rows.push({
        kind: "dir",
        name: node.name,
        path: node.path,
        depth,
        additions: node.additions,
        deletions: node.deletions,
        collapsed,
      });
      if (!collapsed) rows.push(...flattenFileTree(node.children, collapsedDirs, depth + 1));
    } else {
      rows.push({
        kind: "file",
        name: node.name,
        path: node.path,
        depth,
        additions: node.additions,
        deletions: node.deletions,
        collapsed: false,
      });
    }
  }
  return rows;
}
