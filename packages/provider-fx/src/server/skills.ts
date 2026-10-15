/**
 * Discovers fx skills for the `$` picker by scanning the SKILL.md folders fx
 * reads (fx 0.0.13, src/builtins/skills.zig), so no `fx acp` session starts
 * for a composer menu.
 *
 * @module provider-fx/server/skills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

/**
 * fx's menu lists its managed `~/.fx/skills` first, then a workspace's own
 * `.fx/skills` and `skills/`, then every compatibility root
 * (`skillGroupRank` in src/core/skills/skill_runtime.zig). fx follows a
 * symlinked skill folder in every root except its managed one, which it
 * fills itself.
 */
type SkillRoot = {
  readonly relative: string;
  readonly rank: 0 | 1 | 2;
  readonly followsLinks?: false;
};

const FX_WORKSPACE_ROOTS: ReadonlyArray<SkillRoot> = [
  { relative: ".fx/skills", rank: 1 },
  { relative: "skills", rank: 1 },
  { relative: ".opencode/skills", rank: 2 },
  { relative: ".codex/skills", rank: 2 },
  { relative: ".claude/skills", rank: 2 },
  { relative: ".agents/skills", rank: 2 },
  { relative: ".claw/skills", rank: 2 },
];
const FX_HOME_ROOTS: ReadonlyArray<SkillRoot> = [
  { relative: ".fx/skills", rank: 0, followsLinks: false },
  { relative: ".config/opencode/skills", rank: 2 },
  { relative: ".codex/skills", rank: 2 },
  { relative: ".claude/skills", rank: 2 },
  { relative: ".agents/skills", rank: 2 },
  { relative: ".claw/skills", rank: 2 },
];

const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 256;
const BLOCK_DESCRIPTION_STYLES = new Set([">", ">-", "|"]);
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * fx works on bytes: a byte-order mark means the file does not start with
 * `---` (no frontmatter), and invalid UTF-8 in a value makes it invalid,
 * while a literal U+FFFD is valid text. So the BOM is kept, and a line with
 * invalid UTF-8 ends in a NUL, which the parser rejects in any value read
 * from that line.
 */
function decodeSkillFile(bytes: Uint8Array): string {
  const lines: Array<string> = [];
  for (let start = 0; ;) {
    const newline = bytes.indexOf(0x0a, start);
    const line = bytes.subarray(start, newline === -1 ? bytes.length : newline);
    try {
      lines.push(strictDecoder.decode(line));
    } catch {
      lines.push(`${lenientDecoder.decode(line)}\u0000`);
    }
    if (newline === -1) return lines.join("\n");
    start = newline + 1;
  }
}

function concatBytes(chunks: Iterable<Uint8Array>): Uint8Array {
  const parts = [...chunks];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return a.length - b.length;
}

/** fx trims only spaces and tabs. */
const trimSpaceTab = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, "");

/** fx's `invalidTextCause`: no ASCII control bytes (invalid UTF-8 shows up as one). */
const hasControlByte = (value: string) => [...value].some((char) => char < " " || char === "\x7f");

