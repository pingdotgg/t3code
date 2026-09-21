// @effect-diagnostics nodeBuiltinImport:off - native clone flags and inode metadata provide an independent filesystem oracle.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { makeFileClone } from "./FileClone.ts";

// Run with TMPDIR on Btrfs or reflink-enabled XFS to exercise the successful path.
// Ordinary Linux CI filesystems still exercise the explicit unsupported result.
describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("Linux file clones", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("clones isolated trees with metadata or reports unsupported storage", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reflink-" });
        const source = NodePath.join(root, "source");
        const destination = NodePath.join(root, "destination");
        const file = NodePath.join(source, "nested", "-payload\nfile");
        const content = Buffer.alloc(1024 * 1024, 42);
        const supportsReflinks = yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(source, "nested"), { recursive: true });
          await NodeFSP.mkdir(destination);
          await NodeFSP.writeFile(file, content, { mode: 0o751 });
          await NodeFSP.utimes(file, 1_234_567_890, 1_234_567_890);
          await NodeFSP.link(file, NodePath.join(source, "hardlink"));
          await NodeFSP.symlink("nested/-payload\nfile", NodePath.join(source, "relative"));
          await NodeFSP.symlink("missing", NodePath.join(source, "dangling"));
          return NodeFSP.copyFile(
            file,
            NodePath.join(root, "probe"),
            NodeFS.constants.COPYFILE_FICLONE_FORCE,
          ).then(
            () => true,
            (error: unknown) => {
              if (
                !(error instanceof Error) ||
                !("code" in error) ||
                !["ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(String(error.code))
              )
                throw error;
              return false;
            },
          );
        });
        const clone = yield* makeFileClone();
        assert.isTrue(clone.supported);
        const result = yield* clone.clone([source], destination).pipe(Effect.result);
        if (result._tag === "Failure") {
          assert.isFalse(supportsReflinks);
          assert.instanceOf(result.failure, GitCommandError);
          return;
        }
        assert.isTrue(supportsReflinks);
        yield* Effect.promise(async () => {
          const target = NodePath.join(destination, "source", "nested", "-payload\nfile");
          const sourceStat = await NodeFSP.stat(file);
          const targetStat = await NodeFSP.stat(target);
          assert.deepEqual(await NodeFSP.readFile(target), content);
          assert.notEqual(targetStat.ino, sourceStat.ino);
          assert.notEqual(
            targetStat.ino,
            (await NodeFSP.stat(NodePath.join(destination, "source", "hardlink"))).ino,
          );
          assert.equal(targetStat.mode, sourceStat.mode);
          assert.equal(targetStat.mtimeMs, sourceStat.mtimeMs);
          assert.equal(
            await NodeFSP.readlink(NodePath.join(destination, "source", "relative")),
            "nested/-payload\nfile",
          );
          assert.equal(
            await NodeFSP.readlink(NodePath.join(destination, "source", "dangling")),
            "missing",
          );
          await NodeFSP.writeFile(target, "changed");
          assert.deepEqual(await NodeFSP.readFile(file), content);
          assert.deepEqual(
            await NodeFSP.readFile(NodePath.join(destination, "source", "hardlink")),
            content,
          );
        });
      }),
    );
  });
});
