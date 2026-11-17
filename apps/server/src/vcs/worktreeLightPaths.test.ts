// @effect-diagnostics nodeBuiltinImport:off - the stand-in cloner copies with node:fs.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as CheckoutCloner from "./CheckoutCloner.ts";
import { prepareWorktreeLightPaths } from "./worktreeLightPaths.ts";

const copyCloner = (source: string, destination: string) =>
  Effect.try({
    try: () => NodeFS.cpSync(source, destination, { recursive: true, errorOnExist: true }),
    catch: (cause) => new CheckoutCloner.CheckoutCloneError({ source, destination, cause }),
  });

const failingCloner = (source: string, destination: string) =>
  Effect.fail(new CheckoutCloner.CheckoutCloneError({ source, destination }));

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-light-paths-" });
  const at = (...parts: string[]) => path.join(root, ...parts);
  const write = (file: string, contents: string) =>
    fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, contents)));
  yield* write(at("source", "node_modules", "pkg", "index.js"), "source");
  yield* write(at("source", ".zig-cache", "o", "artifact"), "built");
  yield* write(at("worktree", "kept", "file"), "checked out");
  yield* write(at("source", "kept", "file"), "source");
  const prepare = (worktree: string, ignored: boolean) =>
    prepareWorktreeLightPaths({
      sourcePath: at("source"),
      worktreePath: at(worktree),
      sharedRoot: at("shared"),
      excludeFile: at("git", "info", "exclude"),
      sharedPaths: [".zig-cache"],
      clonePaths: ["node_modules", "kept", "missing"],
      isIgnored: () => Effect.succeed(ignored),
    });
  const read = (file: string) => fileSystem.readFileString(file);
  return { at, prepare, read, fileSystem };
});

it.layer(NodeServices.layer)("prepareWorktreeLightPaths", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "clones listed folders and seeds the shared folder once from the source",
    () =>
      Effect.gen(function* () {
        const { at, prepare, read, fileSystem } = yield* setup;
        yield* prepare("worktree", false);
        yield* fileSystem.writeFileString(at("source", ".zig-cache", "o", "artifact"), "rebuilt");
        yield* fileSystem.makeDirectory(at("second"));
        yield* prepare("second", false);

        assert.equal(yield* read(at("worktree", "node_modules", "pkg", "index.js")), "source");
        assert.equal(yield* read(at("worktree", "kept", "file")), "checked out");
        assert.isFalse(yield* fileSystem.exists(at("worktree", "missing")));
        assert.equal(
          yield* fileSystem.readLink(at("second", ".zig-cache")),
          at("shared", ".zig-cache"),
        );
        assert.equal(yield* read(at("second", ".zig-cache", "o", "artifact")), "built");
        assert.equal(yield* read(at("git", "info", "exclude")), "/.zig-cache\n");
      }).pipe(Effect.provideService(CheckoutCloner.CheckoutCloner, copyCloner)),
  );

  it.effect.skipIf(!symlinksSupported)("still links the shared folder when cloning fails", () =>
    Effect.gen(function* () {
      const { at, prepare, fileSystem } = yield* setup;
      yield* prepare("worktree", true);

      assert.isFalse(yield* fileSystem.exists(at("worktree", "node_modules")));
      assert.equal(
        yield* fileSystem.readLink(at("worktree", ".zig-cache")),
        at("shared", ".zig-cache"),
      );
      assert.deepEqual(yield* fileSystem.readDirectory(at("shared")), [".zig-cache"]);
      assert.isFalse(yield* fileSystem.exists(at("git", "info", "exclude")));
    }).pipe(Effect.provideService(CheckoutCloner.CheckoutCloner, failingCloner)),
  );
});
