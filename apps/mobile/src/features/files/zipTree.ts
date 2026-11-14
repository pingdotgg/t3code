export interface ZipEntry {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface ZipTreeNode {
  readonly path: string;
  readonly label: string;
  readonly entry: ZipEntry | null;
  readonly children: ReadonlyArray<ZipTreeNode>;
  readonly fileCount: number;
}

export interface ZipTreeRow {
  readonly node: ZipTreeNode;
  readonly depth: number;
}

interface MutableNode {
  path: string;
  name: string;
  entry: ZipEntry | null;
  children: Map<string, MutableNode>;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function freeze(node: MutableNode): ZipTreeNode {
  let current = node;
  let label = node.name;
  while (current.path !== "" && current.entry === null && current.children.size === 1) {
    const [only] = current.children.values();
    if (!only || only.entry !== null) break;
    current = only;
    label = `${label}/${only.name}`;
  }
  const children = [...current.children.values()]
    .sort((left, right) =>
      (left.entry === null) !== (right.entry === null)
        ? left.entry === null
          ? -1
          : 1
        : collator.compare(left.name, right.name),
    )
    .map(freeze);
  return {
    path: current.path,
    label,
    entry: current.entry,
    children,
    fileCount:
      current.entry === null ? children.reduce((sum, child) => sum + child.fileCount, 0) : 1,
  };
}

export function buildZipTree(entries: ReadonlyArray<ZipEntry>): ReadonlyArray<ZipTreeNode> {
  const root: MutableNode = { path: "", name: "", entry: null, children: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let current = root;
    parts.forEach((part, index) => {
      const leaf = index === parts.length - 1 && !entry.isDirectory;
      const key = leaf ? part : `${part}/`;
      let child = current.children.get(key);
      if (!child) {
        child = {
          path: parts.slice(0, index + 1).join("/"),
          name: part,
          entry: leaf ? entry : null,
          children: new Map(),
        };
        current.children.set(key, child);
      }
      current = child;
    });
  }
  return freeze(root).children;
}

function flatten(
  output: ZipTreeRow[],
  node: ZipTreeNode,
  depth: number,
  collapsed: ReadonlySet<string>,
  query: string,
): boolean {
  if (node.entry) {
    if (query && !node.entry.path.toLowerCase().includes(query)) return false;
    output.push({ node, depth });
    return true;
  }
  const children: ZipTreeRow[] = [];
  let visible = !query;
  if (query || !collapsed.has(node.path)) {
    for (const child of node.children) {
      if (flatten(children, child, depth + 1, collapsed, query)) visible = true;
    }
  }
  if (!visible) return false;
  output.push({ node, depth }, ...children);
  return true;
}

export function flattenZipTree(
  nodes: ReadonlyArray<ZipTreeNode>,
  collapsed: ReadonlySet<string>,
  query: string,
): ReadonlyArray<ZipTreeRow> {
  const output: ZipTreeRow[] = [];
  const normalized = query.trim().toLowerCase();
  for (const node of nodes) flatten(output, node, 0, collapsed, normalized);
  return output;
}

export function zipFolderLabel(label: string) {
  const parts = label.split("/");
  const name = parts.at(-1) ?? label;
  if (parts.length > 3) return { prefix: `${parts[0]}/…/${parts.at(-2)}/`, name };
  return { prefix: parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : "", name };
}

export function zipDownloadTimeLeft(input: {
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly elapsedMs: number;
}) {
  if (input.receivedBytes <= 0 || input.totalBytes <= input.receivedBytes || input.elapsedMs < 1000)
    return null;
  const seconds = Math.ceil(
    ((input.totalBytes - input.receivedBytes) * input.elapsedMs) / input.receivedBytes / 1000,
  );
  return seconds < 60
    ? `About ${seconds} ${seconds === 1 ? "second" : "seconds"} left`
    : `About ${Math.ceil(seconds / 60)} minutes left`;
}
