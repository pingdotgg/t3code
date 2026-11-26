import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverSkills,
  linkSkill,
  listLibrarySkills,
  moveSkillToLibrary,
  unlinkSkill,
} from "./skills.ts";

const skillFile = (description?: string) =>
  description === undefined
    ? "---\nname: x\n---\nBody\n"
    : `---\ndescription: ${description}\n---\n`;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const libraryDir = path.join(root, "library");
  const skillsDir = path.join(root, "claude", "skills");
  const writeSkill = (directory: string, description?: string) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.andThen(
          fs.writeFileString(path.join(directory, "SKILL.md"), skillFile(description)),
        ),
      );
  yield* writeSkill(path.join(libraryDir, "shared"), "Shared skill");
  yield* writeSkill(path.join(libraryDir, "unlinked"), "Not linked yet");
  yield* writeSkill(path.join(skillsDir, "mine"), "My own skill");
  yield* writeSkill(path.join(skillsDir, "undescribed"));
  yield* writeSkill(path.join(root, "elsewhere", "outside"), "Outside");
  yield* fs.symlink(path.join(libraryDir, "shared"), path.join(skillsDir, "shared"));
  yield* fs.symlink(path.join(root, "elsewhere", "outside"), path.join(skillsDir, "outside"));
  yield* fs.makeDirectory(path.join(skillsDir, ".system"));
  yield* fs.makeDirectory(path.join(skillsDir, "synced", "nested"), { recursive: true });
  return { fs, path, root, libraryDir, skillsDir };
});

it.layer(NodeServices.layer)("extension skills", (it) => {
  describe("discoverSkills", () => {
    it.effect("tells library links from local skills and flags a missing description", () =>
      Effect.gen(function* () {
        const { libraryDir, skillsDir, path } = yield* fixture;
        const skills = yield* discoverSkills({
          skillsDir,
          libraryDir,
          displayPath: (absolute) => path.relative(skillsDir, absolute),
        });
        expect(
          skills.map((skill) => [skill.name, skill.source, skill.health, skill.detail, skill.path]),
        ).toEqual([
          ["mine", "local", "ok", null, "mine"],
          ["outside", "local", "ok", null, "outside"],
          ["shared", "library", "ok", null, "shared"],
          ["undescribed", "local", "failing", "SKILL.md has no description", "undescribed"],
        ]);
        expect(yield* listLibrarySkills(libraryDir)).toEqual([
          { name: "shared", description: "Shared skill" },
          { name: "unlinked", description: "Not linked yet" },
        ]);
      }),
    );

    it.effect("treats a missing skills directory as empty", () =>
      Effect.gen(function* () {
        const { root, libraryDir, path } = yield* fixture;
        expect(
          yield* discoverSkills({
            skillsDir: path.join(root, "nowhere"),
            libraryDir,
            displayPath: (absolute) => absolute,
          }),
        ).toEqual([]);
      }),
    );
  });

  describe("skill changes", () => {
    it.effect("links a library skill and refuses names already taken", () =>
      Effect.gen(function* () {
        const { fs, path, libraryDir, skillsDir } = yield* fixture;
        expect(yield* linkSkill({ skillsDir, libraryDir, name: "unlinked" })).toEqual({
          ok: true,
          message: null,
        });
        expect(yield* fs.readLink(path.join(skillsDir, "unlinked"))).toBe(
          path.join(libraryDir, "unlinked"),
        );
        expect((yield* linkSkill({ skillsDir, libraryDir, name: "shared" })).ok).toBe(true);
        expect((yield* linkSkill({ skillsDir, libraryDir, name: "missing" })).ok).toBe(false);
        yield* fs.makeDirectory(path.join(libraryDir, "mine"));
        yield* fs.writeFileString(path.join(libraryDir, "mine", "SKILL.md"), skillFile("Clash"));
        expect((yield* linkSkill({ skillsDir, libraryDir, name: "mine" })).ok).toBe(false);
        expect(yield* fs.exists(path.join(skillsDir, "mine", "SKILL.md"))).toBe(true);
      }),
    );

    it.effect("unlinks only links into the library", () =>
      Effect.gen(function* () {
        const { fs, path, libraryDir, skillsDir } = yield* fixture;
        expect((yield* unlinkSkill({ skillsDir, libraryDir, name: "mine" })).ok).toBe(false);
        expect((yield* unlinkSkill({ skillsDir, libraryDir, name: "outside" })).ok).toBe(false);
        expect(yield* fs.exists(path.join(skillsDir, "mine"))).toBe(true);
        expect(yield* fs.exists(path.join(skillsDir, "outside"))).toBe(true);

        expect((yield* unlinkSkill({ skillsDir, libraryDir, name: "shared" })).ok).toBe(true);
        expect(yield* fs.exists(path.join(skillsDir, "shared"))).toBe(false);
        expect(yield* fs.exists(path.join(libraryDir, "shared", "SKILL.md"))).toBe(true);
      }),
    );

    it.effect("moves a local skill into the library and links it back", () =>
      Effect.gen(function* () {
        const { fs, path, libraryDir, skillsDir } = yield* fixture;
        expect((yield* moveSkillToLibrary({ skillsDir, libraryDir, name: "shared" })).ok).toBe(
          false,
        );
        expect((yield* moveSkillToLibrary({ skillsDir, libraryDir, name: "missing" })).ok).toBe(
          false,
        );

        expect(yield* moveSkillToLibrary({ skillsDir, libraryDir, name: "mine" })).toEqual({
          ok: true,
          message: null,
        });
        expect(yield* fs.readLink(path.join(skillsDir, "mine"))).toBe(
          path.join(libraryDir, "mine"),
        );
        expect(yield* fs.readFileString(path.join(libraryDir, "mine", "SKILL.md"))).toContain(
          "My own skill",
        );

        yield* fs.makeDirectory(path.join(skillsDir, "dupe"));
        yield* fs.makeDirectory(path.join(libraryDir, "dupe"));
        expect((yield* moveSkillToLibrary({ skillsDir, libraryDir, name: "dupe" })).ok).toBe(false);
        expect(yield* fs.exists(path.join(skillsDir, "dupe"))).toBe(true);
      }),
    );
  });
});
