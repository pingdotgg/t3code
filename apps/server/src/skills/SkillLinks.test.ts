import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { createLink, linkSpec, removeLink, SkillLinkError } from "./SkillLinks.ts";

/** A temp folder holding one project and one library folder, with their paths made real. */
const makeFolders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-links-" }));
  const project = path.join(root, "app");
  const library = path.join(root, "library");
  const skill = (folder: string, name: string) =>
    Effect.gen(function* () {
      const home = path.join(folder, name);
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(path.join(home, "SKILL.md"), `---\nname: ${name}\n---\n`);
      yield* fs.writeFileString(path.join(home, "notes.txt"), "keep me");
      return home;
    });
  return { fs, path, root, project, library, skill };
});

describe("linkSpec", () => {
  const home = "/data/skills/review";

  it.each([
    {
      name: "a project link on any system is relative when the skill is in the project",
      input: { platform: "linux", scope: "project", home, relative: "../../.agents/skills/review" },
      expected: { type: "dir", target: "../../.agents/skills/review" },
    },
    {
      name: "a project link is absolute when the skill is outside the project",
      input: { platform: "linux", scope: "project", home, relative: undefined },
      expected: { type: "dir", target: home },
    },
    {
      name: "a global link is absolute",
      input: { platform: "darwin", scope: "global", home, relative: undefined },
      expected: { type: "dir", target: home },
    },
    {
      name: "a global link on Windows is a junction, which needs no privilege and an absolute path",
      input: { platform: "win32", scope: "global", home, relative: undefined },
      expected: { type: "junction", target: home },
    },
    {
      name: "a project link on Windows stays a relative symlink, since a junction can't be committed",
      input: { platform: "win32", scope: "project", home, relative: "../review" },
      expected: { type: "dir", target: "../review" },
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(linkSpec(input)).toEqual(expected);
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillLinks", (it) => {
  describe("createLink", () => {
    it.effect.skipIf(!symlinksSupported)(
      "makes a project link relative, creating the folder it goes in",
      () =>
        Effect.gen(function* () {
          const { fs, path, project, skill } = yield* makeFolders;
          const home = yield* skill(path.join(project, ".agents/skills"), "review");
          const link = path.join(project, ".claude/skills/review");

          const result = yield* createLink({
            link,
            home,
            scope: "project",
            platform: "linux",
            projectRoot: project,
          });

          expect(result).toBe("created");
          expect(yield* fs.readLink(link)).toBe("../../.agents/skills/review");
          expect(yield* fs.realPath(link)).toBe(home);
        }),
    );

    it.effect.skipIf(!symlinksSupported)("makes a global link absolute", () =>
      Effect.gen(function* () {
        const { fs, path, root, library, skill } = yield* makeFolders;
        const home = yield* skill(library, "review");
        const link = path.join(root, "home/.claude/skills/review");

        expect(yield* createLink({ link, home, scope: "global", platform: "linux" })).toBe(
          "created",
        );
        expect(yield* fs.readLink(link)).toBe(home);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes a global link on Windows the way it would there: absolute, to the same folder",
      () =>
        Effect.gen(function* () {
          const { fs, path, root, library, skill } = yield* makeFolders;
          const home = yield* skill(library, "review");
          const link = path.join(root, "home/.claude/skills/review");

          // Node ignores the `junction` type away from Windows, so this makes a plain symlink.
          expect(yield* createLink({ link, home, scope: "global", platform: "win32" })).toBe(
            "created",
          );
          expect(yield* fs.readLink(link)).toBe(home);
          expect(yield* fs.realPath(link)).toBe(home);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps a project link working when the project folder is moved",
      () =>
        Effect.gen(function* () {
          const { fs, path, root, project, skill } = yield* makeFolders;
          const home = yield* skill(path.join(project, ".agents/skills"), "review");
          yield* createLink({
            link: path.join(project, ".claude/skills/review"),
            home,
            scope: "project",
            platform: "linux",
            projectRoot: project,
          });

          const moved = path.join(root, "app-renamed");
          yield* fs.rename(project, moved);

          expect(yield* fs.realPath(path.join(moved, ".claude/skills/review"))).toBe(
            path.join(moved, ".agents/skills/review"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reads a relative target from where the link's folder really is",
      () =>
        Effect.gen(function* () {
          const { fs, path, root, project, skill } = yield* makeFolders;
          const home = yield* skill(path.join(project, ".agents/skills"), "review");
          // `.claude` is a link to a dotfiles folder elsewhere, so `../..` means something else there.
          const dotfiles = path.join(root, "dotfiles/claude");
          yield* fs.makeDirectory(path.join(dotfiles, "skills"), { recursive: true });
          yield* fs.symlink(dotfiles, path.join(project, ".claude"));
          const link = path.join(project, ".claude/skills/review");

          expect(
            yield* createLink({
              link,
              home,
              scope: "project",
              platform: "linux",
              projectRoot: project,
            }),
          ).toBe("created");
          expect(yield* fs.realPath(link)).toBe(home);
        }),
    );

    it.effect.skipIf(!symlinksSupported)("leaves a real folder alone and says it is taken", () =>
      Effect.gen(function* () {
        const { fs, path, root, library, skill } = yield* makeFolders;
        const home = yield* skill(library, "review");
        const link = path.join(root, "home/.claude/skills/review");
        yield* fs.makeDirectory(link, { recursive: true });
        yield* fs.writeFileString(path.join(link, "mine.md"), "my own notes");

        expect(yield* createLink({ link, home, scope: "global", platform: "linux" })).toBe("taken");

        expect(yield* fs.readLink(link).pipe(Effect.flip)).toBeDefined();
        expect(yield* fs.readFileString(path.join(link, "mine.md"))).toBe("my own notes");
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves a link to another folder alone and says it is taken",
      () =>
        Effect.gen(function* () {
          const { fs, path, root, library, skill } = yield* makeFolders;
          const home = yield* skill(library, "review");
          const other = yield* skill(library, "review-copy");
          const link = path.join(root, "home/.claude/skills/review");
          yield* fs.makeDirectory(path.dirname(link), { recursive: true });
          yield* fs.symlink(other, link);

          expect(yield* createLink({ link, home, scope: "global", platform: "linux" })).toBe(
            "taken",
          );
          expect(yield* fs.readLink(link)).toBe(other);
        }),
    );

    it.effect.skipIf(!symlinksSupported)("says a link that is already there is unchanged", () =>
      Effect.gen(function* () {
        const { path, root, library, skill } = yield* makeFolders;
        const home = yield* skill(library, "review");
        const link = path.join(root, "home/.claude/skills/review");

        const input = { link, home, scope: "global", platform: "linux" } as const;
        expect(yield* createLink(input)).toBe("created");
        expect(yield* createLink(input)).toBe("unchanged");
      }),
    );
  });

  describe("removeLink", () => {
    it.effect.skipIf(!symlinksSupported)(
      "removes the link and leaves the folder it pointed at",
      () =>
        Effect.gen(function* () {
          const { fs, path, root, library, skill } = yield* makeFolders;
          const home = yield* skill(library, "review");
          const link = path.join(root, "home/.claude/skills/review");
          yield* createLink({ link, home, scope: "global", platform: "linux" });

          expect(yield* removeLink({ path: link, expectedTarget: home })).toBe("removed");

          expect(yield* fs.exists(link)).toBe(false);
          expect(yield* fs.readFileString(path.join(home, "notes.txt"))).toBe("keep me");
        }),
    );

    it.effect.skipIf(!symlinksSupported)("says nothing to remove when the link is gone", () =>
      Effect.gen(function* () {
        const { path, root } = yield* makeFolders;
        expect(
          yield* removeLink({ path: path.join(root, "nothing-here"), expectedTarget: "/x" }),
        ).toBe("gone");
      }),
    );

    it.effect.skipIf(!symlinksSupported)("leaves a real folder alone, whatever it holds", () =>
      Effect.gen(function* () {
        const { fs, path, library, skill } = yield* makeFolders;
        const home = yield* skill(library, "review");

        expect(yield* removeLink({ path: home, expectedTarget: home })).toBe("changed");

        expect(yield* fs.readFileString(path.join(home, "notes.txt"))).toBe("keep me");
      }),
    );

    it.effect.skipIf(!symlinksSupported)("leaves a link that points somewhere else", () =>
      Effect.gen(function* () {
        const { fs, path, root, library, skill } = yield* makeFolders;
        const home = yield* skill(library, "review");
        const other = yield* skill(library, "review-copy");
        const link = path.join(root, "home/.claude/skills/review");
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(other, link);

        // The link was inspected when it pointed at `home`; it has been repointed since.
        expect(yield* removeLink({ path: link, expectedTarget: home })).toBe("changed");

        expect(yield* fs.readLink(link)).toBe(other);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "fails instead of deleting when a folder takes the link's place right after the check",
      () =>
        Effect.gen(function* () {
          const { fs, path, library, skill } = yield* makeFolders;
          const home = yield* skill(library, "review");
          // The check sees the link it expected; by the time of the remove it is a folder.
          const swapped = FileSystem.FileSystem.of({
            ...fs,
            readLink: (target) =>
              target === home ? Effect.succeed("expected-target") : fs.readLink(target),
          });

          const error = yield* removeLink({ path: home, expectedTarget: "expected-target" }).pipe(
            Effect.provideService(FileSystem.FileSystem, swapped),
            Effect.flip,
          );

          expect(error).toBeInstanceOf(SkillLinkError);
          expect(error.operation).toBe("remove");
          expect(yield* fs.readFileString(path.join(home, "notes.txt"))).toBe("keep me");
          expect(yield* fs.exists(path.join(home, "SKILL.md"))).toBe(true);
        }),
    );
  });
});
