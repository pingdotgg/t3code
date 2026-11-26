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
  removeBrokenLinks,
  unlinkSkill,
  useLibraryCopy,
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
  // Same name in the library: one identical copy (a .DS_Store doesn't count), one that differs.
  for (const dir of [path.join(libraryDir, "twin"), path.join(skillsDir, "twin")]) {
    yield* writeSkill(dir, "Twin");
    yield* fs.makeDirectory(path.join(dir, "scripts"));
    yield* fs.writeFileString(path.join(dir, "scripts", "run.sh"), "echo hi\n");
  }
  yield* fs.writeFileString(path.join(skillsDir, "twin", ".DS_Store"), "finder");
  yield* writeSkill(path.join(libraryDir, "fork"), "Library fork");
  yield* writeSkill(path.join(skillsDir, "fork"), "Local fork");
  // Dangling links: a relative one into the library and an absolute one elsewhere.
  yield* fs.symlink("../../library/gone", path.join(skillsDir, "gone-relative"));
  yield* fs.symlink(
    path.join(root, "elsewhere", "vanished"),
    path.join(skillsDir, "gone-absolute"),
  );
  // The library lists only entries that exist: a live link counts, a dangling one doesn't.
  yield* fs.symlink(path.join(root, "elsewhere", "outside"), path.join(libraryDir, "outside-link"));
  yield* fs.symlink(path.join(root, "elsewhere", "nothing"), path.join(libraryDir, "ghost"));
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
        const broken = "The link points to a skill that no longer exists";
        expect(
          skills.map((skill) => [
            skill.name,
            skill.source,
            skill.brokenLink,
            skill.libraryCopy,
            skill.health,
            skill.detail,
            skill.path,
          ]),
        ).toEqual([
          ["fork", "local", false, "different", "ok", null, "fork"],
          ["gone-absolute", "local", true, "none", "failing", broken, "gone-absolute"],
          ["gone-relative", "library", true, "none", "failing", broken, "gone-relative"],
          ["mine", "local", false, "none", "ok", null, "mine"],
          ["outside", "local", false, "none", "ok", null, "outside"],
          ["shared", "library", false, "none", "ok", null, "shared"],
          ["twin", "local", false, "same", "ok", null, "twin"],
          [
            "undescribed",
            "local",
            false,
            "none",
            "failing",
            "SKILL.md has no description",
            "undescribed",
          ],
        ]);
        expect((yield* listLibrarySkills(libraryDir)).map((skill) => skill.name)).toEqual([
          "fork",
          "outside-link",
          "shared",
          "twin",
          "unlinked",
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

        expect(yield* moveSkillToLibrary({ skillsDir, libraryDir, name: "twin" })).toEqual({
          ok: false,
          message: "The library already has an identical twin. Use the library copy instead.",
        });
        expect(yield* moveSkillToLibrary({ skillsDir, libraryDir, name: "fork" })).toEqual({
          ok: false,
          message:
            "The library already has a different fork. Use the library copy (your copy is backed up) or rename one of them.",
        });
        expect(yield* fs.readFileString(path.join(skillsDir, "fork", "SKILL.md"))).toContain(
          "Local fork",
        );
      }),
    );
  });

  describe("broken links and library copies", () => {
    it.effect("removes only dangling links, never folders or live links", () =>
      Effect.gen(function* () {
        const { fs, path, libraryDir, skillsDir } = yield* fixture;
        expect(yield* removeBrokenLinks([skillsDir, path.join(skillsDir, "missing-dir")])).toEqual({
          ok: true,
          message: "Removed 2 broken links.",
        });
        const left = (yield* fs.readDirectory(skillsDir)).sort();
        expect(left).not.toContain("gone-relative");
        expect(left).not.toContain("gone-absolute");
        for (const kept of ["mine", "shared", "outside", "twin", "synced", ".system"]) {
          expect(left).toContain(kept);
        }
        expect(yield* fs.exists(path.join(libraryDir, "shared", "SKILL.md"))).toBe(true);
        expect((yield* removeBrokenLinks([skillsDir])).message).toBe("No broken links to remove.");
      }),
    );

    it.effect("backs up a local skill and links the library copy in its place", () =>
      Effect.gen(function* () {
        const { fs, path, libraryDir, skillsDir } = yield* fixture;
        const timestamp = "20261126T120102Z";
        expect(
          (yield* useLibraryCopy({ skillsDir, libraryDir, name: "shared", timestamp })).ok,
        ).toBe(false);
        expect((yield* useLibraryCopy({ skillsDir, libraryDir, name: "mine", timestamp })).ok).toBe(
          false,
        );
        expect(yield* fs.exists(path.join(skillsDir, "mine", "SKILL.md"))).toBe(true);

        expect(yield* useLibraryCopy({ skillsDir, libraryDir, name: "fork", timestamp })).toEqual({
          ok: true,
          message: "Your copy is backed up in .kaluwa-replaced/fork-20261126T120102Z.",
        });
        expect(yield* fs.readLink(path.join(skillsDir, "fork"))).toBe(
          path.join(libraryDir, "fork"),
        );
        expect(
          yield* fs.readFileString(
            path.join(skillsDir, ".kaluwa-replaced", "fork-20261126T120102Z", "SKILL.md"),
          ),
        ).toContain("Local fork");
        const listed = yield* discoverSkills({ skillsDir, libraryDir, displayPath: (p) => p });
        expect(listed.find((skill) => skill.name === "fork")?.source).toBe("library");
        expect(listed.some((skill) => skill.name.startsWith("."))).toBe(false);
      }),
    );
  });
});
