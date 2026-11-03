import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as NonBlockingSpawner from "./NonBlockingSpawner.ts";

const wrapped = NonBlockingSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const run = (command: ChildProcess.Command) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(command));

const standardCommands = (command: ChildProcess.Command): Array<ChildProcess.StandardCommand> =>
  command._tag === "StandardCommand"
    ? [command]
    : [...standardCommands(command.left), ...standardCommands(command.right)];

const spawnError = (command: ChildProcess.Command) =>
  Effect.scoped(
    ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.spawn(command)),
  ).pipe(Effect.flip);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("NonBlockingSpawner", () => {
  it.live("runs a command in the requested cwd", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const result = yield* run(ChildProcess.make("pwd", ["-P"], { cwd: directory }));
      expect(result).toBe(`${directory}\n`);
    }).pipe(Effect.scoped, Effect.provide(wrapped)),
  );

  it.live("delivers argv with spaces, quotes and leading dashes intact", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const args = ["-n", "--", "a b", `it's "quoted"`, "$HOME", "; exit 3", ""];
      const result = yield* run(
        ChildProcess.make("printf", ["%s\\n", ...args], { cwd: directory }),
      );
      expect(result).toBe(args.map((arg) => `${arg}\n`).join(""));
    }).pipe(Effect.scoped, Effect.provide(wrapped)),
  );

  it.live("fails a missing command with NotFound, with or without cwd", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      for (const options of [{}, { cwd: directory }]) {
        const error = yield* spawnError(
          ChildProcess.make("t3code-missing-command-30183", ["--version"], options),
        );
        expect(error).toBeInstanceOf(PlatformError.PlatformError);
        expect(error.reason._tag).toBe("NotFound");
        expect(error.reason).toMatchObject({ module: "ChildProcess", method: "spawn" });
      }
    }).pipe(Effect.scoped, Effect.provide(wrapped)),
  );

  it.live("fails a missing cwd the way the native spawner does", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const missing = `${yield* fileSystem.makeTempDirectoryScoped()}/missing`;
      const command = ChildProcess.make("true", [], { cwd: missing });
      const native = yield* spawnError(command).pipe(Effect.provide(NodeServices.layer));
      const error = yield* spawnError(command).pipe(Effect.provide(wrapped));
      expect(error.reason._tag).toBe("NotFound");
      expect(error.message).toBe(native.message);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never hands the native spawner a cwd or a bare command name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const received: Array<ChildProcess.Command> = [];
      const recording = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          received.push(command);
          return Effect.fail(PlatformError.badArgument({ module: "Test", method: "spawn" }));
        }),
      );
      const piped = ChildProcess.make("true", [], { cwd: directory }).pipe(
        ChildProcess.pipeTo(ChildProcess.make("cat", [], { cwd: directory })),
      );
      for (const command of [ChildProcess.make("git", ["status"], { cwd: directory }), piped]) {
        yield* spawnError(command).pipe(
          Effect.provide(NonBlockingSpawner.layer.pipe(Layer.provide(recording))),
        );
      }

      const legs = received.flatMap(standardCommands);
      expect(legs).toHaveLength(3);
      for (const leg of legs) {
        expect(leg.options.cwd).toBeUndefined();
        expect(leg.command).toBe("/bin/sh");
        expect(leg.args[2]).toMatch(/^[^/]+$/);
        expect(leg.args[3]).toBe(directory);
        expect(leg.args[4]).toMatch(/^\//);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
