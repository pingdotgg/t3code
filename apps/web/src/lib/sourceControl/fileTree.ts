// ─── Changes-list folder tree ───────────────────────────────────────────────
//
// Groups a flat `WorkingCopyFile[]` into a directory tree for the "view as
// tree" mode of the changes list. Single-child folder chains are compacted VS
// Code style (`src/components/sourceControl` shows as one row) so deep paths
// stay tidy.

import type { WorkingCopyFile } from "./types";

export interface SourceControlTreeFolderNode {
  readonly type: "folder";
  /** Display name — may be a compacted `a/b/c` chain, relative to the parent. */
  readonly name: string;
  /** Full folder path — the stable key for collapse state. */
  readonly path: string;
  readonly children: ReadonlyArray<SourceControlTreeNode>;
}

export interface SourceControlTreeFileNode {
  readonly type: "file";
  readonly name: string;
  readonly file: WorkingCopyFile;
}

export type SourceControlTreeNode = SourceControlTreeFolderNode | SourceControlTreeFileNode;

interface MutableFolderNode {
  type: "folder";
  name: string;
  path: string;
  children: MutableTreeNode[];
}

interface MutableFileNode {
  type: "file";
  name: string;
  file: WorkingCopyFile;
}

type MutableTreeNode = MutableFolderNode | MutableFileNode;

const SORT_LOCALE_OPTIONS: Intl.CollatorOptions = { sensitivity: "base" };

export function buildSourceControlTree(
  files: ReadonlyArray<WorkingCopyFile>,
): ReadonlyArray<SourceControlTreeNode> {
  const root: MutableFolderNode = { type: "folder", name: "", path: "", children: [] };

  for (const file of files) {
    const segments = file.path.split("/");
    const leafName = segments[segments.length - 1] ?? file.path;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const folderPath = node.path ? `${node.path}/${segment}` : segment;
      const existing = node.children.find(
        (candidate): candidate is MutableFolderNode =>
          candidate.type === "folder" && candidate.name === segment,
      );
      if (existing) {
        node = existing;
        continue;
      }
      const child: MutableFolderNode = {
        type: "folder",
        name: segment,
        path: folderPath,
        children: [],
      };
      node.children.push(child);
      node = child;
    }
    node.children.push({ type: "file", name: leafName, file });
  }

  compactFolderChains(root);
  sortFolder(root);
  return root.children;
}

/**
 * Every file path under a folder node, recursively, in tree order. Drives the
 * folder row's "stage / unstage everything in this folder" action, so it
 * reflects whatever files were fed in — i.e. it honours the active filter.
 */
export function collectFolderFilePaths(folder: SourceControlTreeFolderNode): ReadonlyArray<string> {
  const paths: string[] = [];
  const walk = (node: SourceControlTreeNode): void => {
    if (node.type === "file") {
      paths.push(node.file.path);
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const child of folder.children) {
    walk(child);
  }
  return paths;
}

/** Every folder path in the tree, depth-first. Drives expand/collapse-all. */
export function collectAllFolderPaths(
  nodes: ReadonlyArray<SourceControlTreeNode>,
): ReadonlyArray<string> {
  const paths: string[] = [];
  const walk = (node: SourceControlTreeNode): void => {
    if (node.type !== "folder") {
      return;
    }
    paths.push(node.path);
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const node of nodes) {
    walk(node);
  }
  return paths;
}

export interface SourceControlTreeRow {
  readonly type: "folder" | "file";
  readonly depth: number;
  readonly name: string;
  /** Folder path for folders; the file path for files. */
  readonly path: string;
  /** Present on file rows. */
  readonly file?: WorkingCopyFile | undefined;
  /** Every file path under this folder, for the stage/unstage-folder action. */
  readonly files?: ReadonlyArray<string> | undefined;
  /** Present on folder rows. */
  readonly collapsed?: boolean | undefined;
}

/**
 * The tree flattened to rows in display order.
 *
 * Row order has to be data, not a React render, or nothing outside the DOM can
 * index it — which is what lets tree mode and flat mode share one keyboard
 * implementation and one virtualizer. Iterative rather than recursive so a
 * pathological path depth cannot blow the JS stack.
 */
export function flattenSourceControlTree(
  nodes: ReadonlyArray<SourceControlTreeNode>,
  isCollapsed: (folderPath: string) => boolean,
): ReadonlyArray<SourceControlTreeRow> {
  const rows: SourceControlTreeRow[] = [];
  // Explicit stack, pushed in reverse so siblings pop in tree order.
  const stack: Array<{ node: SourceControlTreeNode; depth: number }> = [];
  for (const node of nodes.toReversed()) {
    stack.push({ node, depth: 0 });
  }

  let entry = stack.pop();
  for (; entry !== undefined; entry = stack.pop()) {
    const { node, depth } = entry;
    if (node.type === "file") {
      rows.push({
        type: "file",
        depth,
        name: node.name,
        path: node.file.path,
        file: node.file,
      });
      continue;
    }
    const collapsed = isCollapsed(node.path);
    rows.push({
      type: "folder",
      depth,
      name: node.name,
      path: node.path,
      files: collectFolderFilePaths(node),
      collapsed,
    });
    if (collapsed) {
      continue;
    }
    for (const child of node.children.toReversed()) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }

  return rows;
}

/** Merge folders holding exactly one sub-folder (and no files) into a chain. */
function compactFolderChains(folder: MutableFolderNode): void {
  for (const child of folder.children) {
    if (child.type !== "folder") {
      continue;
    }
    for (;;) {
      const only = child.children.length === 1 ? child.children[0] : undefined;
      if (only === undefined || only.type !== "folder") {
        break;
      }
      child.name = `${child.name}/${only.name}`;
      child.path = only.path;
      child.children = only.children;
    }
    compactFolderChains(child);
  }
}

/** Folders first, then files; alphabetical, case-insensitive, within each. */
function sortFolder(folder: MutableFolderNode): void {
  folder.children.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "folder" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, SORT_LOCALE_OPTIONS);
  });
  for (const child of folder.children) {
    if (child.type === "folder") {
      sortFolder(child);
    }
  }
}
