// @effect-diagnostics nodeBuiltinImport:off -- The Clerk bridge must lock the token file down before startup can yield to Electron's ready event.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// electron-store chmods every write to 0666; the private directory protects tokens during writes.
const CLERK_TOKEN_DIRECTORY_MODE = 0o700;
const CLERK_TOKEN_FILE_MODE = 0o600;
const CLERK_TOKEN_DIRECTORY_NAME = "clerk";
const CLERK_TOKEN_FILE_NAME = "clerk-tokens.json";

type Awaitable<T> = T | Promise<T>;

export interface ClerkTokenStorage {
  readonly getItem: (key: string) => Awaitable<string | null>;
  readonly setItem: (key: string, value: string) => Awaitable<void>;
  readonly removeItem: (key: string) => Awaitable<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function lstatIfExists(path: string): NodeFS.Stats | undefined {
  try {
    return NodeFS.lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertRegularFile(path: string, stat: NodeFS.Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Clerk token file "${path}" must be a regular file.`);
  }
}

function restrictClerkTokenFile(path: string): void {
  const stat = lstatIfExists(path);
  if (stat === undefined) return;
  assertRegularFile(path, stat);
  if ((stat.mode & 0o777) === CLERK_TOKEN_FILE_MODE) return;
  NodeFS.chmodSync(path, CLERK_TOKEN_FILE_MODE);
}

function migrateLegacyClerkTokenFile(stateDir: string, directory: string): void {
  const legacyPath = NodePath.join(stateDir, CLERK_TOKEN_FILE_NAME);
  const tokenPath = NodePath.join(directory, CLERK_TOKEN_FILE_NAME);
  const legacy = lstatIfExists(legacyPath);
  if (legacy !== undefined) {
    assertRegularFile(legacyPath, legacy);
    NodeFS.chmodSync(legacyPath, CLERK_TOKEN_FILE_MODE);
  }

  const destination = lstatIfExists(tokenPath);
  if (destination === undefined) {
    if (legacy === undefined) return;
    try {
      NodeFS.copyFileSync(legacyPath, tokenPath, NodeFS.constants.COPYFILE_EXCL);
      NodeFS.chmodSync(tokenPath, CLERK_TOKEN_FILE_MODE);
      NodeFS.unlinkSync(legacyPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    return;
  }

  assertRegularFile(tokenPath, destination);
  NodeFS.chmodSync(tokenPath, CLERK_TOKEN_FILE_MODE);
  if (legacy === undefined) return;
  try {
    NodeFS.unlinkSync(legacyPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function restrictAfter<T>(run: () => Awaitable<T>, tighten: () => void): Awaitable<T> {
  let result: Awaitable<T>;
  try {
    result = run();
  } catch (error) {
    tighten();
    throw error;
  }
  if (result instanceof Promise) return result.finally(tighten);
  tighten();
  return result;
}

/** Opens Clerk token storage in a private directory and keeps the file at `0600`. */
export function openClerkTokenStorage(
  stateDir: string,
  createStorage: (directory: string) => ClerkTokenStorage,
  userDataPath = ".",
): ClerkTokenStorage {
  const absoluteStateDir = NodePath.resolve(stateDir);
  const directory = NodePath.join(absoluteStateDir, CLERK_TOKEN_DIRECTORY_NAME);
  NodeFS.mkdirSync(directory, { recursive: true, mode: CLERK_TOKEN_DIRECTORY_MODE });
  const stat = NodeFS.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Clerk token directory "${directory}" must be a real directory.`);
  }
  NodeFS.chmodSync(directory, CLERK_TOKEN_DIRECTORY_MODE);
  // electron-store rebases relative paths under Electron userData, not the working directory.
  migrateLegacyClerkTokenFile(NodePath.resolve(userDataPath, stateDir), directory);
  const tokenPath = NodePath.join(directory, CLERK_TOKEN_FILE_NAME);
  restrictClerkTokenFile(tokenPath);

  const storage = createStorage(directory);
  const tighten = () => restrictClerkTokenFile(tokenPath);
  return {
    getItem: (key) => restrictAfter(() => storage.getItem(key), tighten),
    setItem: (key, value) => restrictAfter(() => storage.setItem(key, value), tighten),
    removeItem: (key) => restrictAfter(() => storage.removeItem(key), tighten),
  };
}
