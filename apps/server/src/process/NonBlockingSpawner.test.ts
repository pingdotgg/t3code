// @effect-diagnostics nodeBuiltinImport:off - the spawner's checks are node:fs/promises calls, which the test spies on.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as NonBlockingSpawner from "./NonBlockingSpawner.ts";

vi.mock("node:fs/promises", { spy: true });

const hostPath = process.env.PATH;

const wrapped = NonBlockingSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** What a caller sees of a command: its output, or the error of a spawn that failed. */
const outcome = (command: ChildProcess.Command) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(command)).pipe(
    Effect.match({
      onSuccess: (output) => ({ output }),
      onFailure: (error) => ({ reason: error.reason._tag, message: error.message }),
    }),
  );

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("NonBlockingSpawner", () => {
  it.live("gives callers what the native spawner gives them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      for (const [file, mode] of [
        ["stale/tool", 0o644],
        ["fresh/tool", 0o755],
        ["target/bin/tool", 0o755],
        // GNU env reads a lone `-` as -i and `NAME=value` as an assignment, even after `--`.
        ["fresh/-", 0o755],
        ["fresh/launch=stable", 0o755],
      ] as const) {
        yield* fileSystem.makeDirectory(`${root}/${file.slice(0, file.lastIndexOf("/"))}`, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(`${root}/${file}`, `#!/bin/sh\necho ${file} "$@"\n`);
        yield* fileSystem.chmod(`${root}/${file}`, mode);
      }
      yield* fileSystem.makeDirectory(`${root}/target/subdir`);
      yield* fileSystem.symlink(`${root}/target/subdir`, `${root}/link`);
      const PATH = `${root}/stale:${root}/fresh`;

      const commands = {
        "enters the cwd": ChildProcess.make("pwd", ["-P"], { cwd: root }),
        "keeps argv": ChildProcess.make(
          "printf",
          ["%s\\n", "-n", "--", "a b", `it's "quoted"`, "$HOME", "; exit 3", "", "A=b"],
          { cwd: root },
        ),
        // dash would drop the exported function and add PWD and OLDPWD.
        "keeps the environment": ChildProcess.make("env", [], {
          cwd: root,
          env: { PATH: hostPath, A: "1", "BASH_FUNC_x%%": "() {  echo exported\n}" },
        }),
        "skips a non-executable PATH entry": ChildProcess.make("tool", [], { env: { PATH } }),
        "resolves `..` in PATH after a symlink": ChildProcess.make("tool", [], {
          env: { PATH: `${root}/link/../bin` },
        }),
        "searches PATH relative to the cwd": ChildProcess.make("tool", [], {
          cwd: root,
          env: { PATH: "fresh" },
        }),
        "a command named -": ChildProcess.make("-", [], { cwd: root, env: { PATH } }),
        "a command containing =": ChildProcess.make("launch=stable", [], { env: { PATH } }),
        "shell mode": ChildProcess.make('pwd -P; echo "$0" "a  b"', [], { cwd: root, shell: true }),
        "a pipeline": ChildProcess.make("printf", ["a\\nb\\n"], { cwd: root }).pipe(
          ChildProcess.pipeTo(ChildProcess.make("tail", ["-n", "1"])),
        ),
        "a missing command": ChildProcess.make("t3code-missing-command", ["--version"]),
        "a missing command in a cwd": ChildProcess.make("t3code-missing-command", [], {
          cwd: root,
        }),
        "a non-executable command": ChildProcess.make("tool", [], {
          env: { PATH: `${root}/stale` },
        }),
        "a missing explicit path": ChildProcess.make("./missing", [], { cwd: root }),
        "a non-executable explicit path": ChildProcess.make(`${root}/stale/tool`, []),
        "a missing cwd": ChildProcess.make("true", [], { cwd: `${root}/missing` }),
        // The native check sees `missing`, although the path resolves to an existing directory.
        "a cwd through a missing directory": ChildProcess.make("true", [], {
          cwd: `${root}/missing/..`,
        }),
      };
      for (const [name, command] of Object.entries(commands)) {
        const native = yield* outcome(command).pipe(Effect.provide(NodeServices.layer));
        expect(yield* outcome(command).pipe(Effect.provide(wrapped)), name).toEqual(native);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("hands the native spawner only `env`, never a cwd or a command to look up", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const received: Array<ChildProcess.StandardCommand> = [];
      const record = (command: ChildProcess.Command): void => {
        if (command._tag === "StandardCommand") received.push(command);
        else [command.left, command.right].forEach(record);
      };
      const recording = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (native) =>
          ChildProcessSpawner.make((command) => {
            record(command);
            return native.spawn(command);
          }),
        ),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      const commands = [
        ChildProcess.make("true", [], { cwd: directory }),
        ChildProcess.make("true", []),
        ChildProcess.make("/bin/true", []),
        ChildProcess.make("t3code-missing-command", []),
        ChildProcess.make("true", [], { cwd: directory, shell: true }),
        ChildProcess.make("printf", ["a"], { cwd: directory }).pipe(
          ChildProcess.pipeTo(ChildProcess.make("cat", [], { cwd: directory })),
        ),
      ];
      yield* Effect.forEach(commands, (command) =>
        ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.exitCode(command)).pipe(
          Effect.exit,
        ),
      ).pipe(Effect.provide(NonBlockingSpawner.layer.pipe(Layer.provide(recording))));

      expect(received.map((command) => [command.command, command.options.cwd])).toEqual(
        Array.from({ length: 6 }, () => ["/usr/bin/env", undefined]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("checks at most two paths at once, however many directories hang", () =>
    Effect.gen(function* () {
      const allArrived = yield* Deferred.make<void>();
      let arrivals = 0;
      // Each spawn resolves its cwd, then starts its check within microtasks.
      const arrivalPath = Layer.effect(
        Path.Path,
        Effect.map(Path.Path, (path) => ({
          ...path,
          resolve: (...segments: ReadonlyArray<string>) => {
            if (++arrivals === 3) setImmediate(() => Deferred.doneUnsafe(allArrived, Effect.void));
            return path.resolve(...segments);
          },
        })),
      );
      const hung: Array<() => void> = [];
      let releasing = false;
      let running = 0;
      let mostRunning = 0;
      using _access = vi.spyOn(NodeFSP, "access").mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            mostRunning = Math.max(mostRunning, ++running);
            const fail = () => {
              running--;
              reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
            };
            if (releasing) fail();
            else hung.push(fail);
          }),
      );
      const spawns = yield* Effect.forEach(
        ["a", "b", "c"],
        (name) =>
          ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
            spawner.exitCode(ChildProcess.make("true", [], { cwd: `/t3code-hung/${name}` })),
          ).pipe(Effect.flip),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.provide(
          NonBlockingSpawner.layer.pipe(
            Layer.provide(arrivalPath),
            Layer.provide(NodeServices.layer),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(allArrived);
      expect(mostRunning).toBe(2);
      releasing = true;
      for (const fail of hung.splice(0)) fail();
      yield* Fiber.join(spawns);
      expect(mostRunning).toBe(2);
    }),
  );
});