/** fx's `parseRecognizedValue`: one quoted or bare scalar, no YAML. */
function recognizedValue(raw: string): string | undefined {
  if (raw.startsWith("|") || raw.startsWith(">")) return undefined;
  const quoted = /^['"]/.test(raw) || /['"]$/.test(raw);
  if (!quoted) return raw;
  return raw.length >= 2 && raw[0] === raw.at(-1) ? raw.slice(1, -1) : undefined;
}

/**
 * A skill's name and description, read the way fx 0.0.13 reads SKILL.md
 * (`parseSkillFile` in src/core/skills/skill_contract.zig): a line-based
 * `name:` / `description:` header, not YAML. fx names a skill by its folder
 * only when there is no frontmatter; frontmatter it can't read (no closing
 * `---`, a missing or repeated `name`, a continued value) makes the skill
 * invalid, and fx won't load it.
 */
function parseSkillMetadata(
  contents: string,
  folderName: string,
): { readonly name: string; readonly description?: string } | undefined {
  const opening = /^---(\r?\n|$)/.exec(contents);
  if (opening === null) {
    return validSkillName(folderName) ? { name: folderName } : undefined;
  }
  // fx drops a line's trailing `\r` only before a newline, and bounds the
  // file up to the line after the closing `---`.
  const lines = contents.slice(opening[0].length).split("\n");
  const unterminated = (index: number) => index === lines.length - 1;
  const closing = lines.findIndex(
    (line, index) => (unterminated(index) ? line : line.replace(/\r$/, "")) === "---",
  );
  if (closing === -1) return undefined;
  const throughClosing = opening[0] + lines.slice(0, closing + 1).join("\n");
  const bodyStart = throughClosing.length + (unterminated(closing) ? 0 : 1);
  if (encoder.encode(contents.slice(0, bodyStart)).length > MAX_FRONTMATTER_BYTES) {
    return undefined;
  }
  const header = lines.slice(0, closing).map((line) => line.replace(/\r$/, ""));

  let name: string | undefined;
  let description: string | undefined;
  let sawName = false;
  let sawDescription = false;
  let previousRecognized = false;
  for (let index = 0; index < header.length; index++) {
    const line = header[index] ?? "";
    const trimmed = trimSpaceTab(line);
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (previousRecognized && /^[ \t]/.test(line)) return undefined;
    previousRecognized = false;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimSpaceTab(trimmed.slice(0, colon));
    const raw = trimSpaceTab(trimmed.slice(colon + 1));
    if (key === "name") {
      if (sawName) return undefined;
      sawName = true;
      name = recognizedValue(raw);
      if (name === undefined) return undefined;
      previousRecognized = true;
    } else if (key === "description") {
      if (sawDescription) return undefined;
      sawDescription = true;
      if (BLOCK_DESCRIPTION_STYLES.has(raw)) {
        // A block description runs over the following space-indented lines;
        // fx rejects a tab or a shrinking indent inside it.
        // Blank lines stay part of the block (`undefined` below).
        const block: Array<string | undefined> = [];
        let baseIndent: number | undefined;
        for (; index + 1 < header.length; index++) {
          const next = header[index + 1] ?? "";
          if (trimSpaceTab(next).length === 0) {
            block.push(undefined);
            continue;
          }
          const indent = /^ */.exec(next)?.[0].length ?? 0;
          if (next[indent] === "\t") return undefined;
          if (indent === 0) break;
          if (baseIndent !== undefined && indent < baseIndent) return undefined;
          baseIndent ??= indent;
          const content = next.slice(baseIndent);
          if (hasControlByte(content)) return undefined;
          block.push(content);
        }
        description = decodeBlockDescription(block, raw);
      } else {
        description = recognizedValue(raw);
        if (description === undefined || hasControlByte(description)) return undefined;
        previousRecognized = true;
      }
    }
  }
  if (name === undefined || !validSkillName(name)) return undefined;
  return { name, ...(description ? { description } : {}) };
}

/**
 * fx's `decode_block_description`: `|` keeps line breaks; `>` and `>-` join
 * neighbouring lines with a space and turn a blank line into a break. Only
 * `>-` drops the final newline, which the menu trims anyway.
 */
function decodeBlockDescription(lines: ReadonlyArray<string | undefined>, style: string): string {
  const lastLine = lines.findLastIndex((line) => line !== undefined);
  let text = "";
  for (let index = 0; index <= lastLine; index++) {
    const line = lines[index];
    if (index > 0) {
      text += style !== "|" && lines[index - 1] !== undefined && line !== undefined ? " " : "\n";
    }
    text += line ?? "";
  }
  return text.trim();
}

/** fx's `invalidSkillNameCause`. */
function validSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    encoder.encode(name).length <= MAX_NAME_BYTES &&
    !hasControlByte(name) &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/**
 * fx scans the workspace roots of each directory from the workspace up to,
 * not including, HOME, then its managed root, then the home roots.
 */
function skillRoots(path: Path.Path, cwd: string, home: string) {
  const roots: Array<{
    readonly directory: string;
    readonly scope: string;
    readonly rank: number;
    readonly followsLinks: boolean;
  }> = [];
  for (let current = cwd; current !== home;) {
    for (const root of FX_WORKSPACE_ROOTS) {
      roots.push({
        directory: path.join(current, root.relative),
        scope: "project",
        rank: root.rank,
        followsLinks: root.followsLinks ?? true,
      });
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const root of FX_HOME_ROOTS) {
    roots.push({
      directory: path.join(home, root.relative),
      scope: "user",
      rank: root.rank,
      followsLinks: root.followsLinks ?? true,
    });
  }
  return roots;
}

const skipUnreadable = <A, R>(
  path: string,
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A | undefined, never, R> =>
  effect.pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.void.pipe(Effect.as(undefined))
          : Effect.logWarning("fx skill scan skipped an unreadable path.", {
              path,
              errorTag: error.reason._tag,
            }).pipe(Effect.as(undefined)),
    }),
  );

