// @effect-diagnostics nodeBuiltinImport:off - shared by the server and the analysis worker, which runs outside the Effect runtime; every call is a bounded synchronous filesystem step.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

/**
 * The control directory holds only the `published` pointer. Each index generation is a sibling
 * `.codegraph-t3-g<n>` because the SDK takes its data directory as one path segment in the
 * checkout root, and its indexer skips every `.codegraph-*` sibling.
 */
export const INDEX_DIRECTORY = ".codegraph-t3";
const GENERATION_PREFIX = `${INDEX_DIRECTORY}-g`;
const GENERATION_NAME = /^\.codegraph-t3-g([1-9][0-9]{0,8})$/;
const PUBLISHED_FILE = "published";
const INDEX_GITIGNORE = "# T3 code index, local to this machine.\n*\n";

export class IndexOutsideCheckout extends Schema.TaggedError<IndexOutsideCheckout>()(
  "IndexOutsideCheckout",
  {},
) {
  override get message(): string {
    return "index-outside-checkout";
  }
}

export const generationDirectory = (generation: number) => `${GENERATION_PREFIX}${generation}`;

function generationOf(name: string): number | null {
  const match = GENERATION_NAME.exec(name);
  return match === null ? null : Number(match[1]);
}

const isIndexOutsideCheckout = Schema.is(IndexOutsideCheckout);

/** Whether a checkout-relative path lies in the control directory or a generation. */
export function isIndexPath(relativePath: string): boolean {
  const top = relativePath.split("/", 1)[0]!;
  return top === INDEX_DIRECTORY || generationOf(top) !== null;
}

/** Generation directories present in the checkout root, whatever their state. */
export function listGenerations(checkoutPath: string): number[] {
  return NodeFS.readdirSync(checkoutPath).flatMap((name) => {
    const generation = generationOf(name);
    return generation === null ? [] : [generation];
  });
}

/**
 * Refuses an index directory that is a link, resolves outside the checkout, or holds anything but
 * plain entries. The SDK opens the database, its -wal/-shm sidecars, its lock and .gitignore by
 * path and follows a link or shared inode out of the checkout, and T3 writes the pointer and
 * metadata the same way. A missing directory passes.
 */
export function validateIndexDirectory(checkoutPath: string, name: string): void {
  const indexPath = NodePath.join(checkoutPath, name);
  try {
    const stat = NodeFS.lstatSync(indexPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new IndexOutsideCheckout();
    const root = NodeFS.realpathSync(checkoutPath);
    const relative = NodePath.relative(root, NodeFS.realpathSync(indexPath));
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    ) {
      throw new IndexOutsideCheckout();
    }
    for (const child of NodeFS.readdirSync(indexPath)) {
      const entry = NodeFS.lstatSync(NodePath.join(indexPath, child));
      if (!(entry.isDirectory() || (entry.isFile() && entry.nlink === 1))) {
        throw new IndexOutsideCheckout();
      }
    }
  } catch (cause) {
    if (isIndexOutsideCheckout(cause)) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

/** Replaces `name` in the directory without writing through whatever already sits there. */
function replaceFile(directory: string, name: string, contents: string): void {
  const target = NodePath.join(directory, name);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    // An exclusive create never follows a planted link, and the rename replaces the entry
    // rather than writing through it.
    NodeFS.writeFileSync(temporary, contents, { flag: "wx" });
    NodeFS.renameSync(temporary, target);
  } catch (cause) {
    NodeFS.rmSync(temporary, { force: true });
    throw cause;
  }
}

/**
 * The SDK's .gitignore keeps itself tracked, which leaves the index directory in the user's
 * `git status`; T3's index is private to the machine, so the file ignores itself too.
 */
export function ignoreIndexDirectory(checkoutPath: string, name: string): void {
  const directory = NodePath.join(checkoutPath, name);
  try {
    if (NodeFS.readFileSync(NodePath.join(directory, ".gitignore"), "utf8") === INDEX_GITIGNORE)
      return;
  } catch {}
  try {
    replaceFile(directory, ".gitignore", INDEX_GITIGNORE);
  } catch {}
}

export function readFileNoFollow(path: string): string {
  const descriptor = NodeFS.openSync(
    path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    return NodeFS.readFileSync(descriptor, "utf8");
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

/** The published generation, or null for a checkout with none. Validates the control directory. */
export function readPublishedGeneration(checkoutPath: string): number | null {
  validateIndexDirectory(checkoutPath, INDEX_DIRECTORY);
  let text: string;
  try {
    text = readFileNoFollow(NodePath.join(checkoutPath, INDEX_DIRECTORY, PUBLISHED_FILE));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  return generationOf(generationDirectory(Number(text.trim())));
}

/** Atomically points readers at `generation`. */
export function publishGeneration(checkoutPath: string, generation: number): void {
  const directory = NodePath.join(checkoutPath, INDEX_DIRECTORY);
  NodeFS.mkdirSync(directory, { recursive: true });
  validateIndexDirectory(checkoutPath, INDEX_DIRECTORY);
  ignoreIndexDirectory(checkoutPath, INDEX_DIRECTORY);
  replaceFile(directory, PUBLISHED_FILE, String(generation));
}

/**
 * Index files an older T3 wrote into the control directory, when it was also the SDK's data
 * directory. Nothing reads them any more.
 */
export function removeLegacyIndexFiles(checkoutPath: string): void {
  const directory = NodePath.join(checkoutPath, INDEX_DIRECTORY);
  for (const name of [
    "codegraph.db",
    "codegraph.db-wal",
    "codegraph.db-shm",
    "codegraph.lock",
    "t3-index.json",
  ]) {
    NodeFS.rmSync(NodePath.join(directory, name), { force: true });
  }
}
