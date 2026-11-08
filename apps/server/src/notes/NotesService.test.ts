import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import * as NotesService from "./NotesService.ts";

const layerTest = NotesService.layer.pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

const makeVault = Effect.fn("makeVault")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-notes-" });
  const vault = path.join(root, "vault");
  const write = (relativePath: string, content: string) =>
    fileSystem
      .makeDirectory(path.dirname(path.join(vault, relativePath)), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(path.join(vault, relativePath), content)));
  yield* write("Daily/Groceries.md", "milk and eggs");
  yield* write("Ideas.md", "Build a rocket powered by Coffee beans");
  yield* write(".obsidian/workspace.md", "hidden");
  yield* write("Projects/.trash/Old.md", "hidden");
  yield* write("image.png", "not markdown");
  yield* fileSystem.writeFileString(path.join(root, "secret.md"), "outside");
  yield* settings.updateSettings({ notesVaultPath: vault });
  return { root, vault };
});

it.layer(layerTest)("NotesService", (it) => {
  describe("list", () => {
    it.effect("lists Markdown notes and skips dot-directories", () =>
      Effect.gen(function* () {
        const notes = yield* NotesService.NotesService;
        yield* makeVault();

        const result = yield* notes.list({});

        expect(result.notes.map((note) => note.path).toSorted()).toEqual([
          "Daily/Groceries.md",
          "Ideas.md",
        ]);
        expect(result.notes.find((note) => note.path === "Ideas.md")?.title).toBe("Ideas");
      }),
    );

    it.effect("matches titles and contents case-insensitively", () =>
      Effect.gen(function* () {
        const notes = yield* NotesService.NotesService;
        yield* makeVault();

        const byTitle = yield* notes.list({ query: "grocer" });
        expect(byTitle.notes.map((note) => note.path)).toEqual(["Daily/Groceries.md"]);
        expect(byTitle.notes[0]?.snippet).toBeUndefined();

        const byContent = yield* notes.list({ query: "coffee" });
        expect(byContent.notes.map((note) => note.path)).toEqual(["Ideas.md"]);
        expect(byContent.notes[0]?.snippet).toContain("Coffee beans");
      }),
    );

    it.effect("fails with unconfigured when no vault is set", () =>
      Effect.gen(function* () {
        const notes = yield* NotesService.NotesService;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ notesVaultPath: "" });

        const error = yield* notes.list({}).pipe(Effect.flip);

        expect(error.reason).toBe("unconfigured");
      }),
    );
  });

  describe("read", () => {
    it.effect("reads a note inside the vault", () =>
      Effect.gen(function* () {
        const notes = yield* NotesService.NotesService;
        yield* makeVault();

        const note = yield* notes.read({ path: "Daily/Groceries.md" });

        expect(note).toMatchObject({
          path: "Daily/Groceries.md",
          title: "Groceries",
          content: "milk and eggs",
        });
      }),
    );

    it.effect("rejects traversal, symlink escapes, and non-Markdown files", () =>
      Effect.gen(function* () {
        const notes = yield* NotesService.NotesService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, vault } = yield* makeVault();
        yield* fileSystem.symlink(path.join(root, "secret.md"), path.join(vault, "Link.md"));
        yield* fileSystem.symlink(path.join(vault, "image.png"), path.join(vault, "Image.md"));

        const reasons = yield* Effect.forEach(
          ["../secret.md", path.join(root, "secret.md"), "Link.md", "image.png", "Image.md"],
          (notePath) =>
            notes.read({ path: notePath }).pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            ),
        );

        expect(reasons).toEqual([
          "outside-vault",
          "outside-vault",
          "outside-vault",
          "not-markdown",
          "not-markdown",
        ]);
      }),
    );
  });
});
