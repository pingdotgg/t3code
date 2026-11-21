import {
  BotFileEntry,
  BotFileKind,
  BotOperationError,
  BotSlug,
  IsoDateTime,
  NonNegativeInt,
  type Bot,
  type BotId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

const decodeBotSlug = Schema.decodeUnknownSync(BotSlug);
const isBotOperationError = Schema.is(BotOperationError);
const decodeIsoDateTime = Schema.decodeUnknownSync(IsoDateTime);
const decodeNonNegativeInt = Schema.decodeUnknownSync(NonNegativeInt);

export function slugifyBotName(name: string): BotSlug {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return decodeBotSlug(normalized.length > 0 ? normalized : "bot");
}

export function allocateUniqueSlug(requested: string, existingSlugs: ReadonlySet<string>): BotSlug {
  const base = slugifyBotName(requested);
  if (!existingSlugs.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = decodeBotSlug(`${base}-${suffix}`);
    if (!existingSlugs.has(candidate)) return candidate;
  }
  return decodeBotSlug(`${base}-${existingSlugs.size + 1}`);
}

function buildStarterSoul(name: string): string {
  return [
    `# ${name}`,
    "",
    "## Role",
    "Describe what this bot owns and what good output looks like.",
    "",
    "## When to act",
    "- Respond to direct chat messages, handoffs, group mentions, and scheduled routines.",
    "",
    "## Boundaries",
    "- Never merge pull requests or push destructive changes without explicit human approval.",
    "- Record durable findings and preferences in `MEMORY.md` or `memory/`.",
    "",
  ].join("\n");
}

function buildStarterMemory(name: string): string {
  return [
    `# ${name} Memory`,
    "",
    "Durable facts, conventions, repository paths, and lessons learned live here.",
    "",
  ].join("\n");
}

function buildAgentPointer(name: string): string {
  return [
    `# ${name}`,
    "",
    "This directory is your bot home.",
    "",
    "- Read `SOUL.md` first for your identity, responsibilities, and hard boundaries.",
    "- Read `MEMORY.md` and relevant files under `memory/` for durable context across sessions.",
    "- Follow procedures in `skills/` when they match the task.",
    "- Update `MEMORY.md` or add dated notes under `memory/` when you learn durable facts.",
    "- To run work on another connected machine, inspect `t3_environment_links` and pass its `environmentId` to `t3_thread_launch` or `delegate_task`.",
    "",
  ].join("\n");
}

export function buildFirstRunInterviewPrompt(name: string): string {
  return [
    `You are "${name}", a newly created bot running your first-run setup interview.`,
    "Ask concise, practical questions to understand:",
    "1. Which repositories, projects, or trackers you own.",
    "2. Your primary job, schedule/triggers, and reporting style.",
    "3. Your hard boundaries (what requires human approval).",
    "Once the user confirms, update `SOUL.md` and `MEMORY.md` in your home directory.",
  ].join("\n");
}

export function buildTidyUpPrompt(name: string): string {
  return [
    `Run nightly memory tidy-up for bot "${name}".`,
    "1. Review `MEMORY.md` and all files under `memory/`.",
    "2. Consolidate durable facts into `MEMORY.md`, deduplicate stale entries, and archive or trim outdated notes.",
    "3. Keep `SOUL.md` unchanged unless you notice a factual path mismatch to flag to the user.",
    "4. Summarize what was consolidated in 2-4 bullet points.",
  ].join("\n");
}

function classifyBotFileKind(relativePath: string): BotFileKind {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "SOUL.md") return "soul";
  if (normalized === "MEMORY.md" || normalized.startsWith("memory/")) return "memory";
  if (normalized.startsWith("skills/")) return "skill";
  if (normalized === "AGENTS.md" || normalized === "CLAUDE.md") return "config";
  return "other";
}

