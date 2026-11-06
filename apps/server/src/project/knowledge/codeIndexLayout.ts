// @effect-diagnostics nodeBuiltinImport:off - shared by the server and the analysis worker, which runs outside the Effect runtime; every call is a bounded synchronous filesystem step.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * The index root is `<codeIndexDir>/<hash>` in T3's data directory, never the checkout: the SDK
 * takes its data directory as one path segment inside its project root and ignores absolute
 * paths, so T3 gives it a private root that links back to the checkout's top-level entries.
 */
export const INDEX_DIRECTORY = ".codegraph-t3";
const GENERATION_PREFIX = `${INDEX_DIRECTORY}-g`;
const GENERATION_NAME = /^\.codegraph-t3-g([1-9][0-9]{0,8})$/;
export const PUBLISHED_FILE = "published";
const INDEXED_CHECKOUT_FILE = "checkout";
// Changes what the SDK indexes, and a truncated listing can drop them.
export const CHECKOUT_CONFIG_ENTRIES = ["codegraph.json", ".gitignore"];

export const generationDirectory = (generation: number) => `${GENERATION_PREFIX}${generation}`;

function generationOf(name: string): number | null {
  const match = GENERATION_NAME.exec(name);
  return match === null ? null : Number(match[1]);
}

/** Whether a root-relative path lies in the control directory or a generation. */
export function isIndexPath(relativePath: string): boolean {
  const top = relativePath.split("/", 1)[0]!;
  return top === INDEX_DIRECTORY || generationOf(top) !== null;
}

/** The index root one checkout's index lives under. */
export function indexRootFor(codeIndexDir: string, checkoutPath: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(checkoutPathKey(checkoutPath))
    .digest("hex");
  return NodePath.join(codeIndexDir, digest.slice(0, 32));
}

/** Identity only: keep the original path when opening files or recording the checkout owner. */
export function checkoutPathKey(checkoutPath: string): string {
  const resolved = NodePath.resolve(checkoutPath);
  return NodePath.sep === "\\" ? resolved.toLowerCase() : resolved;
}

/** Generation directories present in the index root, whatever their state. */
export function listGenerations(indexRoot: string): number[] {
  let names: string[];
  try {
    names = NodeFS.readdirSync(indexRoot);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const generation = generationOf(name);
    return generation === null ? [] : [generation];
  });
}

/** The checkout this index root belongs to, or null when it holds no record. */
export function readIndexedCheckout(indexRoot: string): string | null {
  try {
    return NodeFS.readFileSync(
      NodePath.join(indexRoot, INDEX_DIRECTORY, INDEXED_CHECKOUT_FILE),
      "utf8",
    );
  } catch {
    return null;
  }
}

/** Replaces `name` in the directory in one step, so a reader sees the old contents or the new. */
function replaceFile(directory: string, name: string, contents: string): void {
  const target = NodePath.join(directory, name);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    NodeFS.writeFileSync(temporary, contents, { flag: "wx" });
    NodeFS.renameSync(temporary, target);
  } catch (cause) {
    NodeFS.rmSync(temporary, { force: true });
    throw cause;
  }
}

/** Records which checkout an index root belongs to, for sweeps that outlive the project. */
export function writeIndexedCheckout(indexRoot: string, checkoutPath: string): void {
  const control = NodePath.join(indexRoot, INDEX_DIRECTORY);
  NodeFS.mkdirSync(control, { recursive: true });
  replaceFile(control, INDEXED_CHECKOUT_FILE, checkoutPath);
}

/**
 * Points the index root at each top-level entry of the checkout the build may read, so the SDK
 * finds sources at the paths the index stores. A missing target is skipped: it has nothing to
 * index.
 */
export function linkCheckoutSources(
  indexRoot: string,
  checkoutPath: string,
  paths: ReadonlyArray<string>,
): void {
  if (
    NodePath.sep === "\\" &&
    NodePath.toNamespacedPath(checkoutPath).toUpperCase().startsWith("\\\\?\\UNC\\")
  )
    throw new Error("Windows junctions cannot target a network checkout.");
  const names = new Set(CHECKOUT_CONFIG_ENTRIES);
  for (const path of paths) names.add(path.split("/", 1)[0]!);
  for (const name of names) {
    if (isIndexPath(name)) continue;
    const link = NodePath.join(indexRoot, name);
    const target = NodePath.join(checkoutPath, name);
    let isDirectory: boolean;
    try {
      // Followed: Windows needs the link's type to match what a checkout link points at.
      isDirectory = NodeFS.statSync(target).isDirectory();
    } catch {
      continue;
    }
    if (NodeFS.lstatSync(link, { throwIfNoEntry: false }) !== undefined) continue;
    try {
      // `junction` needs no privilege on Windows, and the type argument is ignored on POSIX.
      NodeFS.symlinkSync(target, link, isDirectory ? "junction" : "file");
    } catch (cause) {
      // Windows file links need a privilege; a copy is rebuilt on every build.
      if (!isDirectory && (cause as NodeJS.ErrnoException).code === "EPERM") {
        NodeFS.copyFileSync(target, link);
        continue;
      }
      throw cause;
    }
  }
}

/** Removes the links and copies a build left in the index root, never their targets. */
export function clearCheckoutSources(indexRoot: string): void {
  let names: string[];
  try {
    names = NodeFS.readdirSync(indexRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (isIndexPath(name)) continue;
    const entry = NodePath.join(indexRoot, name);
    let stats: NodeFS.Stats;
    try {
      stats = NodeFS.lstatSync(entry);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink() || stats.isFile()) NodeFS.unlinkSync(entry);
  }
}

/** The published generation, or null for an index root with none. */
export function readPublishedGeneration(indexRoot: string): number | null {
  let text: string;
  try {
    text = NodeFS.readFileSync(NodePath.join(indexRoot, INDEX_DIRECTORY, PUBLISHED_FILE), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  return generationOf(generationDirectory(Number(text.trim())));
}

/** Atomically points readers at `generation`. */
export function publishGeneration(indexRoot: string, generation: number): void {
  const directory = NodePath.join(indexRoot, INDEX_DIRECTORY);
  NodeFS.mkdirSync(directory, { recursive: true });
  replaceFile(directory, PUBLISHED_FILE, String(generation));
}
