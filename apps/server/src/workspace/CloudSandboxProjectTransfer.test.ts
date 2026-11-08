// @effect-diagnostics nodeBuiltinImport:off -- Real Git/filesystem fixtures verify checkout transfer without an SSH server.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { EnvironmentId, ManagedCloudSandboxResourceId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Manager from "../cloudSandbox/CloudSandboxManager.ts";
import * as Transfer from "./CloudSandboxProjectTransfer.ts";

it.live(
  "copies a dirty linked checkout without dependencies or source git metadata and preserves retries",
  () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-transfer-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const repository = NodePath.join(directory, "source");
      const cwd = NodePath.join(directory, "linked");
      const remoteHome = NodePath.join(directory, "remote");
      NodeFS.mkdirSync(repository);
      NodeFS.mkdirSync(remoteHome);
      const git = (at: string, args: string[]) =>
        NodeChildProcess.execFileSync("git", args, { cwd: at, encoding: "utf8" }).trim();
      git(repository, ["init", "-b", "main"]);
      git(repository, ["config", "user.email", "test@example.com"]);
      git(repository, ["config", "user.name", "Test"]);
      NodeFS.writeFileSync(NodePath.join(repository, ".gitignore"), "node_modules/\n");
      NodeFS.writeFileSync(NodePath.join(repository, "tracked"), "initial");
      NodeFS.writeFileSync(NodePath.join(repository, "deleted"), "initial");
      NodeFS.writeFileSync(NodePath.join(repository, "executable"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      git(repository, ["add", "."]);
      git(repository, ["update-index", "--chmod=+x", "executable"]);
      git(repository, ["commit", "-m", "initial"]);
      git(repository, ["worktree", "add", "-b", "linked", cwd]);
      NodeFS.chmodSync(NodePath.join(cwd, "executable"), 0o755);
      NodeFS.writeFileSync(NodePath.join(cwd, "tracked"), "staged");
      git(cwd, ["add", "tracked"]);
      NodeFS.writeFileSync(NodePath.join(cwd, "tracked"), "unstaged");
      NodeFS.unlinkSync(NodePath.join(cwd, "deleted"));
      const binary = new Uint8Array([0, 255, 7, 128]);
      NodeFS.writeFileSync(NodePath.join(cwd, "--binary\nfile"), binary);
      NodeFS.symlinkSync("missing-target", NodePath.join(cwd, "symlink"));
      NodeFS.mkdirSync(NodePath.join(cwd, "node_modules"));
      NodeFS.writeFileSync(NodePath.join(cwd, "node_modules", "ignored"), "not transferred");
      const indexPath = git(cwd, ["rev-parse", "--git-path", "index"]);
      const originalIndex = NodeFS.readFileSync(indexPath);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const ssh = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand" && command.command === "ssh") {
          return spawner.spawn(
            ChildProcess.make(
              "sh",
              ["-c", command.args.slice(command.args.indexOf("--") + 2).join(" ")],
              {
                ...command.options,
                env: { HOME: remoteHome },
                extendEnv: true,
              },
            ),
          );
        }
        return spawner.spawn(command);
      });
      const resourceId = ManagedCloudSandboxResourceId.make("workspace");
      const environmentId = EnvironmentId.make("child");
      const manager = Layer.mock(Manager.CloudSandboxManager)({
        withConnection: (_id, effect) =>
          Effect.scoped(
            effect(
              { alias: "child", hostname: "child.invalid", username: "sandbox", port: 22 },
              {
                httpBaseUrl: "http://child.invalid",
                pairingToken: "fixture",
                connection: {
                  sandboxId: "sandbox",
                  driverKind: "boat",
                  resourceId,
                  controllerEnvironmentId: EnvironmentId.make("controller"),
                  environmentId,
                  label: "Child",
                  routePrefix: "/proxy",
                  bearerToken: "fixture",
                },
              },
            ),
          ),
      });
      const transfer = yield* Transfer.CloudSandboxProjectTransfer.pipe(
        Effect.provide(
          Transfer.layer.pipe(
            Layer.provide(manager),
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ssh)),
          ),
        ),
      );
      const target = yield* transfer.transfer({ resourceId, cwd });
      expect(git(target, ["rev-parse", "HEAD"])).toBe(git(cwd, ["rev-parse", "HEAD"]));
      expect(NodeFS.readFileSync(NodePath.join(target, "tracked"), "utf8")).toBe("unstaged");
      expect(NodeFS.existsSync(NodePath.join(target, "deleted"))).toBe(false);
      expect(new Uint8Array(NodeFS.readFileSync(NodePath.join(target, "--binary\nfile")))).toEqual(
        binary,
      );
      expect(NodeFS.readlinkSync(NodePath.join(target, "symlink"))).toBe("missing-target");
      expect(NodeFS.statSync(NodePath.join(target, "executable")).mode & 0o111).toBe(0o111);
      expect(NodeFS.existsSync(NodePath.join(target, "node_modules"))).toBe(false);
      expect(NodeFS.statSync(NodePath.join(target, ".git")).isDirectory()).toBe(true);
      expect(NodeFS.readFileSync(indexPath)).toEqual(originalIndex);
      NodeFS.writeFileSync(NodePath.join(target, "tracked"), "child work");
      expect(yield* transfer.transfer({ resourceId, cwd })).toBe(target);
      expect(NodeFS.readFileSync(NodePath.join(target, "tracked"), "utf8")).toBe("child work");
    }).pipe(
      Effect.provide(
        Git.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-transfer-config-" }),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
);

it.live(
  "transfers unborn repositories, shallow clones, symlinked subdirectory cwds, and uses POSIX mv without -T",
  () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "sandbox-transfer-edge-"),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const remoteHome = NodePath.join(directory, "remote");
      const posixBin = NodePath.join(directory, "posix-bin");
      NodeFS.mkdirSync(remoteHome);
      NodeFS.mkdirSync(posixBin);
      // Reject GNU-only `mv -T` to verify Alpine/BusyBox/BSD portability.
      NodeFS.writeFileSync(
        NodePath.join(posixBin, "mv"),
        '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "-T" ]; then\n    echo "mv: invalid option -- T" >&2\n    exit 1\n  fi\ndone\nexec /bin/mv "$@"\n',
        { mode: 0o755 },
      );

      const git = (at: string, args: string[]) =>
        NodeChildProcess.execFileSync("git", args, { cwd: at, encoding: "utf8" }).trim();

      // 1. Unborn HEAD repository with zero files, then with uncommitted file.
      const unbornEmpty = NodePath.join(directory, "unborn-empty");
      NodeFS.mkdirSync(unbornEmpty);
      git(unbornEmpty, ["init", "-b", "main"]);

      const unbornDirty = NodePath.join(directory, "unborn-dirty");
      NodeFS.mkdirSync(unbornDirty);
      git(unbornDirty, ["init", "-b", "main"]);
      NodeFS.writeFileSync(NodePath.join(unbornDirty, "draft.txt"), "uncommitted");

      // 2. Shallow clone accessed via a symlinked parent directory at a nested package cwd.
      const origin = NodePath.join(directory, "origin");
      NodeFS.mkdirSync(origin);
      git(origin, ["init", "-b", "main"]);
      git(origin, ["config", "user.email", "test@example.com"]);
      git(origin, ["config", "user.name", "Test"]);
      NodeFS.mkdirSync(NodePath.join(origin, "packages", "app"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(origin, "packages", "app", "index.ts"), "v1\n");
      git(origin, ["add", "."]);
      git(origin, ["commit", "-m", "c1"]);
      NodeFS.writeFileSync(NodePath.join(origin, "packages", "app", "index.ts"), "v2\n");
      git(origin, ["commit", "-am", "c2"]);

      const realCloneRoot = NodePath.join(directory, "real-root");
      NodeFS.mkdirSync(realCloneRoot);
      const shallowClone = NodePath.join(realCloneRoot, "shallow");
      git(directory, ["clone", "--depth", "1", `file://${origin}`, shallowClone]);
      NodeFS.writeFileSync(NodePath.join(shallowClone, "packages", "app", "dirty.ts"), "dirty\n");

      const symlinkRoot = NodePath.join(directory, "symlink-root");
      NodeFS.symlinkSync(realCloneRoot, symlinkRoot);
      const symlinkSubdirCwd = NodePath.join(symlinkRoot, "shallow", "packages", "app");

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const ssh = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand" && command.command === "ssh") {
          return spawner.spawn(
            ChildProcess.make(
              "sh",
              ["-c", command.args.slice(command.args.indexOf("--") + 2).join(" ")],
              {
                ...command.options,
                env: {
                  HOME: remoteHome,
                  PATH: `${posixBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
                },
                extendEnv: true,
              },
            ),
          );
        }
        return spawner.spawn(command);
      });

      const environmentId = EnvironmentId.make("child");
      const manager = Layer.mock(Manager.CloudSandboxManager)({
        withConnection: (id, effect) =>
          Effect.scoped(
            effect(
              { alias: "child", hostname: "child.invalid", username: "sandbox", port: 22 },
              {
                httpBaseUrl: "http://child.invalid",
                pairingToken: "fixture",
                connection: {
                  sandboxId: "sandbox",
                  driverKind: "boat",
                  resourceId: id,
                  controllerEnvironmentId: EnvironmentId.make("controller"),
                  environmentId,
                  label: "Child",
                  routePrefix: "/proxy",
                  bearerToken: "fixture",
                },
              },
            ),
          ),
      });
      const transfer = yield* Transfer.CloudSandboxProjectTransfer.pipe(
        Effect.provide(
          Transfer.layer.pipe(
            Layer.provide(manager),
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ssh)),
          ),
        ),
      );

      const emptyTarget = yield* transfer.transfer({
        resourceId: ManagedCloudSandboxResourceId.make("fleet-unborn-empty"),
        cwd: unbornEmpty,
      });
      expect(NodeFS.statSync(NodePath.join(emptyTarget, ".git")).isDirectory()).toBe(true);

      const dirtyTarget = yield* transfer.transfer({
        resourceId: ManagedCloudSandboxResourceId.make("fleet-unborn-dirty"),
        cwd: unbornDirty,
      });
      expect(NodeFS.readFileSync(NodePath.join(dirtyTarget, "draft.txt"), "utf8")).toBe(
        "uncommitted",
      );

      const shallowTarget = yield* transfer.transfer({
        resourceId: ManagedCloudSandboxResourceId.make("fleet-shallow"),
        cwd: symlinkSubdirCwd,
      });
      expect(shallowTarget.endsWith("/repo/packages/app")).toBe(true);
      expect(shallowTarget.includes("..")).toBe(false);
      expect(git(shallowTarget, ["rev-parse", "HEAD"])).toBe(
        git(shallowClone, ["rev-parse", "HEAD"]),
      );
      expect(NodeFS.readFileSync(NodePath.join(shallowTarget, "index.ts"), "utf8")).toBe("v2\n");
      expect(NodeFS.readFileSync(NodePath.join(shallowTarget, "dirty.ts"), "utf8")).toBe("dirty\n");
    }).pipe(
      Effect.provide(
        Git.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-transfer-edge-config-" }),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
);
