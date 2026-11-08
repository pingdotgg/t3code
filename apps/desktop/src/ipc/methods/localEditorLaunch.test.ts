import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { launchLocalEditor } from "./localEditorLaunch.ts";

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: unknown;
  readonly detached: unknown;
}

const makeSpawner = (records: SpawnRecord[], failure?: unknown) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected command");
      records.push({
        command: command.command,
        args: command.args.map(String),
        shell: command.options.shell,
        detached: command.options.detached,
      });
      if (failure !== undefined) return Effect.fail(failure as never);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const withEditorOnPath = <A, E, R>(
  body: (input: { readonly directory: string; readonly editor: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-editor-" });
    const bin = path.join(directory, "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    const editor = path.join(bin, "code");
    yield* fs.writeFileString(editor, "#!/bin/sh\n");
    yield* fs.chmod(editor, 0o755);
    return yield* body({ directory, editor }).pipe(
      Effect.provideService(HostProcess.Environment, { PATH: bin, HOME: directory }),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
  });

describe("launchLocalEditor", () => {
  it.effect("rejects missing and relative client paths before launching an editor", () => {
    const records: SpawnRecord[] = [];
    return Effect.gen(function* () {
      assert.deepEqual(yield* launchLocalEditor({ editor: "vscode", path: "relative/project" }), {
        ok: false,
        reason: "invalid-path",
      });
      assert.deepEqual(
        yield* launchLocalEditor({
          editor: "vscode",
          path: "/nonexistent-t3-editor-regression/project",
        }),
        { ok: false, reason: "path-missing" },
      );
      assert.deepEqual(yield* launchLocalEditor({ editor: "file-manager", path: "/" }), {
        ok: false,
        reason: "unsupported-editor",
      });
      assert.deepEqual(records, []);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, makeSpawner(records))));
  });

  it.effect("spawns the editor argv without a shell for an existing absolute path", () => {
    const records: SpawnRecord[] = [];
    return withEditorOnPath(({ directory }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = path.join(directory, "--weird; $(touch pwned) project");
        yield* fs.makeDirectory(project);
        assert.deepEqual(yield* launchLocalEditor({ editor: "vscode", path: project }), {
          ok: true,
        });
        assert.deepEqual(records, [
          { command: "code", args: [project], shell: false, detached: true },
        ]);
      }),
    ).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, makeSpawner(records))));
  });

  it.effect("passes line and column through the editor's launch style", () => {
    const records: SpawnRecord[] = [];
    return withEditorOnPath(({ directory }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(directory, "main.ts");
        yield* fs.writeFileString(file, "");
        yield* launchLocalEditor({ editor: "vscode", path: `${file}:12:3` });
        assert.deepEqual(
          records.map(({ args }) => args),
          [["--goto", `${file}:12:3`]],
        );
        // A real file whose name ends in :12 is opened as-is.
        const literal = path.join(directory, "notes:12");
        yield* fs.writeFileString(literal, "");
        records.length = 0;
        yield* launchLocalEditor({ editor: "vscode", path: literal });
        assert.deepEqual(records[0]?.args, [literal]);
        // A position on a path that does not exist is still a missing path.
        assert.deepEqual(
          yield* launchLocalEditor({ editor: "vscode", path: `${directory}/gone.ts:4` }),
          { ok: false, reason: "path-missing" },
        );
      }),
    ).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, makeSpawner(records))));
  });

  it.effect("reports an unavailable editor and a failed spawn without any fallback", () => {
    const records: SpawnRecord[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-editor-empty-" });
      const missing = yield* launchLocalEditor({ editor: "vscode", path: empty }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: empty, HOME: empty }),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      assert.deepEqual(missing, { ok: false, reason: "editor-unavailable" });
      assert.deepEqual(records, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, makeSpawner(records))),
    );
  });

  it.effect("fails closed when the spawn itself fails", () => {
    const records: SpawnRecord[] = [];
    return withEditorOnPath(({ directory }) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* launchLocalEditor({ editor: "vscode", path: directory }), {
          ok: false,
          reason: "spawn-failed",
        });
        assert.lengthOf(records, 1);
      }),
    ).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, makeSpawner(records, new Error("boom")))),
    );
  });
});
