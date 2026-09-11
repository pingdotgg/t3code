// @effect-diagnostics nodeBuiltinImport:off - exercises the filesystem transfer boundary with disposable checkouts.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as tar from "tar";
import { PROJECT_TRANSFER_CHUNK_BYTES } from "@t3tools/contracts";
import { ProjectTransferFiles } from "./ProjectTransferFiles.ts";

let root: string;
const files = new ProjectTransferFiles();
beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-copy-test-"));
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});
const git = (cwd: string, args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

async function copy(source: string, ignored = new Set<string>()) {
  const archive = NodePath.join(root, "archive");
  await NodeFSP.mkdir(archive);
  const packed = await files.pack(source, archive, ignored);
  const received = NodePath.join(root, "received.tar");
  for (let offset = 0; offset < packed.byteLength; offset += PROJECT_TRANSFER_CHUNK_BYTES) {
    await files.write(
      received,
      offset,
      await files.read(packed.file, offset, packed.byteLength),
      packed.byteLength,
    );
  }
  const destination = await files.reserve(NodePath.join(root, "destination"));
  await files.unpack(received, destination, packed.byteLength);
  return destination;
}

describe("project snapshot transfer", () => {
  it("preserves Git commits, staged and unstaged changes, ignored and binary files, executable bits and internal links", async () => {
    const source = NodePath.join(root, "source");
    await NodeFSP.mkdir(source);
    git(source, ["init", "-b", "main"]);
    git(source, ["config", "user.name", "Transfer Test"]);
    git(source, ["config", "user.email", "transfer@example.test"]);
    await NodeFSP.writeFile(NodePath.join(source, "tracked"), "committed\n");
    await NodeFSP.writeFile(NodePath.join(source, ".gitignore"), ".env\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "initial"]);
    await NodeFSP.writeFile(NodePath.join(source, "tracked"), "staged\n");
    git(source, ["add", "tracked"]);
    await NodeFSP.writeFile(NodePath.join(source, "tracked"), "unstaged\n");
    await NodeFSP.writeFile(NodePath.join(source, ".env"), "EXAMPLE=test\n");
    await NodeFSP.writeFile(NodePath.join(source, "binary"), Buffer.alloc(700_000, 0xab));
    await NodeFSP.writeFile(NodePath.join(source, "run.sh"), "#!/bin/sh\necho ready\n", {
      mode: 0o755,
    });
    await NodeFSP.symlink("tracked", NodePath.join(source, "link"));
    const destination = await copy(source);
    expect(git(destination, ["rev-parse", "HEAD"])).toBe(git(source, ["rev-parse", "HEAD"]));
    expect(git(destination, ["diff", "--cached"])).toBe(git(source, ["diff", "--cached"]));
    expect(git(destination, ["diff"])).toBe(git(source, ["diff"]));
    expect(await NodeFSP.readFile(NodePath.join(destination, ".env"), "utf8")).toBe(
      "EXAMPLE=test\n",
    );
    expect(await NodeFSP.readFile(NodePath.join(destination, "binary"))).toEqual(
      Buffer.alloc(700_000, 0xab),
    );
    expect((await NodeFSP.stat(NodePath.join(destination, "run.sh"))).mode & 0o111).toBe(0o111);
    expect(await NodeFSP.readlink(NodePath.join(destination, "link"))).toBe("tracked");
  });

  it("copies non-Git projects and empty directories while excluding selected ignored directories", async () => {
    const source = NodePath.join(root, "source");
    await NodeFSP.mkdir(NodePath.join(source, "empty"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(source, "node_modules"));
    await NodeFSP.writeFile(NodePath.join(source, "node_modules", "package"), "large");
    await NodeFSP.writeFile(NodePath.join(source, "notes"), "notes");
    const destination = await copy(source, new Set(["node_modules"]));
    expect((await NodeFSP.stat(NodePath.join(destination, "empty"))).isDirectory()).toBe(true);
    expect(await NodeFSP.readdir(destination)).toEqual(["empty", "notes"]);
  });

  it("refuses existing destinations without changing any files", async () => {
    const destination = NodePath.join(root, "existing");
    await NodeFSP.mkdir(destination);
    await NodeFSP.writeFile(NodePath.join(destination, "keep"), "original");
    await expect(files.reserve(destination)).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(destination, "keep"), "utf8")).toBe("original");
  });

  it("rejects incomplete and out-of-order uploads", async () => {
    const file = NodePath.join(root, "upload.tar");
    await files.write(file, 0, Buffer.from("abc").toString("base64"), 6);
    await expect(files.write(file, 0, Buffer.from("def").toString("base64"), 6)).rejects.toThrow(
      "offset",
    );
    await expect(files.unpack(file, root, 6)).rejects.toThrow("incomplete");
  });

  it("refuses links escaping the project before extraction", async () => {
    const source = NodePath.join(root, "source");
    await NodeFSP.mkdir(source);
    await NodeFSP.symlink("../../outside", NodePath.join(source, "escape"));
    const archive = NodePath.join(root, "unsafe.tar");
    await tar.create({ cwd: source, file: archive }, ["."]);
    await expect(files.validate(archive)).rejects.toThrow("outside");
  });

  it("refuses linked worktrees rather than copying a pointer to the source machine", async () => {
    const source = NodePath.join(root, "source");
    await NodeFSP.mkdir(source);
    await NodeFSP.writeFile(NodePath.join(source, ".git"), "gitdir: /somewhere/else");
    await expect(files.pack(source, root, new Set())).rejects.toThrow("external Git directory");
  });
});
