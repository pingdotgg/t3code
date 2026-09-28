export interface CommitFile {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

export type CommitFileNode =
  | { kind: "file"; name: string; path: string; file: CommitFile }
  | {
      kind: "directory";
      name: string;
      path: string;
      children: CommitFileNode[];
      files: CommitFile[];
    };

type Directory = Extract<CommitFileNode, { kind: "directory" }>;

// Git paths use forward slashes. Keep the original file path for selection and commands,
// including literal backslashes and trailing slashes on untracked directories.
export function buildCommitFileTree(files: readonly CommitFile[]): CommitFileNode[] {
  const root: Directory = { kind: "directory", name: "", path: "", children: [], files: [] };
  const directories = new Map<string, Directory>([["", root]]);
  for (const file of files) {
    const segments = file.path.replace(/\/$/, "").split("/");
    let parent = root;
    parent.files.push(file);
    for (const segment of segments.slice(0, -1)) {
      const path = parent.path ? `${parent.path}/${segment}` : segment;
      let directory = directories.get(path);
      if (!directory) {
        directory = { kind: "directory", name: segment, path, children: [], files: [] };
        directories.set(path, directory);
        parent.children.push(directory);
      }
      directory.files.push(file);
      parent = directory;
    }
    parent.children.push({
      kind: "file",
      name: `${segments.at(-1) ?? file.path}${file.path.endsWith("/") ? "/" : ""}`,
      path: file.path,
      file,
    });
  }
  function compactAndSort(nodes: CommitFileNode[]): CommitFileNode[] {
    return nodes
      .map((node): CommitFileNode => {
        if (node.kind === "file") return node;
        let directory = node;
        while (directory.children.length === 1 && directory.children[0]?.kind === "directory") {
          const child = directory.children[0];
          directory = { ...child, name: `${directory.name}/${child.name}` };
        }
        return { ...directory, children: compactAndSort(directory.children) };
      })
      .sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name, undefined, { numeric: true })
          : a.kind === "directory"
            ? -1
            : 1,
      );
  }
  return compactAndSort(root.children);
}

export function flattenCommitFileTree(
  nodes: readonly CommitFileNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): { node: CommitFileNode; depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "directory" && !collapsed.has(node.path)
      ? flattenCommitFileTree(node.children, collapsed, depth + 1)
      : []),
  ]);
}

export function toggleCommitFiles(
  files: readonly CommitFile[],
  excluded: ReadonlySet<string>,
): ReadonlySet<string> {
  const allIncluded = files.every((file) => !excluded.has(file.path));
  const next = new Set(excluded);
  for (const file of files) {
    if (allIncluded) next.add(file.path);
    else next.delete(file.path);
  }
  return next;
}
