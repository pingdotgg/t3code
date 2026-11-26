// Fork: Kaluwa's Extensions page. User-level skills: folders with a SKILL.md in a subscription's
// skills directory, either links into one shared library or the subscription's own copies.
import type { ExtensionSkill, ExtensionsLibrarySkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

/** The shared skill library, relative to the user's home. */
export const SKILL_LIBRARY_SEGMENTS = [".agents", "skills"] as const;

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_BYTES = 256 * 1024;

export interface SkillOutcome {
  readonly ok: boolean;
  readonly message: string | null;
}

const refused = (message: string): SkillOutcome => ({ ok: false, message });
const done = (message: string | null = null): SkillOutcome => ({ ok: true, message });

function skillDescription(contents: string): string | null {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return null;
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null) return null;
    const description = (parsed as { readonly description?: unknown }).description;
    return typeof description === "string" && description.trim().length > 0
      ? description.trim()
      : null;
  } catch {
    return null;
  }
}

/** A skill name is one directory entry; anything that could leave the directory is refused. */
export function isSafeSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

const isInside = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// Untraced: per-entry helpers run inside the caller's list or mutation span.
const readLinkTarget = Effect.fnUntraced(function* (entryPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readLink(entryPath).pipe(
    Effect.map((target) => Option.some(path.resolve(path.dirname(entryPath), target))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});

const isLibraryLink = Effect.fnUntraced(function* (entryPath: string, libraryDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* readLinkTarget(entryPath);
  if (Option.isNone(target)) return { linked: false, intoLibrary: false } as const;
  const realLibrary = yield* fs.realPath(libraryDir).pipe(Effect.orElseSucceed(() => libraryDir));
  const realTarget = yield* fs
    .realPath(target.value)
    .pipe(Effect.orElseSucceed(() => target.value));
  const intoLibrary =
    isInside(path, libraryDir, target.value) || isInside(path, realLibrary, realTarget);
  return { linked: true, intoLibrary } as const;
});

const readSkillFile = Effect.fnUntraced(function* (skillDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(skillDir, "SKILL.md");
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return Option.none<string>();
  if (info.value.size > BigInt(MAX_SKILL_BYTES)) return Option.some("");
  return yield* fs.readFileString(file).pipe(Effect.option);
});

const skillEntryNames = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<Array<string>>([])));
  return names.filter(isSafeSkillName).sort((left, right) => left.localeCompare(right));
});