const resolveContainedBotFilePath = Effect.fn("BotHome.resolveContainedFilePath")(function* (
  homePath: string,
  relativePath: string,
) {
  const path = yield* Path.Path;
  if (relativePath.includes("\0")) {
    return yield* new BotOperationError({ message: "Path contains a null byte." });
  }
  const cleaned = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.length === 0) {
    return yield* new BotOperationError({ message: "Path must not be empty." });
  }
  const root = path.resolve(homePath);
  const resolved = path.resolve(root, cleaned);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return yield* new BotOperationError({
      message: `Path "${relativePath}" escapes the bot home directory.`,
    });
  }
  return {
    absolutePath: resolved,
    normalizedRelativePath: rel.replace(/\\/g, "/"),
  };
});

const mapFsError = (action: string) => (error: { readonly message: string }) =>
  new BotOperationError({ message: `${action}: ${error.message}` });

export const ensureBotHomeDirectory = Effect.fn("BotHome.ensureDirectory")(
  function* (input: {
    readonly homePath: string;
    readonly name: string;
    readonly soulContent?: string | undefined;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(path.join(input.homePath, "memory"), { recursive: true });
    yield* fs.makeDirectory(path.join(input.homePath, "skills"), { recursive: true });

    const writeIfMissing = Effect.fnUntraced(function* (
      filePath: string,
      content: string,
      overwrite = false,
    ) {
      if (!overwrite) {
        const exists = yield* fs.exists(filePath);
        if (exists) return;
      }
      yield* fs.writeFileString(filePath, content);
    });

    yield* writeIfMissing(
      path.join(input.homePath, "SOUL.md"),
      input.soulContent ?? buildStarterSoul(input.name),
      input.soulContent !== undefined,
    );
    yield* writeIfMissing(path.join(input.homePath, "MEMORY.md"), buildStarterMemory(input.name));
    const pointer = buildAgentPointer(input.name);
    yield* writeIfMissing(path.join(input.homePath, "AGENTS.md"), pointer);
    yield* writeIfMissing(path.join(input.homePath, "CLAUDE.md"), pointer);
  },
  Effect.mapError(mapFsError("Failed to initialize bot home directory")),
);

export const importBotFolder = Effect.fn("BotHome.importFolder")(
  function* (input: {
    readonly sourcePath: string;
    readonly targetHomePath: string;
    readonly name: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const resolvedSource = path.resolve(input.sourcePath);
    const info = yield* fs.stat(resolvedSource);
    if (info.type !== "Directory") {
      return yield* new BotOperationError({
        message: `Source path "${resolvedSource}" is not a directory.`,
      });
    }

    yield* fs.makeDirectory(path.join(input.targetHomePath, "memory"), { recursive: true });
    yield* fs.makeDirectory(path.join(input.targetHomePath, "skills"), { recursive: true });

    const copyIfPresent = Effect.fnUntraced(function* (rel: string) {
      const src = path.join(resolvedSource, rel);
      const exists = yield* fs.exists(src);
      if (!exists) return false;
      yield* fs.copy(src, path.join(input.targetHomePath, rel), { overwrite: true });
      return true;
    });

    const copiedSoul = yield* copyIfPresent("SOUL.md");
    yield* copyIfPresent("skills");
    yield* copyIfPresent("README.md");
    yield* copyIfPresent("examples");

    if (!copiedSoul) {
      yield* fs.writeFileString(
        path.join(input.targetHomePath, "SOUL.md"),
        buildStarterSoul(input.name),
      );
    }

    const memoryPath = path.join(input.targetHomePath, "MEMORY.md");
    if (!(yield* fs.exists(memoryPath))) {
      yield* fs.writeFileString(memoryPath, buildStarterMemory(input.name));
    }

    const pointer = buildAgentPointer(input.name);
    yield* fs.writeFileString(path.join(input.targetHomePath, "AGENTS.md"), pointer);
    yield* fs.writeFileString(path.join(input.targetHomePath, "CLAUDE.md"), pointer);
  },
  Effect.mapError((error) =>
    isBotOperationError(error)
      ? error
      : new BotOperationError({ message: `Failed to import bot folder: ${error.message}` }),
  ),
);

export const listBotHomeFiles = Effect.fn("BotHome.listFiles")(
  function* (homePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries: Array<BotFileEntry> = [];

    const walk: (
      dir: string,
      prefix: string,
      depth: number,
    ) => Effect.Effect<void, PlatformError.PlatformError> = Effect.fnUntraced(function* (
      dir: string,
      prefix: string,
      depth: number,
    ) {
      if (depth > 5) return;
      const exists = yield* fs.exists(dir);
      if (!exists) return;
      const names = yield* fs.readDirectory(dir);
      for (const name of names) {
        if (name === ".git" || name === "node_modules") continue;
        const rel = prefix.length > 0 ? `${prefix}/${name}` : name;
        const full = path.join(dir, name);
        const stat = yield* fs.stat(full);
        if (stat.type === "Directory") {
          yield* walk(full, rel, depth + 1);
        } else if (stat.type === "File") {
          const updatedAt = Option.match(stat.mtime, {
            onNone: () => decodeIsoDateTime("1970-01-01T00:00:00.000Z"),
            onSome: (date) =>
              decodeIsoDateTime(DateTime.formatIso(DateTime.makeUnsafe(date.getTime()))),
          });
          entries.push({
            relativePath: rel,
            kind: classifyBotFileKind(rel),
            sizeBytes: decodeNonNegativeInt(Number(stat.size)),
            updatedAt,
          });
        }
      }
    });

    yield* walk(homePath, "", 0);
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return entries;
  },
  Effect.mapError(mapFsError("Failed to list bot files")),
);

export const readBotHomeFile = Effect.fn("BotHome.readFile")(function* (
  homePath: string,
  relativePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { absolutePath, normalizedRelativePath } = yield* resolveContainedBotFilePath(
    homePath,
    relativePath,
  );
  const content = yield* fs
    .readFileString(absolutePath)
    .pipe(Effect.mapError(mapFsError(`Failed to read "${normalizedRelativePath}"`)));
  return { relativePath: normalizedRelativePath, content };
});

export const writeBotHomeFile = Effect.fn("BotHome.writeFile")(function* (
  homePath: string,
  relativePath: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { absolutePath, normalizedRelativePath } = yield* resolveContainedBotFilePath(
    homePath,
    relativePath,
  );
  yield* fs
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.mapError(mapFsError(`Failed to write "${normalizedRelativePath}"`)));
  yield* fs
    .writeFileString(absolutePath, content)
    .pipe(Effect.mapError(mapFsError(`Failed to write "${normalizedRelativePath}"`)));
  const stat = yield* fs
    .stat(absolutePath)
    .pipe(Effect.mapError(mapFsError(`Failed to stat "${normalizedRelativePath}"`)));
  const updatedAt = Option.match(stat.mtime, {
    onNone: () => decodeIsoDateTime("1970-01-01T00:00:00.000Z"),
    onSome: (date) => decodeIsoDateTime(DateTime.formatIso(DateTime.makeUnsafe(date.getTime()))),
  });
  return {
    relativePath: normalizedRelativePath,
    sizeBytes: decodeNonNegativeInt(Number(stat.size)),
    updatedAt,
  };
});

export const removeBotHomeDirectory = Effect.fn("BotHome.removeDirectory")(
  function* (homePath: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(homePath, { recursive: true, force: true });
  },
  Effect.mapError(mapFsError("Failed to remove bot home directory")),
);

export function parseGroupMentions(
  body: string,
  members: ReadonlyArray<Pick<Bot, "id" | "slug" | "name">>,
): ReadonlyArray<BotId> {
  const lowerBody = body.toLowerCase();
  if (/(^|\s)@all\b/.test(lowerBody)) {
    return members.map((member) => member.id);
  }

  const matched = new Set<BotId>();
  const tokens = [...body.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  );
  for (const token of tokens) {
    for (const member of members) {
      const compactName = member.name.toLowerCase().replace(/\s+/g, "-");
      if (member.slug.toLowerCase() === token || compactName === token) {
        matched.add(member.id);
      }
    }
  }
  return [...matched];
}

export const sha256Hex = Effect.fn("BotHome.sha256Hex")(function* (value: string) {
  const digest = yield* Digest.Digest;
  const bytes = yield* digest.digest(Digest.sha256, new TextEncoder().encode(value));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
});
