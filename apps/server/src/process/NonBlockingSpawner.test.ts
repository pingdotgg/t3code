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
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as NonBlockingSpawner from "./NonBlockingSpawner.ts";

vi.mock("node:fs/promises", { spy: true });

const wrapped = NonBlockingSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

// A host without /usr/bin/env, such as a minimal container, spawns through /bin/sh.
const withoutEnv = NonBlockingSpawner.layer.pipe(
  Layer.provide(
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        return ChildProcessSpawner.make((command) =>
          command._tag === "StandardCommand" && command.command === "/usr/bin/env"
            ? Effect.fail(PlatformError.badArgument({ module: "Test", method: "spawn" }))
            : native.spawn(command),
        );
      }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const hostPath = process.env.PATH;

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

const trampolines = [
  ["env", wrapped],
  ["sh", withoutEnv],
] as const;

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("NonBlockingSpawner", () => {
  describe.each(trampolines)("through %s", (_trampoline, spawner) => {
    it.live("runs a command in the requested cwd", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const result = yield* run(ChildProcess.make("pwd", ["-P"], { cwd: directory }));
        expect(result).toBe(`${directory}\n`);
      }).pipe(Effect.scoped, Effect.provide(spawner)),
    );

    it.live("delivers argv with spaces, quotes, leading dashes and `=` intact", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const args = ["-n", "--", "a b", `it's "quoted"`, "$HOME", "; exit 3", "", "A=b"];
        const result = yield* run(
          ChildProcess.make("printf", ["%s\\n", ...args], { cwd: directory }),
        );
        expect(result).toBe(args.map((arg) => `${arg}\n`).join(""));
      }).pipe(Effect.scoped, Effect.provide(spawner)),
    );

    it.live("searches PATH the way the native spawner does", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const scripts = {
          stale: "#!/bin/sh\necho stale\n",
          fresh: "#!/bin/sh\necho fresh\n",
          "target/bin": "#!/bin/sh\necho target\n",
        };
        for (const [directory, body] of Object.entries(scripts)) {
          yield* fileSystem.makeDirectory(`${root}/${directory}`, { recursive: true });
          yield* fileSystem.writeFileString(`${root}/${directory}/tool`, body);
          yield* fileSystem.chmod(`${root}/${directory}/tool`, 0o755);
        }
        yield* fileSystem.chmod(`${root}/stale/tool`, 0o644);
        yield* fileSystem.makeDirectory(`${root}/target/subdir`);
        yield* fileSystem.symlink(`${root}/target/subdir`, `${root}/link`);
        for (const PATH of [`${root}/stale:${root}/fresh`, `${root}/link/../bin`]) {
          const command = ChildProcess.make("tool", [], { env: { PATH }, cwd: root });
          const native = yield* run(command).pipe(Effect.provide(NodeServices.layer));
          expect(yield* run(command).pipe(Effect.provide(spawner))).toBe(native);
        }
        // GNU env reads a lone `-` as -i even after `--`.
        yield* fileSystem.writeFileString(`${root}/fresh/-`, "#!/bin/sh\necho dash\n");
        yield* fileSystem.chmod(`${root}/fresh/-`, 0o755);
        const dash = ChildProcess.make("-", [], { env: { PATH: `${root}/fresh` }, cwd: root });
        expect(yield* run(dash).pipe(Effect.provide(spawner))).toBe("dash\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });

  it.live("runs a shell-mode command the way the native spawner does", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const command = ChildProcess.make('pwd -P; echo "$0" "a  b"', [], {
        cwd: directory,
        shell: true,
      });
      const native = yield* run(command).pipe(Effect.provide(NodeServices.layer));
      expect(native).toBe(`${directory}\n/bin/sh a  b\n`);
      expect(yield* run(command).pipe(Effect.provide(wrapped))).toBe(native);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // GNU env passes it through; dash would drop `BASH_FUNC_*%%` and add PWD and OLDPWD.
  it.live("hands the child exactly the environment it was given", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      // env cannot run a command containing `=`, so that one spawns natively.
      yield* fileSystem.symlink("/usr/bin/env", `${directory}/launch=stable`);
      for (const executable of ["env", `${directory}/launch=stable`]) {
        const command = ChildProcess.make(executable, [], {
          cwd: directory,
          env: { PATH: hostPath, A: "1", "BASH_FUNC_x%%": "() {  echo exported\n}" },
        });
        const native = yield* run(command).pipe(Effect.provide(NodeServices.layer));
        expect(yield* run(command).pipe(Effect.provide(wrapped))).toBe(native);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      // `missing/..` resolves to an existing directory, but the native check sees `missing`.
      for (const cwd of [`${directory}/missing`, `${directory}/missing/..`]) {
        const command = ChildProcess.make("true", [], { cwd });
        const native = yield* spawnError(command).pipe(Effect.provide(NodeServices.layer));
        const error = yield* spawnError(command).pipe(Effect.provide(wrapped));
        expect(error.reason._tag).toBe(native.reason._tag);
        expect(error.message).toBe(native.message);
      }
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
        (name) => spawnError(ChildProcess.make("true", [], { cwd: `/t3code-hung-30183/${name}` })),
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

  it.live("only ever hands the native spawner a trampoline, without a cwd", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const received: Array<ChildProcess.Command> = [];
      const recording = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const native = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) => {
            received.push(command);
            return native.spawn(command);
          });
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const piped = ChildProcess.make("printf", ["a"], { cwd: directory }).pipe(
        ChildProcess.pipeTo(ChildProcess.make("cat", [], { cwd: directory })),
      );
      for (const command of [
        ChildProcess.make("true", [], { cwd: directory }),
        ChildProcess.make("true", []),
        ChildProcess.make("/bin/true", []),
        ChildProcess.make("t3code-missing-command-30183", []),
        ChildProcess.make("true", [], { cwd: directory, shell: true }),
        piped,
      ]) {
        yield* Effect.exit(
          ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.exitCode(command)).pipe(
            Effect.provide(NonBlockingSpawner.layer.pipe(Layer.provide(recording))),
          ),
        );
      }

      const legs = received.flatMap(standardCommands);
      expect(legs.length).toBeGreaterThanOrEqual(6);
      for (const leg of legs) {
        expect(["/usr/bin/env", "/bin/sh"]).toContain(leg.command);
        expect(leg.options.cwd).toBeUndefined();
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
