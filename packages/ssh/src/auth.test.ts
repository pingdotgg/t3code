import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import { buildSshChildEnvironment, isSshAgentSigningFailure, isSshAuthFailure } from "./auth.ts";

describe("ssh auth", () => {
  it.effect("detects ssh auth failures from common permission denied messages", () =>
    Effect.sync(() => {
      assert.equal(
        isSshAuthFailure(
          new Error(
            "julius@100.65.180.100: Permission denied (publickey,password,keyboard-interactive).",
          ),
        ),
        true,
      );
      assert.equal(isSshAuthFailure(new Error("Permission denied (publickey).")), true);
      assert.equal(isSshAuthFailure(new Error("Connection timed out")), false);
      assert.equal(isSshAuthFailure(new Error("mkdir: Permission denied")), false);
    }),
  );

  it.effect("detects agent signing failures from current and pre-8.2 OpenSSH", () =>
    Effect.sync(() => {
      const denied = "julius@devbox: Permission denied (publickey,password).";
      assert.isTrue(
        isSshAgentSigningFailure(
          new Error(
            `sign_and_send_pubkey: signing failed for ED25519 "/home/julius/.ssh/id_ed25519" from agent: communication with agent failed\r\n${denied}`,
          ),
        ),
      );
      assert.isTrue(
        isSshAgentSigningFailure(
          new Error(`sign_and_send_pubkey: signing failed: agent refused operation\n${denied}`),
        ),
      );
      assert.isTrue(
        isSshAgentSigningFailure(
          new Error(
            `sign_and_send_pubkey: signing failed: communication with agent failed\n${denied}`,
          ),
        ),
      );
      assert.isFalse(
        isSshAgentSigningFailure(
          new Error(
            `sign_and_send_pubkey: signing failed for ED25519-SK "/home/julius/.ssh/id_ed25519_sk": device not found\n${denied}`,
          ),
        ),
      );
      assert.isFalse(isSshAgentSigningFailure(new Error(denied)));
    }),
  );

  it.effect("creates askpass env for cached password prompts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-askpass-test-" });
      const env = yield* buildSshChildEnvironment({
        authSecret: "super-secret",
        interactiveAuth: true,
        askpassDirectory: directory,
        baseEnv: {},
      });

      const askpassPath = path.join(directory, "ssh-askpass.sh");
      assert.equal(env.SSH_ASKPASS, askpassPath);
      assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
      assert.equal(env.T3_SSH_AUTH_SECRET, "super-secret");
      assert.equal(env.DISPLAY, "t3code");
      assert.equal(yield* fs.exists(askpassPath), true);
      assert.include(yield* fs.readFileString(askpassPath), 'printf "%s\\n" "$T3_SSH_AUTH_SECRET"');
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(HostProcess.Platform, "linux"))),
    ),
  );

  it.effect("picks the Windows askpass helper that the installed ssh client can start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-askpass-test-" });
      const dir = path.join(temp, "askpass");
      const cases = [
        {
          banner: "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
          isExecutable: false,
          askpass: `"C:\\fake\\node.exe" "${dir}\\ssh-askpass.cjs"`,
          nodeOptions: undefined,
          runAsNode: "1",
        },
        {
          banner: "OpenSSH_for_Windows_8.1p1, LibreSSL 2.9.2",
          execPath: "C:\\a.exe b\\node.EXE",
          isExecutable: false,
          askpass: `"C:\\a.exe b\\node.EXE" "${dir}\\ssh-askpass.cjs"`,
          nodeOptions: undefined,
          runAsNode: "1",
        },
        {
          banner: "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
          isExecutable: true,
          askpass: `"C:\\fake\\node.exe" "${dir}\\ssh-askpass.cjs"`,
          nodeOptions: `--require "${dir.replaceAll("\\", "/")}/ssh-askpass.cjs"`,
          runAsNode: "1",
        },
        {
          banner: "OpenSSH_10.6p1, OpenSSL 3.5.9 29 Sep 2026",
          isExecutable: false,
          askpass: `${dir}\\ssh-askpass.sh`,
          nodeOptions: undefined,
          runAsNode: undefined,
        },
      ];
      for (const testCase of cases) {
        const spawned: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            if (command._tag === "StandardCommand") {
              spawned.push([command.command, ...command.args].map(String));
            }
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: Stream.empty,
              stderr: Stream.make(new TextEncoder().encode(`${testCase.banner}\r\n`)),
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
        );
        const env = yield* buildSshChildEnvironment({
          authSecret: "super-secret",
          interactiveAuth: true,
          askpassDirectory: dir,
          baseEnv: {},
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcess.IsExecutable, testCase.isExecutable),
          Effect.provideService(
            HostProcess.ExecutablePath,
            testCase.execPath ?? "C:\\fake\\node.exe",
          ),
        );

        assert.deepEqual(spawned, [["ssh.exe", "-V"]]);
        assert.equal(env.SSH_ASKPASS, testCase.askpass);
        assert.equal(env.NODE_OPTIONS, testCase.nodeOptions);
        assert.equal(env.ELECTRON_RUN_AS_NODE, testCase.runAsNode);
        assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
        assert.equal(env.T3_SSH_AUTH_SECRET, "super-secret");
      }

      assert.equal(yield* fs.exists(`${dir}\\ssh-askpass.cmd`), false);
      assert.notInclude(yield* fs.readFileString(`${dir}\\ssh-askpass.cjs`), "process.argv");
      assert.include(
        yield* fs.readFileString(`${dir}\\ssh-askpass.sh`),
        'printf "%s\\n" "$T3_SSH_AUTH_SECRET"',
      );
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(HostProcess.Platform, "win32"))),
    ),
  );

  it.effect("reuses the default askpass directory across interactive commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const askpassPath = () =>
        buildSshChildEnvironment({ interactiveAuth: true, authSecret: "pw" }).pipe(
          Effect.map((env) => env.SSH_ASKPASS ?? ""),
        );
      const runtimeDirectoryOf = (askpass: string) => path.dirname(path.dirname(askpass));

      const first = yield* askpassPath();
      assert.equal(yield* askpassPath(), first);

      yield* fs.remove(runtimeDirectoryOf(first), { recursive: true });
      const recreated = yield* askpassPath();
      assert.notEqual(recreated, first);
      assert.equal(yield* fs.exists(recreated), true);

      const cachedOwner = yield* fs.stat(runtimeDirectoryOf(recreated));
      const otherUser = yield* askpassPath().pipe(
        Effect.provideService(
          HostProcess.UserId,
          (Option.getOrUndefined(cachedOwner.uid) ?? 0) + 1,
        ),
      );
      assert.notEqual(otherUser, recreated);

      yield* fs.remove(runtimeDirectoryOf(recreated), { recursive: true });
      yield* fs.remove(runtimeDirectoryOf(otherUser), { recursive: true });
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(HostProcess.Platform, "linux"))),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "does not reuse a symlink left at the default askpass directory path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const askpassPath = () =>
          buildSshChildEnvironment({ interactiveAuth: true, authSecret: "pw" }).pipe(
            Effect.map((env) => env.SSH_ASKPASS ?? ""),
          );
        const runtimeDirectoryOf = (askpass: string) => path.dirname(path.dirname(askpass));

        const first = yield* askpassPath();
        const ownedTarget = yield* fs.makeTempDirectory({ prefix: "t3code-ssh-symlink-target-" });
        yield* fs.remove(runtimeDirectoryOf(first), { recursive: true });
        yield* fs.symlink(ownedTarget, runtimeDirectoryOf(first));

        const next = yield* askpassPath();
        assert.notEqual(next, first);
        assert.equal(yield* fs.exists(path.join(ownedTarget, "t3code-ssh-askpass")), false);

        yield* fs.remove(runtimeDirectoryOf(first));
        yield* fs.remove(ownedTarget, { recursive: true });
        yield* fs.remove(runtimeDirectoryOf(next), { recursive: true });
      }).pipe(
        Effect.provide(
          Layer.merge(NodeServices.layer, Layer.succeed(HostProcess.Platform, "linux")),
        ),
      ),
  );

  it.effect("writes the default askpass helper once when interactive commands overlap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeDirectories: Array<string> = [];
      yield* Effect.addFinalizer(() =>
        Effect.forEach(runtimeDirectories, (directory) =>
          fs.remove(directory, { recursive: true }).pipe(Effect.ignore),
        ),
      );

      // The first helper write of each round waits for the test, so the second command starts
      // while the first is still setting up and must not touch the shared files until it is done.
      let gate: { arrived: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
      let fileCalls = 0;
      let helperWrites = 0;
      const counted = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          fileCalls += 1;
          return effect;
        });
      const trackedFs: FileSystem.FileSystem = {
        ...fs,
        makeTempDirectory: (options) =>
          counted(fs.makeTempDirectory(options)).pipe(
            Effect.tap((directory) => Effect.sync(() => runtimeDirectories.push(directory))),
          ),
        stat: (path) => counted(fs.stat(path)),
        exists: (path) => counted(fs.exists(path)),
        writeFileString: (path, data, options) =>
          counted(
            Effect.gen(function* () {
              helperWrites += 1;
              const held = gate;
              gate = undefined;
              if (held) {
                yield* Deferred.succeed(held.arrived, undefined);
                yield* Deferred.await(held.release);
              }
              yield* fs.writeFileString(path, data, options);
            }),
          ),
      };
      const askpassPath = buildSshChildEnvironment({
        interactiveAuth: true,
        authSecret: "pw",
      }).pipe(
        Effect.map((env) => env.SSH_ASKPASS ?? ""),
        Effect.provideService(FileSystem.FileSystem, trackedFs),
      );
      const twoOverlappingCommands = Effect.gen(function* () {
        const held = {
          arrived: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        gate = held;
        const first = yield* Effect.forkChild(askpassPath);
        yield* Deferred.await(held.arrived);
        const callsBefore = fileCalls;
        const second = yield* askpassPath.pipe(Effect.forkChild({ startImmediately: true }));
        assert.equal(fileCalls, callsBefore, "second command touched the files mid-setup");
        yield* Deferred.succeed(held.release, undefined);
        return [yield* Fiber.join(first), yield* Fiber.join(second)] as const;
      });

      const [first, second] = yield* twoOverlappingCommands;
      assert.equal(second, first);
      assert.equal(runtimeDirectories.length, 1);
      assert.equal(helperWrites, 1);

      yield* fs.remove(first);
      assert.deepStrictEqual(yield* twoOverlappingCommands, [first, first]);
      assert.equal(runtimeDirectories.length, 1);
      assert.equal(helperWrites, 2);

      yield* fs.remove(first);
      const held = {
        arrived: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      gate = held;
      const cancelled = yield* Effect.forkChild(askpassPath);
      yield* Deferred.await(held.arrived);
      const callsBeforeCancellation = fileCalls;
      const interruption = yield* Fiber.interrupt(cancelled).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const next = yield* askpassPath.pipe(Effect.forkChild({ startImmediately: true }));
      const callsDuringCancellation = fileCalls;
      yield* Deferred.succeed(held.release, undefined);
      yield* Fiber.join(interruption);
      assert.equal(yield* Fiber.join(next), first);
      assert.equal(callsDuringCancellation, callsBeforeCancellation);
      assert.equal(helperWrites, 3);
      assert.include(yield* fs.readFileString(first), 'printf "%s\\n" "$T3_SSH_AUTH_SECRET"');
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(HostProcess.Platform, "linux"))),
    ),
  );
});
