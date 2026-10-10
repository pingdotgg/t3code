import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { deleteFolder, moveFolder, SkillMoveError } from "./SkillMove.ts";

/** A skill folder with nested files, an executable and a link that stays inside the skill. */
const makeSkill = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-move-" }));
  const from = path.join(root, "from/.agents/skills/verify");
  const to = path.join(root, "to/.agents/skills/verify");
  yield* fs.makeDirectory(path.join(from, "bin"), { recursive: true });
  yield* fs.makeDirectory(path.join(from, "refs/deep"), { recursive: true });
  yield* fs.writeFileString(path.join(from, "SKILL.md"), "---\nname: verify\n---\n");
  yield* fs.writeFileString(path.join(from, "bin/run"), "#!/bin/sh\necho ok\n");
  yield* fs.chmod(path.join(from, "bin/run"), 0o755);
  yield* fs.writeFileString(path.join(from, "refs/deep/notes.md"), "notes");
  if (symlinksSupported) yield* fs.symlink("refs/deep/notes.md", path.join(from, "latest.md"));
  return { fs, path, root, from, to };
});

const entriesOf = (fs: FileSystem.FileSystem, folder: string) =>
  fs.readDirectory(folder, { recursive: true }).pipe(Effect.map((names) => names.toSorted()));

/** A failure the way the Node file system reports it, so the code under test reads it as real. */
const platformError = (
  tag: "Unknown" | "Busy",
  method: string,
  pathOrDescriptor: string,
  code: string,
) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    pathOrDescriptor,
    cause: Object.assign(new Error(code), { code }),
  });

/** Runs `effect` against a file system where some calls are replaced. */
const withFileSystem = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  replace: (real: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return yield* effect.pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({ ...real, ...replace(real) }),
      ),
    );
  });