/** Lists a skills directory. A missing directory has no skills; any other read failure fails. */
export const discoverSkills = Effect.fn("Extensions.discoverSkills")(function* (input: {
  readonly skillsDir: string;
  readonly libraryDir: string;
  readonly displayPath: (absolute: string) => string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: Array<ExtensionSkill> = [];
  for (const name of yield* skillEntryNames(input.skillsDir)) {
    const entryPath = path.join(input.skillsDir, name);
    const link = yield* isLibraryLink(entryPath, input.libraryDir);
    const info = yield* fs.stat(entryPath).pipe(Effect.option);
    const base = {
      name,
      source: link.intoLibrary ? ("library" as const) : ("local" as const),
      path: input.displayPath(entryPath),
    };
    if (Option.isNone(info)) {
      if (link.linked) {
        skills.push({
          ...base,
          description: null,
          health: "failing",
          detail: "The link points to a skill that no longer exists",
        });
      }
      continue;
    }
    if (info.value.type !== "Directory") continue;
    const contents = yield* readSkillFile(entryPath);
    // Folders without a SKILL.md, such as Claude's synced/ container, aren't skills.
    if (Option.isNone(contents)) continue;
    const description = skillDescription(contents.value);
    skills.push({
      ...base,
      description,
      health: description === null ? "failing" : "ok",
      detail: description === null ? "SKILL.md has no description" : null,
    });
  }
  return skills;
});

export const listLibrarySkills = Effect.fn("Extensions.listLibrarySkills")(function* (
  libraryDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: Array<ExtensionsLibrarySkill> = [];
  for (const name of yield* skillEntryNames(libraryDir)) {
    const entryPath = path.join(libraryDir, name);
    const info = yield* fs.stat(entryPath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") continue;
    const contents = yield* readSkillFile(entryPath);
    if (Option.isNone(contents)) continue;
    skills.push({ name, description: skillDescription(contents.value) });
  }
  return skills;
});

const entryExists = Effect.fnUntraced(function* (entryPath: string) {
  const fs = yield* FileSystem.FileSystem;
  // A dangling link still occupies the name, so check the link itself too.
  const linked = Option.isSome(yield* readLinkTarget(entryPath));
  return linked || (yield* fs.exists(entryPath).pipe(Effect.orElseSucceed(() => false)));
});

const failureMessage = (action: string) => (error: { readonly message: string }) =>
  Effect.succeed(refused(`Could not ${action}: ${error.message}`));

export const linkSkill = Effect.fn("Extensions.linkSkill")(function* (input: {
  readonly skillsDir: string;
  readonly libraryDir: string;
  readonly name: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(input.libraryDir, input.name);
  const entryPath = path.join(input.skillsDir, input.name);
  if (Option.isNone(yield* readSkillFile(target))) {
    return refused(`The library has no skill named "${input.name}".`);
  }
  if (yield* entryExists(entryPath)) {
    const link = yield* isLibraryLink(entryPath, input.libraryDir);
    const current = yield* readLinkTarget(entryPath);
    if (link.intoLibrary && Option.getOrUndefined(current) === target) {
      return done("Already linked.");
    }
    return refused(`"${input.name}" already exists here and isn't a link to the library.`);
  }
  return yield* fs
    .makeDirectory(input.skillsDir, { recursive: true })
    .pipe(
      Effect.andThen(fs.symlink(target, entryPath)),
      Effect.as(done()),
      Effect.catch(failureMessage("link the skill")),
    );
});

export const unlinkSkill = Effect.fn("Extensions.unlinkSkill")(function* (input: {
  readonly skillsDir: string;
  readonly libraryDir: string;
  readonly name: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entryPath = path.join(input.skillsDir, input.name);
  const link = yield* isLibraryLink(entryPath, input.libraryDir);
  if (!link.linked) {
    return (yield* entryExists(entryPath))
      ? refused(
          `"${input.name}" is this subscription's own skill, not a library link. Move it to the library instead of removing it.`,
        )
      : refused(`No skill named "${input.name}".`);
  }
  if (!link.intoLibrary) {
    return refused(`"${input.name}" links outside the skill library, so it was left in place.`);
  }
  // Removes the link only; the library copy stays.
  return yield* fs
    .remove(entryPath)
    .pipe(Effect.as(done()), Effect.catch(failureMessage("unlink the skill")));
});

export const moveSkillToLibrary = Effect.fn("Extensions.moveSkillToLibrary")(function* (input: {
  readonly skillsDir: string;
  readonly libraryDir: string;
  readonly name: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entryPath = path.join(input.skillsDir, input.name);
  const destination = path.join(input.libraryDir, input.name);
  if ((yield* isLibraryLink(entryPath, input.libraryDir)).linked) {
    return refused(`"${input.name}" is already a link, not a local skill.`);
  }
  const info = yield* fs.stat(entryPath).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory") {
    return refused(`No local skill named "${input.name}".`);
  }
  if (yield* entryExists(destination)) {
    return refused(`The library already has a skill named "${input.name}".`);
  }
  // rename fails across filesystems; copying first keeps the original until the copy exists.
  const move = fs
    .rename(entryPath, destination)
    .pipe(
      Effect.catch(() =>
        fs
          .copy(entryPath, destination)
          .pipe(Effect.andThen(fs.remove(entryPath, { recursive: true }))),
      ),
    );
  return yield* fs
    .makeDirectory(input.libraryDir, { recursive: true })
    .pipe(
      Effect.andThen(move),
      Effect.andThen(fs.symlink(destination, entryPath)),
      Effect.as(done()),
      Effect.catch(failureMessage("move the skill to the library")),
    );
});
