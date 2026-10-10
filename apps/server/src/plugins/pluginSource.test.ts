import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { digestPluginSource } from "./pluginSource.ts";

const makeTree = Effect.fn("makeTree")(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-source-" });
  for (const [name, content] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(directory, name)), { recursive: true });
    yield* fs.writeFileString(path.join(directory, name), content);
  }
  return directory;
});

it.layer(NodeServices.layer)("digestPluginSource", (it) => {
  describe("exact bytes", () => {
    it.effect("changes with any content, addition, or rename", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* makeTree({ "main.mjs": "export {}", "lib/util.js": "1" });
        const first = yield* digestPluginSource(directory);
        expect(first).toMatchObject({ files: 2, bytes: 10 });
        expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect((yield* digestPluginSource(directory)).digest).toBe(first.digest);

        // Same bytes and the same length, one character different.
        yield* fs.writeFileString(path.join(directory, "lib/util.js"), "2");
        const edited = yield* digestPluginSource(directory);
        expect(edited.digest).not.toBe(first.digest);

        yield* fs.rename(path.join(directory, "lib/util.js"), path.join(directory, "lib/other.js"));
        const renamed = yield* digestPluginSource(directory);
        expect(renamed.digest).not.toBe(edited.digest);

        yield* fs.writeFileString(path.join(directory, "extra.txt"), "");
        expect((yield* digestPluginSource(directory)).digest).not.toBe(renamed.digest);
      }),
    );

    it.effect("covers hidden paths, which an entry or import may use", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* makeTree({ ".git/main.mjs": "export {}", ".DS_Store": "x" });
        const first = yield* digestPluginSource(directory);
        expect(first).toMatchObject({ files: 2, bytes: 10 });
        yield* fs.writeFileString(path.join(directory, ".git/main.mjs"), "export { }");
        expect((yield* digestPluginSource(directory)).digest).not.toBe(first.digest);
      }),
    );

    it.effect("refuses symbolic links instead of following or skipping them", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* makeTree({ "secret.js": "outside" });
        const directory = yield* makeTree({ "main.mjs": "export {}" });
        yield* fs.symlink(path.join(outside, "secret.js"), path.join(directory, "linked.js"));
        const error = yield* digestPluginSource(directory).pipe(Effect.flip);
        expect(error.reason).toBe("linked.js is a symbolic link.");

        yield* fs.remove(path.join(directory, "linked.js"));
        yield* fs.symlink(outside, path.join(directory, "vendor"));
        const linkedDirectory = yield* digestPluginSource(directory).pipe(Effect.flip);
        expect(linkedDirectory.reason).toBe("vendor is a symbolic link.");

        // Names that tools own are not exempt either.
        yield* fs.remove(path.join(directory, "vendor"));
        yield* fs.symlink(outside, path.join(directory, ".git"));
        const linkedGit = yield* digestPluginSource(directory).pipe(Effect.flip);
        expect(linkedGit.reason).toBe(".git is a symbolic link.");
      }),
    );

    it.effect("refuses trees past the file or byte limit", () =>
      Effect.gen(function* () {
        const directory = yield* makeTree({ "a.js": "12345", "b.js": "67890" });
        const tooMany = yield* digestPluginSource(directory, { maxFiles: 1, maxBytes: 100 }).pipe(
          Effect.flip,
        );
        expect(tooMany.reason).toBe("it has more than 1 files.");
        const tooLarge = yield* digestPluginSource(directory, { maxFiles: 10, maxBytes: 9 }).pipe(
          Effect.flip,
        );
        expect(tooLarge.reason).toBe("it is larger than 9 bytes.");
        expect(yield* digestPluginSource(directory, { maxFiles: 2, maxBytes: 10 })).toMatchObject({
          files: 2,
          bytes: 10,
        });
      }),
    );
  });
});
