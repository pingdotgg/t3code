// @effect-diagnostics nodeBuiltinImport:off - tar streams and file handles form the Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as tar from "tar";
import { PROJECT_TRANSFER_CHUNK_BYTES, PROJECT_TRANSFER_MAX_BYTES } from "@t3tools/contracts";

/** Disk-backed snapshots keep transfer memory bounded even when the client is on a relay. */
export class ProjectTransferFiles {
  async temporaryDirectory() {
    return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-project-transfer-"));
  }

  async isLinkedCheckout(root: string) {
    const entry = await NodeFSP.lstat(NodePath.join(root, ".git")).catch(() => null);
    return entry?.isFile() ?? false;
  }

  async overlayCheckout(root: string, destination: string, indexPath: string) {
    await NodeFSP.cp(root, destination, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => source !== NodePath.join(root, ".git"),
    });
    await NodeFSP.copyFile(indexPath, NodePath.join(destination, ".git", "index"));
  }

  async pack(root: string, directory: string, ignored: ReadonlySet<string>) {
    const git = await NodeFSP.lstat(NodePath.join(root, ".git")).catch(() => null);
    if (git && !git.isDirectory()) {
      throw new Error(
        "This checkout uses an external Git directory. Choose a fresh clone, or copy the repository's main checkout.",
      );
    }
    // Absolute/shared object paths would make an apparently successful copy depend on the source.
    if (await NodeFSP.stat(NodePath.join(root, ".git/objects/info/alternates")).catch(() => null)) {
      throw new Error(
        "This repository borrows Git objects from another directory. Choose a fresh clone.",
      );
    }
    const file = NodePath.join(directory, "snapshot.tar");
    let total = 0;
    await tar.create(
      {
        cwd: root,
        file,
        portable: true,
        strict: true,
        follow: false,
        filter: (entry, stat) => {
          const relative = entry.replace(/^\.\//, "").replace(/\/$/, "");
          if (relative === ".git/worktrees" || relative.startsWith(".git/worktrees/")) return false;
          if (ignored.has(relative)) return false;
          total += stat.size;
          return total <= PROJECT_TRANSFER_MAX_BYTES;
        },
      },
      ["."],
    );
    if (total > PROJECT_TRANSFER_MAX_BYTES)
      throw new Error("Project copy exceeds the 10 GB limit.");
    await this.validate(file);
    const byteLength = (await NodeFSP.stat(file)).size;
    if (byteLength > PROJECT_TRANSFER_MAX_BYTES)
      throw new Error("Project copy exceeds the 10 GB limit.");
    return { file, byteLength };
  }

  async reserve(destination: string) {
    const expanded = destination.startsWith("~/")
      ? NodePath.join(NodeOS.homedir(), destination.slice(2))
      : destination;
    if (!NodePath.isAbsolute(expanded)) throw new Error("Choose an absolute destination folder.");
    const parent = await NodeFSP.realpath(NodePath.dirname(expanded));
    const cwd = NodePath.join(parent, NodePath.basename(expanded));
    // mkdir is the reservation: even an empty existing checkout must never be overwritten.
    await NodeFSP.mkdir(cwd, { mode: 0o700 });
    return cwd;
  }

  async read(file: string, offset: number, byteLength: number) {
    if (offset >= byteLength) throw new Error("Snapshot offset is outside the transfer.");
    const handle = await NodeFSP.open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(PROJECT_TRANSFER_CHUNK_BYTES, byteLength - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new Error("Snapshot changed while copying.");
      return buffer.toString("base64");
    } finally {
      await handle.close();
    }
  }

  async write(file: string, offset: number, data: string, byteLength: number) {
    const buffer = Buffer.from(data, "base64");
    if (
      !buffer.length ||
      buffer.length > PROJECT_TRANSFER_CHUNK_BYTES ||
      buffer.toString("base64") !== data ||
      offset + buffer.length > byteLength
    ) {
      throw new Error("Invalid project transfer chunk.");
    }
    const handle = await NodeFSP.open(file, "a");
    try {
      if ((await handle.stat()).size !== offset)
        throw new Error("Transfer offset changed. Restart the copy.");
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
    return buffer.length;
  }

  async validate(file: string) {
    let total = 0;
    let count = 0;
    const entries = new Set<string>();
    const links = new Set<string>();
    const paths: string[] = [];
    let problem: string | undefined;
    const safe = (value: string) =>
      !NodePath.posix.isAbsolute(value) &&
      !NodePath.win32.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").includes("..");
    await tar.list({
      file,
      strict: true,
      onReadEntry: (entry) => {
        const name = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
        count++;
        total += entry.size;
        if (total > PROJECT_TRANSFER_MAX_BYTES || count > 500_000) {
          problem = "Project copy exceeds the transfer limit.";
          return;
        }
        if (!safe(name) || entries.has(name))
          problem = "The snapshot contains an unsafe or duplicate NodePath.";
        if (!["File", "Directory", "SymbolicLink", "Link"].includes(entry.type))
          problem = "The snapshot contains unsupported special files.";
        if (entry.type === "SymbolicLink" || entry.type === "Link") {
          const resolved =
            entry.type === "Link"
              ? (entry.linkpath ?? "")
              : NodePath.posix.join(NodePath.posix.dirname(name), entry.linkpath ?? "");
          if (
            !safe(resolved) ||
            NodePath.posix.isAbsolute(entry.linkpath ?? "") ||
            NodePath.win32.isAbsolute(entry.linkpath ?? "")
          )
            problem =
              "The snapshot contains a link outside the project. Remove that link or choose a fresh clone.";
          links.add(name);
        }
        entries.add(name);
        paths.push(name);
        if (total > PROJECT_TRANSFER_MAX_BYTES || count > 500_000)
          problem = "Project copy exceeds the transfer limit.";
      },
    });
    for (const name of paths) {
      let parent = NodePath.posix.dirname(name);
      while (parent !== ".") {
        if (links.has(parent)) problem = "The snapshot writes through a symbolic link.";
        parent = NodePath.posix.dirname(parent);
      }
    }
    if (problem) throw new Error(problem);
  }

  async unpack(file: string, cwd: string, byteLength: number) {
    if ((await NodeFSP.stat(file)).size !== byteLength)
      throw new Error("The project transfer is incomplete.");
    await this.validate(file);
    await tar.extract({ file, cwd, strict: true, preservePaths: false, noChmod: false });
  }

  async remove(directory: string) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
  id() {
    return NodeCrypto.randomUUID();
  }
}
