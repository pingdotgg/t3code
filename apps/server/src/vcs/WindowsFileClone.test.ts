// @effect-diagnostics nodeBuiltinImport:off - native Windows tests exercise the real filesystem and PowerShell process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { windowsFileCloneScript } from "./WindowsFileClone.ts";
import { makeFileClone } from "./FileClone.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(root: string) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(root, "t3-clone-"));
  temporary.push(directory);
  const source = NodePath.join(directory, "source ' ü $payload");
  const destination = NodePath.join(directory, "destination");
  await NodeFSP.mkdir(source);
  await NodeFSP.mkdir(destination);
  return { source, destination };
}

function clone(sources: string[], destination: string) {
  return NodeChildProcess.spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsFileCloneScript, "utf16le").toString("base64"),
    ],
    { input: JSON.stringify({ sources, destination }), encoding: "utf8", timeout: 30_000 },
  );
}

describe.skipIf(HostProcessPlatform.defaultValue() !== "win32")(
  "Windows block clone fallback",
  () => {
    it.effect(
      "reports unsupported volumes through the server adapter",
      () =>
        Effect.gen(function* () {
          const { source, destination } = yield* Effect.promise(() =>
            fixture(process.env.T3_TEST_NTFS_ROOT ?? NodeOS.tmpdir()),
          );
          const file = NodePath.join(source, "large.bin");
          yield* Effect.promise(() => NodeFSP.writeFile(file, Buffer.alloc(1024 * 1024, 42)));
          const adapter = yield* makeFileClone();
          expect(adapter.supported).toBe(true);
          const error = yield* adapter.clone([file], destination).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "GitCommandError",
            detail: "Filesystem clone unavailable",
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      30_000,
    );

    it("rejects NTFS without copying file data", async () => {
      const { source, destination } = await fixture(
        process.env.T3_TEST_NTFS_ROOT ?? NodeOS.tmpdir(),
      );
      const file = NodePath.join(source, "large.bin");
      await NodeFSP.writeFile(file, Buffer.alloc(1024 * 1024, 42));
      const result = clone([file], destination);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("requires ReFS");
      await expect(NodeFSP.stat(NodePath.join(destination, "large.bin"))).rejects.toThrow();
    });
  },
);

describe.skipIf(HostProcessPlatform.defaultValue() !== "win32" || !process.env.T3_TEST_REFS_ROOT)(
  "Windows ReFS block clones",
  () => {
    it.effect(
      "clones through the server process adapter",
      () =>
        Effect.gen(function* () {
          const { source, destination } = yield* Effect.promise(() =>
            fixture(process.env.T3_TEST_REFS_ROOT!),
          );
          const file = NodePath.join(source, "unicode ' ü $payload.bin");
          const content = Buffer.alloc(8193, 42);
          yield* Effect.promise(() => NodeFSP.writeFile(file, content));
          const adapter = yield* makeFileClone();
          yield* adapter.clone([file], destination);
          const copied = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(destination, NodePath.basename(file))),
          );
          expect(copied).toEqual(content);
        }).pipe(Effect.provide(NodeServices.layer)),
      30_000,
    );

    it("clones a recursive tree, preserves timestamps, and isolates writes in both directions", async () => {
      const { source, destination } = await fixture(process.env.T3_TEST_REFS_ROOT!);
      await NodeFSP.mkdir(NodePath.join(source, "nested"));
      const content = Buffer.alloc(2 * 1024 * 1024 + 123, 42);
      const file = NodePath.join(source, "nested", "large.bin");
      await NodeFSP.writeFile(file, content);
      await NodeFSP.writeFile(NodePath.join(source, "empty"), "");
      await NodeFSP.writeFile(NodePath.join(source, "tiny"), "hello");
      const timestamp = 1577934245;
      await NodeFSP.utimes(file, timestamp, timestamp);
      const result = clone([source], destination);
      expect(result.status, result.stderr).toBe(0);
      const copied = NodePath.join(destination, NodePath.basename(source), "nested", "large.bin");
      expect(await NodeFSP.readFile(copied)).toEqual(content);
      expect((await NodeFSP.stat(copied)).mtimeMs).toBe(timestamp * 1000);
      expect(
        await NodeFSP.readFile(
          NodePath.join(destination, NodePath.basename(source), "tiny"),
          "utf8",
        ),
      ).toBe("hello");
      expect(
        (await NodeFSP.stat(NodePath.join(destination, NodePath.basename(source), "empty"))).size,
      ).toBe(0);
      await NodeFSP.writeFile(copied, "destination change");
      expect(await NodeFSP.readFile(file)).toEqual(content);
      await NodeFSP.writeFile(file, "source change");
      expect(await NodeFSP.readFile(copied, "utf8")).toBe("destination change");
    });

    it("preserves relative symbolic links without copying the target", async () => {
      const { source, destination } = await fixture(process.env.T3_TEST_REFS_ROOT!);
      await NodeFSP.writeFile(NodePath.join(source, "target"), "original");
      await NodeFSP.symlink("target", NodePath.join(source, "link"), "file");
      const result = clone([source], destination);
      expect(result.status, result.stderr).toBe(0);
      expect(
        await NodeFSP.readlink(NodePath.join(destination, NodePath.basename(source), "link")),
      ).toBe("target");
      await NodeFSP.writeFile(NodePath.join(source, "target"), "changed");
      expect(
        await NodeFSP.readFile(
          NodePath.join(destination, NodePath.basename(source), "link"),
          "utf8",
        ),
      ).toBe("original");
    });

    it("rejects a different destination volume", async () => {
      const { source } = await fixture(process.env.T3_TEST_REFS_ROOT!);
      const { destination } = await fixture(process.env.T3_TEST_NTFS_ROOT ?? NodeOS.tmpdir());
      const file = NodePath.join(source, "large.bin");
      await NodeFSP.writeFile(file, Buffer.alloc(1024 * 1024, 42));
      const result = clone([file], destination);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("same volume");
      await expect(NodeFSP.stat(NodePath.join(destination, "large.bin"))).rejects.toThrow();
    });
  },
);
