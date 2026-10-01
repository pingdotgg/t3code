import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  ENVIRONMENT_MANIFEST_FILE,
  validateEnvironmentPackage,
  type EnvironmentAsset,
  type EnvironmentPackage,
} from "@t3tools/extension-sdk/environment";

export const MAX_PACKAGE_BYTES = 1024 * 1024;
export interface PackageSnapshot {
  readonly complete: true;
  package: EnvironmentPackage;
  contentHash: string;
  files: Map<string, Buffer>;
}
async function readBounded(root: string, name: string, remaining: number): Promise<Buffer> {
  const target = NodePath.join(root, name);
  if ((await NodeFSP.realpath(target)) !== target)
    throw new Error("Package symlinks are not supported");
  const handle = await NodeFSP.open(
    target,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > remaining) throw new Error("Package file exceeds limit");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count !== stat.size) throw new Error("Package changed during read");
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}
/** Host metadata lives outside content hashes and never changes the declared package files. */
export async function validateModuleScope(root: string): Promise<void> {
  const bytes = await readBounded(NodePath.join(root, "packages"), "package.json", 128);
  let scope: unknown;
  try {
    scope = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid runtime module scope");
  }
  if (
    !scope ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    Object.keys(scope).length !== 1 ||
    !("type" in scope) ||
    scope.type !== "module"
  )
    throw new Error("Invalid runtime module scope");
}

/** Publish a complete module boundary without replacing any existing user file or symlink. */
export async function ensureModuleScope(root: string): Promise<void> {
  const store = NodePath.join(root, "packages");
  await NodeFSP.mkdir(store, { recursive: true, mode: 0o700 });
  if ((await NodeFSP.realpath(store)) !== store) throw new Error("Invalid package store");
  try {
    await validateModuleScope(root);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = NodePath.join(store, ".module-" + NodeCrypto.randomUUID());
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o400);
    try {
      await handle.writeFile('{"type":"module"}\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await NodeFSP.link(temporary, NodePath.join(store, "package.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await validateModuleScope(root);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export interface PackageMetadata {
  readonly complete: false;
  package: EnvironmentPackage;
  contentHash: string;
  files: Map<string, Buffer>;
}
export async function readPackageMetadata(directory: string): Promise<PackageMetadata> {
  const root = NodePath.resolve(directory);
  if ((await NodeFSP.realpath(root)) !== root || !(await NodeFSP.lstat(root)).isDirectory())
    throw new Error("Invalid package directory");
  const manifest = await readBounded(root, ENVIRONMENT_MANIFEST_FILE, 64 * 1024);
  const pkg = validateEnvironmentPackage(JSON.parse(manifest.toString("utf8")));
  const names = [
    ...new Set(
      [ENVIRONMENT_MANIFEST_FILE, pkg.clientEntry, pkg.serverEntry].filter(
        (name): name is string => name !== undefined,
      ),
    ),
  ].sort();
  const files = new Map<string, Buffer>();
  let total = 0;
  const hash = NodeCrypto.createHash("sha256");
  for (const name of names) {
    const bytes =
      name === ENVIRONMENT_MANIFEST_FILE
        ? manifest
        : await readBounded(root, name, MAX_PACKAGE_BYTES - total);
    total += bytes.length;
    if (total > MAX_PACKAGE_BYTES) throw new Error("Package exceeds code and metadata limit");
    files.set(name, bytes);
    hash.update(name + "\0" + bytes.length + "\0").update(bytes);
  }
  return { complete: false, package: pkg, contentHash: hash.digest("hex"), files };
}
export async function readPackage(directory: string): Promise<PackageSnapshot> {
  const metadata = await readPackageMetadata(directory);
  const files = new Map(metadata.files);
  if (metadata.package.format === 4) {
    const root = NodePath.resolve(directory);
    for (const asset of metadata.package.assets) {
      const bytes = await readBounded(root, asset.path, asset.byteLength);
      if (bytes.length !== asset.byteLength) throw new Error("Package asset size mismatch");
      const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (digest !== asset.sha256) throw new Error("Package asset digest mismatch");
      files.set(asset.path, bytes);
    }
  }
  return { complete: true, package: metadata.package, contentHash: metadata.contentHash, files };
}
export async function readDeclaredAsset(
  directory: string,
  asset: EnvironmentAsset,
): Promise<Buffer> {
  const root = NodePath.resolve(directory);
  const bytes = await readBounded(root, asset.path, asset.byteLength);
  if (bytes.length !== asset.byteLength) throw new Error("Package asset size mismatch");
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) throw new Error("Package asset digest mismatch");
  return bytes;
}
/** Parse the exact copied bytes without running package code or resolving imports. */
export async function checkSyntax(snapshot: PackageSnapshot): Promise<void> {
  for (const name of new Set([snapshot.package.clientEntry, snapshot.package.serverEntry])) {
    if (!name) continue;
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "--check"], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { PATH: process.env.PATH ?? "", ELECTRON_RUN_AS_NODE: "1" },
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("Package entry has invalid syntax: " + name));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(snapshot.files.get(name));
    });
  }
}
export async function storePackage(root: string, snapshot: PackageSnapshot): Promise<void> {
  if (snapshot.complete !== true) throw new Error("Package store requires a complete snapshot");
  const store = NodePath.join(root, "packages");
  await NodeFSP.mkdir(store, { recursive: true, mode: 0o700 });
  if ((await NodeFSP.realpath(store)) !== store || !(await NodeFSP.lstat(store)).isDirectory())
    throw new Error("Invalid package store");
  const target = NodePath.join(store, snapshot.contentHash);
  try {
    const existing = await readPackage(target);
    if (existing.contentHash !== snapshot.contentHash)
      throw new Error("Installed package digest mismatch");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((await NodeFSP.readdir(store)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length >= 128)
    throw new Error("Package store limit reached");
  const temporary = NodePath.join(store, ".install-" + NodeCrypto.randomUUID());
  await NodeFSP.mkdir(temporary, { mode: 0o700 });
  try {
    for (const [name, bytes] of snapshot.files) {
      const file = NodePath.join(temporary, name);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(file, bytes, { flag: "wx", mode: 0o400 });
    }
    await NodeFSP.rename(temporary, target);
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
export async function atomicJson(root: string, value: unknown): Promise<void> {
  const temporary = NodePath.join(root, ".records-" + NodeCrypto.randomUUID());
  const file = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temporary, NodePath.join(root, "installations.json"));
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

/** Only hash directories owned by this root and absent from the committed registry are pruned. */
export async function prunePackages(root: string, retained: ReadonlySet<string>): Promise<void> {
  const store = NodePath.join(root, "packages");
  try {
    if ((await NodeFSP.realpath(store)) !== store) throw new Error("Invalid package store");
    for (const entry of await NodeFSP.readdir(store, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || retained.has(entry.name))
        continue;
      await NodeFSP.rm(NodePath.join(store, entry.name), { recursive: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