const discoverSkillsInRoot = Effect.fn("discoverFxSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: string;
  readonly followsLinks: boolean;
}): Effect.fn.Return<
  ReadonlyArray<{ readonly skill: ServerProviderSkill; readonly folder: string }>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isLink = (target: string) =>
    Effect.option(fileSystem.readLink(target)).pipe(Effect.map(Option.isSome));
  // fx gives its managed root no read authority: it loads nothing through a
  // link to the root or to a folder or SKILL.md inside it (HOME is already
  // a real path here, so a linked root changes its real path).
  if (
    !input.followsLinks &&
    (yield* fileSystem.realPath(input.directory).pipe(Effect.option)).pipe(
      Option.exists((real) => real !== input.directory),
    )
  ) {
    return [];
  }
  const entries = yield* skipUnreadable(input.directory, fileSystem.readDirectory(input.directory));
  const skills: Array<{ readonly skill: ServerProviderSkill; readonly folder: string }> = [];
  // fx reads a root's folders in UTF-8 byte order; readDirectory promises none.
  for (const entry of [...(entries ?? [])].sort(compareUtf8)) {
    if (!input.followsLinks && (yield* isLink(path.join(input.directory, entry)))) continue;
    // A stray file (`.DS_Store`, a README) is no skill folder.
    const entryInfo = yield* Effect.option(fileSystem.stat(path.join(input.directory, entry)));
    if (Option.isNone(entryInfo) || entryInfo.value.type !== "Directory") continue;
    const skillPath = path.join(input.directory, entry, "SKILL.md");
    if (!input.followsLinks && (yield* isLink(skillPath))) continue;
    const skillInfo = yield* skipUnreadable(skillPath, fileSystem.stat(skillPath));
    if (skillInfo?.type !== "File") continue;
    // fx reads only the metadata prefix, so a long body never hides a skill.
    const prefix = yield* skipUnreadable(
      skillPath,
      fileSystem
        .stream(skillPath, { bytesToRead: MAX_FRONTMATTER_BYTES + 1 })
        .pipe(Stream.runCollect, Effect.map(concatBytes)),
    );
    const metadata =
      prefix === undefined ? undefined : parseSkillMetadata(decodeSkillFile(prefix), entry);
    if (metadata === undefined) continue;
    const folder = yield* skipUnreadable(
      skillPath,
      fileSystem.realPath(path.join(input.directory, entry)),
    );
    skills.push({
      folder: folder ?? path.join(input.directory, entry),
      skill: {
        name: metadata.name,
        path: skillPath,
        scope: input.scope,
        enabled: true,
        ...(metadata.description === undefined ? {} : { description: metadata.description }),
      },
    });
  }
  return skills;
});

/**
 * Skills in fx's menu order. Like fx, a folder reached twice (a symlinked
 * root) counts once. When two different skills share a name, `$name` lets
 * the model choose from fx's catalog, which lists them in scan order; it
 * takes the first copy, so that is the one listed here.
 */
export const discoverFxSkills = Effect.fn("discoverFxSkills")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  // fx reads skills only under a set HOME, and compares HOME and the
  // workspace by their real paths.
  const configuredHome = input.environment.HOME?.trim();
  if (!configuredHome) return [];
  const fileSystem = yield* FileSystem.FileSystem;
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
  const home = yield* realPath(configuredHome);
  const cwd = yield* realPath(input.cwd);
  const path = yield* Path.Path;
  const seenFolders = new Set<string>();
  // `$review` and `$Review` each load the skill whose name matches the typed
  // case, so only an exact repeat of a name is dropped.
  const seenNames = new Set<string>();
  const found: Array<{ readonly skill: ServerProviderSkill; readonly rank: number }> = [];
  for (const root of skillRoots(path, cwd, home)) {
    for (const { skill, folder } of yield* discoverSkillsInRoot(root)) {
      if (seenFolders.has(folder)) continue;
      seenFolders.add(folder);
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      found.push({ skill, rank: root.rank });
    }
  }
  return found.sort((left, right) => left.rank - right.rank).map(({ skill }) => skill);
});
