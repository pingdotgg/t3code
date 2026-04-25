import type { PreviewCatalogEntry, PreviewScopedEntry } from "@forma/contracts";

export type PreviewCatalogTreeEntryLike = Pick<
  PreviewCatalogEntry | PreviewScopedEntry,
  "id" | "label" | "exportName" | "componentPath"
>;

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function compareNames(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function matchesSearch(entry: PreviewCatalogTreeEntryLike, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [entry.label, entry.exportName, entry.componentPath]
    .join("\n")
    .toLowerCase()
    .includes(query);
}

function basename(pathValue: string): string {
  const segments = normalizePathSegments(pathValue);
  return segments.at(-1) ?? pathValue;
}

export interface PreviewCatalogTreeEntryNode {
  readonly kind: "entry";
  readonly key: string;
  readonly fileName: string;
  readonly changed: boolean;
  readonly selected: boolean;
  readonly entry: PreviewCatalogTreeEntryLike;
}

export interface PreviewCatalogTreeDirectoryNode {
  readonly kind: "directory";
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly changedCount: number;
  readonly containsSelection: boolean;
  readonly children: ReadonlyArray<PreviewCatalogTreeNode>;
}

export type PreviewCatalogTreeNode = PreviewCatalogTreeDirectoryNode | PreviewCatalogTreeEntryNode;

interface MutableDirectoryNode {
  readonly name: string;
  readonly path: string;
  readonly directories: Map<string, MutableDirectoryNode>;
  readonly entries: PreviewCatalogTreeEntryNode[];
  changedCount: number;
  containsSelection: boolean;
}

function createMutableDirectoryNode(name: string, nodePath: string): MutableDirectoryNode {
  return {
    name,
    path: nodePath,
    directories: new Map(),
    entries: [],
    changedCount: 0,
    containsSelection: false,
  };
}

function toTreeNodes(directory: MutableDirectoryNode): ReadonlyArray<PreviewCatalogTreeNode> {
  const directories = Array.from(directory.directories.values())
    .toSorted(compareNames)
    .map<PreviewCatalogTreeDirectoryNode>((childDirectory) => ({
      kind: "directory",
      key: `dir:${childDirectory.path}`,
      name: childDirectory.name,
      path: childDirectory.path,
      changedCount: childDirectory.changedCount,
      containsSelection: childDirectory.containsSelection,
      children: toTreeNodes(childDirectory),
    }));

  const entries = directory.entries.toSorted((left, right) => {
    const byLabel = left.entry.label.localeCompare(right.entry.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (byLabel !== 0) {
      return byLabel;
    }
    return left.entry.exportName.localeCompare(right.entry.exportName, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });

  return [...directories, ...entries];
}

export function buildPreviewCatalogTree(input: {
  readonly entries: ReadonlyArray<PreviewCatalogTreeEntryLike>;
  readonly searchQuery: string;
  readonly selectedPreviewId: string | null;
  readonly changedPreviewIds: ReadonlySet<string>;
}): ReadonlyArray<PreviewCatalogTreeNode> {
  const root = createMutableDirectoryNode("", "");

  const matchingEntries = input.entries.filter((entry) => matchesSearch(entry, input.searchQuery));

  for (const entry of matchingEntries) {
    const changed = input.changedPreviewIds.has(entry.id);
    const selected = input.selectedPreviewId === entry.id;
    const ancestors: MutableDirectoryNode[] = [root];
    let currentDirectory = root;

    for (const segment of normalizePathSegments(entry.componentPath).slice(0, -1)) {
      const nextPath = currentDirectory.path ? `${currentDirectory.path}/${segment}` : segment;
      const existingDirectory = currentDirectory.directories.get(segment);
      if (existingDirectory) {
        currentDirectory = existingDirectory;
      } else {
        const createdDirectory = createMutableDirectoryNode(segment, nextPath);
        currentDirectory.directories.set(segment, createdDirectory);
        currentDirectory = createdDirectory;
      }
      ancestors.push(currentDirectory);
    }

    currentDirectory.entries.push({
      kind: "entry",
      key: `entry:${entry.id}`,
      fileName: basename(entry.componentPath),
      changed,
      selected,
      entry,
    });

    if (changed || selected) {
      for (const ancestor of ancestors) {
        if (changed) {
          ancestor.changedCount += 1;
        }
        if (selected) {
          ancestor.containsSelection = true;
        }
      }
    }
  }

  return toTreeNodes(root);
}

export function collectPreviewCatalogDirectoryPaths(
  nodes: ReadonlyArray<PreviewCatalogTreeNode>,
): ReadonlyArray<string> {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") {
      continue;
    }
    paths.push(node.path);
    paths.push(...collectPreviewCatalogDirectoryPaths(node.children));
  }
  return paths;
}
