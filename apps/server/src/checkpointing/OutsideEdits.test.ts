import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { collectOutsideEdits } from "./OutsideEdits.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
);

it.effect("lists edits in repos no checkpoint covers and ignores plain folders", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const parent = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-outside-edits-" }),
    );
    const folder = (...segments: ReadonlyArray<string>) => path.join(parent, ...segments);
    for (const repository of ["home", "home/nested", "sibling", "tracked", "covered"]) {
      yield* fileSystem.makeDirectory(folder(repository), { recursive: true });
      yield* vcsProcess.run({
        operation: "OutsideEdits.test.init",
        command: "git",
        cwd: folder(repository),
        args: ["init", "--quiet"],
      });
    }
    yield* fileSystem.makeDirectory(folder("plain"));

    const manyFiles = Array.from(
      { length: 21 },
      (_, index) => `many/f${String(index).padStart(2, "0")}.ts`,
    );
    const edits = yield* collectOutsideEdits({
      paths: [
        "src/inside-home.ts",
        folder("home", "README.md"),
        folder("home", "nested", "n.ts"),
        folder("sibling", "a.ts"),
        // Deleted since: resolves through the nearest folder that still exists.
        folder("sibling", "gone", "dir", "x.ts"),
        ...manyFiles.map((file) => folder("sibling", file)),
        folder("tracked", "t.ts"),
        folder("covered", "c.ts"),
        folder("plain", "notes.txt"),
        "Write result",
      ],
      cwd: folder("home"),
      homeCwd: folder("home"),
      coveredCwds: [folder("home"), folder("covered")],
      projectFolderPaths: Effect.succeed([folder("tracked"), folder("covered")]),
    });

    assert.deepEqual(edits, [
      {
        root: folder("home", "nested"),
        name: "nested",
        tracked: false,
        files: ["n.ts"],
        fileCount: 1,
      },
      {
        root: folder("sibling"),
        name: "sibling",
        tracked: false,
        files: ["a.ts", "gone/dir/x.ts", ...manyFiles.slice(0, 18)],
        fileCount: 23,
      },
      { root: folder("tracked"), name: "tracked", tracked: true, files: ["t.ts"], fileCount: 1 },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("keeps a plain home folder's own edits out", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-outside-edits-plain-" }),
    );
    const edits = yield* collectOutsideEdits({
      paths: [path.join(home, "notes.md"), "draft.md"],
      cwd: home,
      homeCwd: home,
      coveredCwds: [],
      projectFolderPaths: Effect.die("not read when nothing is outside"),
    });
    assert.deepEqual(edits, []);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
