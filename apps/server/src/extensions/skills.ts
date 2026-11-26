// Fork: Kaluwa's Extensions page. User-level skills: folders with a SKILL.md in a subscription's
// skills directory, either links into one shared library or the subscription's own copies.
import type {
  ExtensionSkill,
  ExtensionSkillLibraryCopy,
  ExtensionsLibrarySkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

/** The shared skill library, relative to the user's home. */
export const SKILL_LIBRARY_SEGMENTS = [".agents", "skills"] as const;

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_BYTES = 256 * 1024;
// Bigger trees aren't compared byte for byte; they count as different.
const MAX_COMPARE_FILES = 2_000;
const MAX_COMPARE_BYTES = 32 * 1024 * 1024;
/** Where SkillUseLibraryCopy keeps the local copy it replaces. Discovery skips dot entries. */
const REPLACED_SKILLS_DIRECTORY = ".kaluwa-replaced";
const BROKEN_LINK_DETAIL = "The link points to a skill that no longer exists";

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
  const target = yield* fs.readLink(entryPath).pipe(Effect.option);
  if (Option.isNone(target)) return Option.none<string>();
  // A relative target is relative to where the link really lives, which matters when the skills
  // folder is itself reached through a link (Antigravity's profile links to ~/.gemini).
  const parent = yield* fs
    .realPath(path.dirname(entryPath))
    .pipe(Effect.orElseSucceed(() => path.dirname(entryPath)));
  return Option.some(path.resolve(parent, target.value));
});

const isDanglingLink = Effect.fnUntraced(function* (entryPath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isNone(yield* readLinkTarget(entryPath))) return false;
  return yield* fs.stat(entryPath).pipe(
    Effect.as(false),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
    Effect.orElseSucceed(() => false),
  );
});

// Relative file paths (sorted, without .DS_Store) and their bytes; undefined when too big to compare.
const readTree = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory, { recursive: true });
  const files: Array<readonly [string, Uint8Array]> = [];
  let bytes = 0;
  for (const relative of entries.sort()) {
    if (path.basename(relative) === ".DS_Store") continue;
    const info = yield* fs.stat(path.join(directory, relative));
    if (info.type === "Directory") continue;
    if (files.length >= MAX_COMPARE_FILES) return undefined;
    bytes += Number(info.size);
    if (bytes > MAX_COMPARE_BYTES) return undefined;
    files.push([relative, yield* fs.readFile(path.join(directory, relative))]);
  }
  return files;
});

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/** Whether the library has a skill with this name, and whether its files match byte for byte. */
const compareWithLibrary = Effect.fnUntraced(function* (
  skillDir: string,
  libraryDir: string,
  name: string,
) {
  const path = yield* Path.Path;
  const libraryCopy = path.join(libraryDir, name);
  if (Option.isNone(yield* readSkillFile(libraryCopy))) return "none" as ExtensionSkillLibraryCopy;
  const [local, library] = yield* Effect.all([readTree(skillDir), readTree(libraryCopy)]).pipe(
    Effect.orElseSucceed(() => [undefined, undefined] as const),
  );
  const same =
    local !== undefined &&
    library !== undefined &&
    local.length === library.length &&
    local.every(
      ([file, contents], index) =>
        library[index]?.[0] === file &&
        sameBytes(contents, library[index]?.[1] ?? new Uint8Array()),
    );
  return (same ? "same" : "different") as ExtensionSkillLibraryCopy;
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
      if (link.linked && (yield* isDanglingLink(entryPath))) {
        skills.push({
          ...base,
          description: null,
          brokenLink: true,
          libraryCopy: "none",
          health: "failing",
          detail: BROKEN_LINK_DETAIL,
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
      brokenLink: false,
      libraryCopy: link.intoLibrary
        ? "none"
        : yield* compareWithLibrary(entryPath, input.libraryDir, name),
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

// rename fails across filesystems; copying first keeps the original until the copy exists.
const moveDirectory = Effect.fnUntraced(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .rename(from, to)
    .pipe(
      Effect.catch(() =>
        fs.copy(from, to).pipe(Effect.andThen(fs.remove(from, { recursive: true }))),
      ),
    );
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
    return refused(
      (yield* compareWithLibrary(entryPath, input.libraryDir, input.name)) === "same"
        ? `The library already has an identical ${input.name}. Use the library copy instead.`
        : `The library already has a different ${input.name}. Use the library copy (your copy is backed up) or rename one of them.`,
    );
  }
  return yield* fs
    .makeDirectory(input.libraryDir, { recursive: true })
    .pipe(
      Effect.andThen(moveDirectory(entryPath, destination)),
      Effect.andThen(fs.symlink(destination, entryPath)),
      Effect.as(done()),
      Effect.catch(failureMessage("move the skill to the library")),
    );
});

/** Deletes only links directly in these folders whose target is gone; nothing else is touched. */
export const removeBrokenLinks = Effect.fn("Extensions.removeBrokenLinks")(
  function* (skillsDirs: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let removed = 0;
    for (const directory of skillsDirs) {
      const names = yield* fs
        .readDirectory(directory)
        .pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<Array<string>>([])),
        );
      for (const name of names) {
        const entryPath = path.join(directory, name);
        if (!(yield* isDanglingLink(entryPath))) continue;
        yield* fs.remove(entryPath);
        removed += 1;
      }
    }
    return done(
      removed === 0
        ? "No broken links to remove."
        : `Removed ${removed} broken ${removed === 1 ? "link" : "links"}.`,
    );
  },
  Effect.catch(failureMessage("remove the broken links")),
);

/**
 * Swaps a local skill for a link to the library's copy of the same name. The local folder is kept
 * as `<skills dir>/.kaluwa-replaced/<name>-<timestamp>`.
 */
export const useLibraryCopy = Effect.fn("Extensions.useLibraryCopy")(function* (input: {
  readonly skillsDir: string;
  readonly libraryDir: string;
  readonly name: string;
  /** UTC, filename-safe, such as 20261126T120102Z. */
  readonly timestamp: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entryPath = path.join(input.skillsDir, input.name);
  const target = path.join(input.libraryDir, input.name);
  if (Option.isSome(yield* readLinkTarget(entryPath))) {
    return refused(`"${input.name}" is already a link, not a local skill.`);
  }
  const info = yield* fs.stat(entryPath).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory") {
    return refused(`No local skill named "${input.name}".`);
  }
  if (Option.isNone(yield* readSkillFile(target))) {
    return refused(`The library has no skill named "${input.name}".`);
  }
  const backupDir = path.join(input.skillsDir, REPLACED_SKILLS_DIRECTORY);
  const backup = path.join(backupDir, `${input.name}-${input.timestamp}`);
  if (yield* entryExists(backup)) {
    return refused(`A backup named ${path.basename(backup)} already exists. Try again.`);
  }
  return yield* fs
    .makeDirectory(backupDir, { recursive: true })
    .pipe(
      Effect.andThen(moveDirectory(entryPath, backup)),
      Effect.andThen(fs.symlink(target, entryPath)),
      Effect.as(
        done(
          `Your copy is backed up in ${path.join(REPLACED_SKILLS_DIRECTORY, path.basename(backup))}.`,
        ),
      ),
      Effect.catch(failureMessage("switch to the library copy")),
    );
});
