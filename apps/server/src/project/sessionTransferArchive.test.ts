// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  readTransferArchive,
  writeTransferArchive,
  workspaceFingerprint,
  type TransferMetadata,
} from "./sessionTransferArchive.ts";
const metadata: TransferMetadata = {
  version: 1,
  title: "Test",
  sourceThreadId: "remote",
  branch: null,
  hasGit: false,
  hasCommit: false,
  runtimeMode: "approval-required",
  interactionMode: "default",
  messages: [],
};
async function fixture() {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-archive-"));
  const root = NodePath.join(base, "source");
  const local = NodePath.join(base, "local");
  const gitData = NodePath.join(base, "git");
  await Promise.all([root, local, gitData].map((path) => NodeFSP.mkdir(path)));
  return {
    base,
    root,
    local,
    gitData,
    archive: NodePath.join(base, "archive.bin"),
    cleanup: () => NodeFSP.rm(base, { recursive: true, force: true }),
  };
}
function record(value: unknown) {
  const data = Buffer.from(JSON.stringify(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}
it("preserves binary data, empty directories and executable files with a stable workspace fingerprint", async () => {
  const f = await fixture();
  try {
    await NodeFSP.mkdir(NodePath.join(f.root, "empty"));
    await NodeFSP.writeFile(NodePath.join(f.root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await NodeFSP.writeFile(NodePath.join(f.root, "binary"), Buffer.from([0, 255, 128, 10]));
    const captured = await writeTransferArchive({
      root: f.root,
      output: f.archive,
      metadata,
      tracked: new Set(),
      bundlePath: null,
      indexPath: null,
      attachments: new Map(),
    });
    expect(captured.fingerprint).toBe(await workspaceFingerprint(f.root, metadata, new Set()));
    await readTransferArchive({ archive: f.archive, root: f.local, gitData: f.gitData });
    expect(await NodeFSP.readFile(NodePath.join(f.local, "binary"))).toEqual(
      Buffer.from([0, 255, 128, 10]),
    );
    expect((await NodeFSP.stat(NodePath.join(f.local, "empty"))).isDirectory()).toBe(true);
    if (HostProcessPlatform.defaultValue() !== "win32")
      expect((await NodeFSP.stat(NodePath.join(f.local, "run.sh"))).mode & 0o777).toBe(0o755);
    await NodeFSP.writeFile(NodePath.join(f.root, "binary"), "changed");
    expect(await workspaceFingerprint(f.root, metadata, new Set())).not.toBe(captured.fingerprint);
  } finally {
    await f.cleanup();
  }
});
it.each(["../escape", "/absolute", ".git/config", "sub/.git/config", "sub\\escape", "C:escape"])(
  "rejects unsafe archive path %s before writing files",
  async (path) => {
    const f = await fixture();
    try {
      await NodeFSP.writeFile(
        f.archive,
        Buffer.concat([
          record({ kind: "metadata", metadata }),
          record({ kind: "file", path, size: 1, mode: 0o600 }),
          Buffer.from("x"),
          record({ kind: "end" }),
        ]),
      );
      await expect(
        readTransferArchive({ archive: f.archive, root: f.local, gitData: f.gitData }),
      ).rejects.toThrow("safely");
      expect(await NodeFSP.readdir(f.local)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
);
it("rejects truncated bodies and duplicate destinations", async () => {
  const f = await fixture();
  try {
    await NodeFSP.writeFile(
      f.archive,
      Buffer.concat([
        record({ kind: "metadata", metadata }),
        record({ kind: "file", path: "file", size: 100, mode: 0o600 }),
        Buffer.from("x"),
      ]),
    );
    await expect(
      readTransferArchive({ archive: f.archive, root: f.local, gitData: f.gitData }),
    ).rejects.toThrow("incomplete");
    await NodeFSP.rm(NodePath.join(f.local, "file"));
    await NodeFSP.writeFile(
      f.archive,
      Buffer.concat([
        record({ kind: "metadata", metadata }),
        record({ kind: "file", path: "file", size: 0, mode: 0o600 }),
        record({ kind: "file", path: "file", size: 0, mode: 0o600 }),
        record({ kind: "end" }),
      ]),
    );
    await expect(
      readTransferArchive({ archive: f.archive, root: f.local, gitData: f.gitData }),
    ).rejects.toThrow("Duplicate");
  } finally {
    await f.cleanup();
  }
});
it("refuses symbolic links rather than copying data outside the project", async () => {
  const f = await fixture();
  try {
    await NodeFSP.writeFile(NodePath.join(f.base, "outside"), "private");
    await NodeFSP.symlink(NodePath.join(f.base, "outside"), NodePath.join(f.root, "link"));
    await expect(
      writeTransferArchive({
        root: f.root,
        output: f.archive,
        metadata,
        tracked: new Set(),
        bundlePath: null,
        indexPath: null,
        attachments: new Map(),
      }),
    ).rejects.toThrow("symbolic links");
  } finally {
    await f.cleanup();
  }
});
it("retains tracked files inside normally excluded dependency directories", async () => {
  const f = await fixture();
  try {
    await NodeFSP.mkdir(NodePath.join(f.root, "node_modules"));
    await NodeFSP.writeFile(NodePath.join(f.root, "node_modules", "tracked"), "source");
    await writeTransferArchive({
      root: f.root,
      output: f.archive,
      metadata,
      tracked: new Set(["node_modules/tracked"]),
      bundlePath: null,
      indexPath: null,
      attachments: new Map(),
    });
    await readTransferArchive({ archive: f.archive, root: f.local, gitData: f.gitData });
    expect(await NodeFSP.readFile(NodePath.join(f.local, "node_modules", "tracked"), "utf8")).toBe(
      "source",
    );
  } finally {
    await f.cleanup();
  }
});
