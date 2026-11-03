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

  it.live("fails a missing or non-executable explicit path like the native spawner", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${directory}/plain`, "#!/bin/sh\n");
      for (const executable of [`${directory}/missing`, `${directory}/plain`, "./missing"]) {
        for (const options of [{}, { cwd: directory }]) {
          const command = ChildProcess.make(executable, [], options);
          const native = yield* spawnError(command).pipe(Effect.provide(NodeServices.layer));
          const error = yield* spawnError(command).pipe(Effect.provide(wrapped));
          expect(error.reason._tag).toBe(native.reason._tag);
          expect(error.message).toBe(native.message);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("searches PATH the way the native spawner does", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const scripts = {
        stale: "#!/t3code-missing-interpreter\n",
        fresh: "#!/bin/sh\necho fresh\n",
        "target/bin": "#!/bin/sh\necho target\n",
      };
      for (const [directory, body] of Object.entries(scripts)) {
        yield* fileSystem.makeDirectory(`${root}/${directory}`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/${directory}/tool`, body);
        yield* fileSystem.chmod(`${root}/${directory}/tool`, 0o755);
      }
      yield* fileSystem.makeDirectory(`${root}/target/subdir`);
      yield* fileSystem.symlink(`${root}/target/subdir`, `${root}/link`);
      for (const PATH of [`${root}/stale:${root}/fresh`, `${root}/link/../bin`]) {
        const command = ChildProcess.make("tool", [], { env: { PATH }, cwd: root });
        const native = yield* run(command).pipe(Effect.provide(NodeServices.layer));
        expect(yield* run(command).pipe(Effect.provide(wrapped))).toBe(native);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("only ever hands the native spawner /bin/sh, without a cwd", () =>
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
      for (const command of [
        ChildProcess.make("git", ["status"], { cwd: directory }),
        ChildProcess.make("git", ["status"]),
        ChildProcess.make("/bin/true", []),
        piped,
      ]) {
        yield* spawnError(command).pipe(
          Effect.provide(NonBlockingSpawner.layer.pipe(Layer.provide(recording))),
        );
      }

      const legs = received.flatMap(standardCommands);
      expect(legs).toHaveLength(5);
      for (const leg of legs) {
        expect(leg.command).toBe("/bin/sh");
        expect(leg.options.cwd).toBeUndefined();
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
