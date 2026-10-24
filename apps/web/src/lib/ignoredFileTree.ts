import { isDefaultCopiedFile, type ProjectIgnoredFile } from "@t3tools/contracts";

import { COPYABLE_FILE_MAX_BYTES } from "./addProjectToMachine";

export type IgnoredFileTreeNode =
  | {
      readonly kind: "file";
      readonly name: string;
      readonly path: string;
      readonly file: ProjectIgnoredFile;
    }
  | {
      readonly kind: "directory";
      readonly name: string;
      readonly path: string;
      readonly children: readonly IgnoredFileTreeNode[];
      readonly listedCount: number;
      readonly defaultExpanded: boolean;
    };

type Directory = {
  path: string;
  children: Map<string, Directory | ProjectIgnoredFile>;
};

export function buildIgnoredFileTree(
  files: readonly ProjectIgnoredFile[],
): readonly IgnoredFileTreeNode[] {
  const root: Directory = { path: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop()!;
    let directory = root;
    for (const part of parts) {
      let child = directory.children.get(part);
      if (!child) {
        child = {
          path: directory.path ? `${directory.path}/${part}` : part,
          children: new Map(),
        };
        directory.children.set(part, child);
      }
      if ("children" in child) directory = child;
    }
    directory.children.set(name, file);
  }

  function children(directory: Directory): IgnoredFileTreeNode[] {
    return Array.from(directory.children.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entry]): IgnoredFileTreeNode => {
        if (!("children" in entry)) return { kind: "file", name, path: entry.path, file: entry };
        const nodes = children(entry);
        const onlyChild = nodes[0];
        if (nodes.length === 1 && onlyChild?.kind === "directory") {
          return { ...onlyChild, name: `${name}/${onlyChild.name}` };
        }
        return {
          kind: "directory",
          name,
          path: entry.path,
          children: nodes,
          listedCount: nodes.reduce(
            (count, node) => count + (node.kind === "file" ? 1 : node.listedCount),
            0,
          ),
          defaultExpanded: nodes.some((node) =>
            node.kind === "directory"
              ? node.defaultExpanded
              : isDefaultCopiedFile(node.path) && node.file.byteLength <= COPYABLE_FILE_MAX_BYTES,
          ),
        };
      });
  }
  return children(root);
}

export function getDefaultIgnoredFileExpansion(
  nodes: readonly IgnoredFileTreeNode[],
): ReadonlySet<string> {
  const expanded = new Set<string>();
  function visit(nodes: readonly IgnoredFileTreeNode[]) {
    for (const node of nodes) {
      if (node.kind === "directory" && node.defaultExpanded) {
        expanded.add(node.path);
        visit(node.children);
      }
    }
  }
  visit(nodes);
  return expanded;
}

export function countSelectedIgnoredDescendants(
  directoryPath: string,
  selectedPaths: Iterable<string>,
): number {
  let count = 0;
  for (const path of selectedPaths) {
    if (path.startsWith(`${directoryPath}/`)) count++;
  }
  return count;
}
