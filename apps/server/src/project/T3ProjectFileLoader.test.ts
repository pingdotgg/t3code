import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (cwd: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, "t3.json"), contents).pipe(Effect.orDie);
});

const removeProjectFile = Effect.fn("removeProjectFile")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.remove(path.join(cwd, "t3.json")).pipe(Effect.orDie);
});

it.layer(TestLayer)("T3ProjectFileLoader", (it) => {
  describe("load", () => {
    it.effect("loads and decodes a valid t3.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("returns none when t3.json is missing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("reads updated prompts on the next load and resets when the file is removed", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          '{ "textGeneration": { "prompts": { "threadTitle": "First rule", "threadTitleRegeneration": "Regeneration rule" } } }',
        );

        const first = yield* loader.load(cwd);
        expect(Option.getOrUndefined(first)?.textGeneration?.prompts?.threadTitle).toBe(
          "First rule",
        );

        yield* writeProjectFile(
          cwd,
          '{ "textGeneration": { "prompts": { "threadTitle": "Second rule" } } }',
        );
        const second = yield* loader.load(cwd);
        expect(Option.getOrUndefined(second)?.textGeneration?.prompts?.threadTitle).toBe(
          "Second rule",
        );
        expect(
          Option.getOrUndefined(second)?.textGeneration?.prompts?.threadTitleRegeneration,
        ).toBeUndefined();

        yield* removeProjectFile(cwd);
        expect(Option.isNone(yield* loader.load(cwd))).toBe(true);
      }),
    );

    it.effect("reads only the requested workspace root", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const nestedCheckout = path.join(cwd, "worktree");
        yield* fileSystem.makeDirectory(nestedCheckout);
        yield* writeProjectFile(
          cwd,
          '{ "textGeneration": { "prompts": { "branchName": "Use parent rule" } } }',
        );

        expect(Option.isSome(yield* loader.load(cwd))).toBe(true);
        expect(Option.isNone(yield* loader.load(nestedCheckout))).toBe(true);
      }),
    );
  });
});