const move = (input: { from: string; to: string }) => moveFolder({ ...input, platform: "linux" });

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillMove", (it) => {
  describe("on one filesystem", () => {
    it.effect.skipIf(!symlinksSupported)("is a single rename that keeps everything", () =>
      Effect.gen(function* () {
        const { fs, path, from, to } = yield* makeSkill;
        const before = yield* entriesOf(fs, from);

        expect(yield* move({ from, to })).toBe("moved");

        expect(yield* fs.exists(from)).toBe(false);
        expect(yield* entriesOf(fs, to)).toEqual(before);
        expect(yield* fs.readLink(path.join(to, "latest.md"))).toBe("refs/deep/notes.md");
        expect((yield* fs.stat(path.join(to, "bin/run"))).mode & 0o111).not.toBe(0);
      }),
    );

    it.effect("never merges into or replaces what is at the destination", () =>
      Effect.gen(function* () {
        const { fs, path, from, to } = yield* makeSkill;
        yield* fs.makeDirectory(to, { recursive: true });
        const before = yield* entriesOf(fs, from);

        // An empty folder is taken, and so is one with a skill in it.
        expect(yield* move({ from, to })).toBe("taken");
        yield* fs.writeFileString(path.join(to, "SKILL.md"), "theirs");
        expect(yield* move({ from, to })).toBe("taken");

        expect(yield* entriesOf(fs, from)).toEqual(before);
        expect(yield* fs.readFileString(path.join(to, "SKILL.md"))).toBe("theirs");
      }),
    );

    it.effect.skipIf(!symlinksSupported)("treats a link that leads nowhere as taken", () =>
      Effect.gen(function* () {
        const { fs, path, from, to } = yield* makeSkill;
        yield* fs.makeDirectory(path.dirname(to), { recursive: true });
        yield* fs.symlink(path.join(path.dirname(to), "missing"), to);

        expect(yield* move({ from, to })).toBe("taken");

        expect(yield* fs.exists(path.join(from, "SKILL.md"))).toBe(true);
        expect(yield* fs.readLink(to)).toBe(path.join(path.dirname(to), "missing"));
      }),
    );

    it.effect("says so when the folder is in use, and changes nothing", () =>
      Effect.gen(function* () {
        const { fs, from, to } = yield* makeSkill;
        const before = yield* entriesOf(fs, from);

        const result = yield* withFileSystem(move({ from, to }), () => ({
          rename: (oldPath) => Effect.fail(platformError("Busy", "rename", oldPath, "EBUSY")),
        }));

        expect(result).toBe("inUse");
        expect(yield* entriesOf(fs, from)).toEqual(before);
        expect(yield* fs.exists(to)).toBe(false);
      }),
    );

    it.effect("reads a destination that filled up after the check as taken", () =>
      Effect.gen(function* () {
        const { fs, path, from, to } = yield* makeSkill;

        const result = yield* withFileSystem(move({ from, to }), () => ({
          rename: (oldPath) =>
            Effect.fail(platformError("Unknown", "rename", oldPath, "ENOTEMPTY")),
        }));

        expect(result).toBe("taken");
        expect(yield* fs.exists(path.join(from, "SKILL.md"))).toBe(true);
      }),
    );
  });

  describe("across filesystems", () => {
    /** The first rename, of the skill's own folder, fails the way a different device does. */
    const crossDevice = (from: string) => (real: FileSystem.FileSystem) => ({
      rename: (oldPath: string, newPath: string) =>
        oldPath === from
          ? Effect.fail(platformError("Unknown", "rename", oldPath, "EXDEV"))
          : real.rename(oldPath, newPath),
    });

    it.effect.skipIf(!symlinksSupported)(
      "copies, checks and renames the copy into place, then removes the original",
      () =>
        Effect.gen(function* () {
          const { fs, path, from, to } = yield* makeSkill;
          const before = yield* entriesOf(fs, from);

          const result = yield* withFileSystem(move({ from, to }), crossDevice(from));

          expect(result).toBe("moved");
          expect(yield* fs.exists(from)).toBe(false);
          expect(yield* entriesOf(fs, to)).toEqual(before);
          expect(yield* fs.readFileString(path.join(to, "refs/deep/notes.md"))).toBe("notes");
          // A link inside the skill keeps its target as written, so it still leads inside the copy.
          expect(yield* fs.readLink(path.join(to, "latest.md"))).toBe("refs/deep/notes.md");
          expect((yield* fs.stat(path.join(to, "bin/run"))).mode & 0o111).not.toBe(0);
          // No hidden folder is left beside the destination.
          expect(yield* fs.readDirectory(path.dirname(to))).toEqual(["verify"]);
        }),
    );

    it.effect("leaves no half-copied skill when a file can't be copied", () =>
      Effect.gen(function* () {
        const { fs, path, from, to } = yield* makeSkill;
        const before = yield* entriesOf(fs, from);

        const exit = yield* withFileSystem(move({ from, to }), (real) => ({
          ...crossDevice(from)(real),
          copyFile: (source, target) =>
            source.endsWith("notes.md")
              ? Effect.fail(platformError("Unknown", "copyFile", source, "EIO"))
              : real.copyFile(source, target),
        })).pipe(Effect.flip);

        expect(exit).toBeInstanceOf(SkillMoveError);
        expect(exit.operation).toBe("copy");
        expect(yield* entriesOf(fs, from)).toEqual(before);
        expect(yield* fs.exists(to)).toBe(false);
        expect(yield* fs.readDirectory(path.dirname(to))).toEqual([]);
      }),
    );

    it.effect("doesn't trust a copy that differs from the original", () =>
      Effect.gen(function* () {
        const { fs, path, from, to } = yield* makeSkill;
        const before = yield* entriesOf(fs, from);

        const error = yield* withFileSystem(move({ from, to }), (real) => ({
          ...crossDevice(from)(real),
          // Writes an empty file where the original has text.
          copyFile: (source, target) =>
            source.endsWith("notes.md")
              ? fs.writeFileString(target, "")
              : real.copyFile(source, target),
        })).pipe(Effect.flip);

        expect(error.operation).toBe("verify");
        expect(yield* entriesOf(fs, from)).toEqual(before);
        expect(yield* fs.exists(to)).toBe(false);
        expect(yield* fs.readDirectory(path.dirname(to))).toEqual([]);
      }),
    );

    it.effect("stops and removes its copy when something took the destination meanwhile", () =>
      Effect.gen(function* () {
        const { fs, path, from, to } = yield* makeSkill;

        const result = yield* withFileSystem(move({ from, to }), () => ({
          rename: (oldPath) =>
            oldPath === from
              ? Effect.fail(platformError("Unknown", "rename", oldPath, "EXDEV"))
              : Effect.fail(platformError("Unknown", "rename", oldPath, "ENOTEMPTY")),
        }));

        expect(result).toBe("taken");
        expect(yield* fs.exists(path.join(from, "SKILL.md"))).toBe(true);
        expect(yield* fs.readDirectory(path.dirname(to))).toEqual([]);
      }),
    );

    it.effect("keeps the new copy and says so when the original can't be removed", () =>
      Effect.gen(function* () {
        const { fs, from, to } = yield* makeSkill;
        const before = yield* entriesOf(fs, from);

        const result = yield* withFileSystem(move({ from, to }), (real) => ({
          ...crossDevice(from)(real),
          remove: (target, options) =>
            target === from
              ? Effect.fail(platformError("Unknown", "remove", target, "EACCES"))
              : real.remove(target, options),
        }));

        expect(result).toBe("movedWithLeftover");
        expect(yield* entriesOf(fs, to)).toEqual(before);
        expect(yield* entriesOf(fs, from)).toEqual(before);
      }),
    );
  });

  describe("deleting", () => {
    it.effect("removes the folder and what is in it, and nothing beside it", () =>
      Effect.gen(function* () {
        const { fs, path, from } = yield* makeSkill;
        const sibling = path.join(path.dirname(from), "other");
        yield* fs.makeDirectory(sibling);
        yield* fs.writeFileString(path.join(sibling, "SKILL.md"), "other");

        yield* deleteFolder(from);

        expect(yield* fs.exists(from)).toBe(false);
        expect(yield* fs.readFileString(path.join(sibling, "SKILL.md"))).toBe("other");
      }),
    );

    it.effect.skipIf(!symlinksSupported)("removes a link without following it", () =>
      Effect.gen(function* () {
        const { fs, path, from, root } = yield* makeSkill;
        const link = path.join(root, "link");
        yield* fs.symlink(from, link);

        yield* deleteFolder(link);

        expect(yield* fs.exists(link)).toBe(false);
        expect(yield* fs.exists(path.join(from, "SKILL.md"))).toBe(true);
      }),
    );
  });
});
