// @effect-diagnostics nodeBuiltinImport:off - native Windows tests exercise the real filesystem and PowerShell process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { windowsFileCloneScript } from "./WindowsFileClone.ts";
import { makeFileClone } from "./FileClone.ts";
import { makeWorktreeClone } from "./WorktreeClone.ts";
import { makeWorktreeDependencies } from "./WorktreeDependencies.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { ServerConfig } from "../config.ts";

const WindowsGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-windows-clone-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

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
    { input: JSON.stringify([{ sources, destination }]), encoding: "utf8", timeout: 30_000 },
  );
}

describe.skipIf(HostProcessPlatform.defaultValue() !== "win32" || !process.env.T3_TEST_NTFS_ROOT)(
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
      "checks out 128 directories with one native helper process",
      () =>
        Effect.gen(function* () {
          const { source, destination } = yield* Effect.promise(() =>
            fixture(process.env.T3_TEST_REFS_ROOT!),
          );
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const git = (cwd: string, args: string[]) =>
            driver.execute({ operation: "test", cwd, args });
          yield* git(source, ["init", "--initial-branch=main"]);
          yield* git(source, ["config", "user.name", "Test"]);
          yield* git(source, ["config", "user.email", "test@example.com"]);
          yield* git(source, ["config", "core.autocrlf", "false"]);
          const content = Buffer.alloc(8193, 42);
          const names = Array.from({ length: 128 }, (_, index) => `directory-${index}/asset.bin`);
          yield* Effect.promise(async () => {
            for (const name of names) {
              await NodeFSP.mkdir(NodePath.dirname(NodePath.join(source, name)));
              await NodeFSP.writeFile(NodePath.join(source, name), content);
            }
          });
          yield* git(source, ["add", "."]);
          yield* git(source, ["commit", "-m", "many directories"]);
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          let helperProcesses = 0;
          const clone = yield* makeWorktreeClone(driver.execute).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
              ...spawner,
              exitCode: (command) => {
                helperProcesses += 1;
                return spawner.exitCode(command);
              },
            }),
          );
          const plan = yield* clone.prepare(source, "HEAD");
          expect(plan).not.toBeNull();
          const target = NodePath.join(destination, "worktree");
          yield* git(source, ["worktree", "add", "--no-checkout", "-b", "feature", target]);
          const started = yield* TestClock.withLive(Clock.monotonicTimeNanos);
          expect(yield* clone.checkout(plan!, target)).toBe(true);
          yield* Effect.logInfo("Windows tracked-file clone benchmark", {
            directories: names.length,
            helperProcesses,
            checkoutElapsedMs:
              Number((yield* TestClock.withLive(Clock.monotonicTimeNanos)) - started) / 1_000_000,
          });
          expect(helperProcesses).toBe(1);
          expect((yield* git(target, ["status", "--porcelain"])).stdout).toBe("");
          yield* Effect.promise(async () => {
            for (const name of names) {
              expect(await NodeFSP.readFile(NodePath.join(target, name))).toEqual(content);
            }
            await NodeFSP.writeFile(NodePath.join(target, names[0]!), "target edit");
            expect(await NodeFSP.readFile(NodePath.join(source, names[0]!))).toEqual(content);
          });
        }).pipe(Effect.provide(WindowsGitLayer)),
      90_000,
    );

    it.effect(
      "retains clean worktree clones and seeds isolated dependencies during setup",
      () =>
        Effect.gen(function* () {
          const { source, destination } = yield* Effect.promise(() =>
            fixture(process.env.T3_TEST_REFS_ROOT!),
          );
          const target = NodePath.join(destination, "worktree");
          const file = NodePath.join(source, "asset.bin");
          const content = Buffer.alloc(1024 * 1024 + 37, 42);
          const dependency = NodePath.join("node_modules", "package", "index.js");
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const git = (cwd: string, args: string[]) =>
            driver.execute({ operation: "test", cwd, args });
          yield* git(source, ["init", "--initial-branch=main"]);
          yield* git(source, ["config", "user.name", "Test"]);
          yield* git(source, ["config", "user.email", "test@example.com"]);
          yield* git(source, ["config", "core.autocrlf", "false"]);
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(file, content);
            await NodeFSP.writeFile(NodePath.join(source, ".gitignore"), "node_modules/\n.env\n");
            await NodeFSP.writeFile(NodePath.join(source, ".env"), "must not copy");
            await NodeFSP.writeFile(NodePath.join(source, "package.json"), '{"name":"fixture"}');
            await NodeFSP.writeFile(
              NodePath.join(source, "package-lock.json"),
              '{"lockfileVersion":3}',
            );
            await NodeFSP.writeFile(
              NodePath.join(source, "t3.json"),
              '{"worktreeCloneDependencies":true,"scripts":[{"name":"Install","command":"npm ci","runOnWorktreeCreate":true}]}',
            );
            await NodeFSP.mkdir(NodePath.dirname(NodePath.join(source, dependency)), {
              recursive: true,
            });
            await NodeFSP.writeFile(NodePath.join(source, dependency), Buffer.alloc(8193, 65));
          });
          yield* git(source, ["add", "."]);
          yield* git(source, ["commit", "-m", "fixture"]);
          let claimedWithoutCheckout = false;
          let clonedInode: number | undefined;
          yield* driver.createWorktree(
            { cwd: source, path: target, refName: "HEAD", newRefName: "feature/clone" },
            {
              progress: {
                onWorktreeClaimed: () =>
                  Effect.promise(async () => {
                    claimedWithoutCheckout = !(await NodeFSP.stat(
                      NodePath.join(target, "asset.bin"),
                    ).then(
                      () => true,
                      () => false,
                    ));
                  }),
                onCheckoutProgress: ({ percent }) =>
                  Effect.promise(async () => {
                    if (percent < 100)
                      clonedInode = (await NodeFSP.stat(NodePath.join(target, "asset.bin"))).ino;
                  }),
              },
            },
          );
          expect(claimedWithoutCheckout).toBe(true);
          expect(clonedInode).toBeDefined();
          const copied = NodePath.join(target, "asset.bin");
          const copyInfo = yield* Effect.promise(() => NodeFSP.stat(copied));
          expect(copyInfo.ino).toBe(clonedInode);
          expect((yield* git(target, ["status", "--porcelain"])).stdout).toBe("");
          yield* Effect.promise(() =>
            expect(NodeFSP.stat(NodePath.join(target, "node_modules"))).rejects.toThrow(),
          );
          const warmDependencies = yield* makeWorktreeDependencies();
          yield* warmDependencies(source, target);
          yield* Effect.promise(async () => {
            expect(await NodeFSP.readFile(copied)).toEqual(content);
            await expect(NodeFSP.stat(NodePath.join(target, ".env"))).rejects.toThrow();
            expect(await NodeFSP.readFile(NodePath.join(target, dependency))).toEqual(
              Buffer.alloc(8193, 65),
            );
            await NodeFSP.writeFile(copied, "target edit");
            expect(await NodeFSP.readFile(file)).toEqual(content);
            await NodeFSP.writeFile(file, "source edit");
            expect(await NodeFSP.readFile(copied, "utf8")).toBe("target edit");
            await NodeFSP.writeFile(NodePath.join(target, dependency), "dependency edit");
            expect(await NodeFSP.readFile(NodePath.join(source, dependency))).toEqual(
              Buffer.alloc(8193, 65),
            );
          });
        }).pipe(Effect.provide(WindowsGitLayer)),
      60_000,
    );

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
