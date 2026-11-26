// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous SHA-256 hashing for team asset content integrity.
import * as NodeCrypto from "node:crypto";
import {
  TeamOperationError,
  type TeamAssetProviderDriver,
  type TeamPrepromptInjectionScope,
  type TeamSkillReference,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { parse as parseYamlDocument } from "yaml";

const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_REFERENCE_FILES = 32;
const MAX_REFERENCE_BYTES = 256 * 1024;
const MAX_PREPROMPT_BYTES = 64 * 1024;
const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Pure text/Markdown allowlist for team skill reference files.
 * Executable scripts and binaries are strictly rejected by the security boundary.
 */
const ALLOWED_REFERENCE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".mdx",
  ".rst",
  ".json",
  ".yaml",
  ".yml",
]);

const FORBIDDEN_SHEBANG_PATTERN = /^#!/;

function invalidInput(message: string): TeamOperationError {
  return new TeamOperationError({ code: "invalid_input", message });
}

function containsBinaryOrControlBytes(content: string): boolean {
  if (content.includes("\0")) return true;
  // Reject non-whitespace C0 control characters common in binary payloads.
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

function normalizeAndValidateReferencePath(
  rawPath: string,
): Effect.Effect<string, TeamOperationError> {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return Effect.fail(invalidInput("Skill reference file path cannot be empty."));
  }
  if (trimmed.includes("\0") || trimmed.includes("\\")) {
    return Effect.fail(
      invalidInput(`Skill reference path "${trimmed}" contains invalid path characters.`),
    );
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) {
    return Effect.fail(
      invalidInput(`Skill reference path "${trimmed}" must be a relative path inside the skill.`),
    );
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.startsWith(".")) {
      return Effect.fail(
        invalidInput(
          `Skill reference path "${trimmed}" must not traverse parent or hidden directories.`,
        ),
      );
    }
  }
  const fileName = segments[segments.length - 1]!;
  if (fileName.toLowerCase() === "skill.md") {
    return Effect.fail(
      invalidInput('Reference files cannot overwrite "SKILL.md"; edit the main skill document.'),
    );
  }
  const dotIndex = fileName.lastIndexOf(".");
  const ext = dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
  if (!ALLOWED_REFERENCE_EXTENSIONS.has(ext)) {
    return Effect.fail(
      invalidInput(
        `Skill reference file "${trimmed}" is rejected: only pure Markdown and text files (${[...ALLOWED_REFERENCE_EXTENSIONS].join(", ")}) are allowed; executable scripts and binaries are forbidden.`,
      ),
    );
  }
  return Effect.succeed(segments.join("/"));
}

export const validateTeamSkillPayload = Effect.fn("TeamSkillValidation.validateSkill")(
  function* (input: {
    readonly slug: string;
    readonly providerDriver: TeamAssetProviderDriver;
    readonly skillMd: string;
    readonly references?: ReadonlyArray<TeamSkillReference>;
    readonly enabled?: boolean;
  }) {
    const slug = input.slug.trim().toLowerCase();
    if (!SKILL_SLUG_PATTERN.test(slug)) {
      return yield* invalidInput(
        "Skill slug must be 1–64 lowercase letters, digits, underscores, or hyphens starting with an alphanumeric character.",
      );
    }
    if (input.skillMd.trim().length === 0) {
      return yield* invalidInput("SKILL.md content cannot be empty.");
    }
    if (Buffer.byteLength(input.skillMd, "utf8") > MAX_SKILL_MD_BYTES) {
      return yield* invalidInput("SKILL.md exceeds the 256 KB maximum size.");
    }
    if (containsBinaryOrControlBytes(input.skillMd)) {
      return yield* invalidInput("SKILL.md must be pure UTF-8 Markdown text with no binary bytes.");
    }
    if (FORBIDDEN_SHEBANG_PATTERN.test(input.skillMd.trimStart())) {
      return yield* invalidInput("SKILL.md cannot begin with an executable shebang (#!).");
    }
    const frontmatterMatch = FRONTMATTER_PATTERN.exec(input.skillMd);
    if (!frontmatterMatch) {
      return yield* invalidInput(
        "SKILL.md must begin with valid YAML frontmatter delimited by --- lines (including a name or description).",
      );
    }
    const parsedFrontmatter = yield* Effect.try({
      try: () =>
        parseYamlDocument(frontmatterMatch[1] ?? "", {
          schema: "failsafe",
          customTags: ["null"],
        }) as unknown,
      catch: () =>
        new TeamOperationError({
          code: "invalid_input",
          message: "SKILL.md YAML frontmatter could not be parsed.",
        }),
    });
    if (typeof parsedFrontmatter !== "object" || parsedFrontmatter === null) {
      return yield* invalidInput("SKILL.md YAML frontmatter must be a key-value mapping.");
    }
    const frontmatterRecord = parsedFrontmatter as Record<string, unknown>;
    const name = typeof frontmatterRecord.name === "string" ? frontmatterRecord.name.trim() : "";
    const description =
      typeof frontmatterRecord.description === "string" ? frontmatterRecord.description.trim() : "";
    if (name.length === 0 && description.length === 0) {
      return yield* invalidInput(
        "SKILL.md YAML frontmatter must define at least a non-empty 'name' or 'description'.",
      );
    }

    const rawReferences = input.references ?? [];
    if (rawReferences.length > MAX_REFERENCE_FILES) {
      return yield* invalidInput(
        `A team skill may include at most ${MAX_REFERENCE_FILES} reference files.`,
      );
    }
    const seenPaths = new Set<string>();
    const normalizedReferences: Array<TeamSkillReference> = [];
    for (const ref of rawReferences) {
      const safePath = yield* normalizeAndValidateReferencePath(ref.path);
      const lowerPath = safePath.toLowerCase();
      if (seenPaths.has(lowerPath)) {
        return yield* invalidInput(`Duplicate skill reference path "${safePath}".`);
      }
      seenPaths.add(lowerPath);
      if (Buffer.byteLength(ref.content, "utf8") > MAX_REFERENCE_BYTES) {
        return yield* invalidInput(
          `Skill reference "${safePath}" exceeds the 256 KB maximum size.`,
        );
      }
      if (containsBinaryOrControlBytes(ref.content)) {
        return yield* invalidInput(
          `Skill reference "${safePath}" contains binary data; only pure text/Markdown files are allowed.`,
        );
      }
      if (FORBIDDEN_SHEBANG_PATTERN.test(ref.content.trimStart())) {
        return yield* invalidInput(
          `Skill reference "${safePath}" begins with an executable shebang (#!); executable scripts are forbidden in team skills.`,
        );
      }
      normalizedReferences.push({ path: safePath, content: ref.content });
    }
    normalizedReferences.sort((a, b) => a.path.localeCompare(b.path));

    const enabled = input.enabled ?? true;
    const contentHash = computeTeamSkillContentHash({
      slug,
      providerDriver: input.providerDriver,
      skillMd: input.skillMd,
      references: normalizedReferences,
      enabled,
    });
    return {
      slug,
      providerDriver: input.providerDriver,
      skillMd: input.skillMd,
      references: normalizedReferences,
      enabled,
      contentHash,
    };
  },
);

export const validateTeamPrepromptPayload = Effect.fn("TeamSkillValidation.validatePreprompt")(
  function* (input: {
    readonly name: string;
    readonly providerDriver: TeamAssetProviderDriver;
    readonly injectionScope?: TeamPrepromptInjectionScope;
    readonly content: string;
    readonly enabled?: boolean;
  }) {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 120) {
      return yield* invalidInput("Pre-prompt name must be between 1 and 120 characters.");
    }
    if (input.content.trim().length === 0) {
      return yield* invalidInput("Pre-prompt content cannot be empty.");
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_PREPROMPT_BYTES) {
      return yield* invalidInput("Pre-prompt content exceeds the 64 KB maximum size.");
    }
    if (containsBinaryOrControlBytes(input.content)) {
      return yield* invalidInput("Pre-prompt content must be valid UTF-8 text.");
    }
    const injectionScope: TeamPrepromptInjectionScope = input.injectionScope ?? "thread";
    const enabled = input.enabled ?? true;
    const contentHash = computeTeamPrepromptContentHash({
      name,
      providerDriver: input.providerDriver,
      injectionScope,
      content: input.content,
      enabled,
    });
    return {
      name,
      providerDriver: input.providerDriver,
      injectionScope,
      content: input.content,
      enabled,
      contentHash,
    };
  },
);

function computeTeamSkillContentHash(input: {
  readonly slug: string;
  readonly providerDriver: string;
  readonly skillMd: string;
  readonly references: ReadonlyArray<TeamSkillReference>;
  readonly enabled: boolean;
}): string {
  const canonical = JSON.stringify({
    slug: input.slug,
    providerDriver: input.providerDriver,
    skillMd: input.skillMd,
    references: [...input.references].sort((a, b) => a.path.localeCompare(b.path)),
    enabled: input.enabled,
  });
  return NodeCrypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function computeTeamPrepromptContentHash(input: {
  readonly name: string;
  readonly providerDriver: string;
  readonly injectionScope: TeamPrepromptInjectionScope;
  readonly content: string;
  readonly enabled: boolean;
}): string {
  const canonical = JSON.stringify({
    name: input.name,
    providerDriver: input.providerDriver,
    injectionScope: input.injectionScope,
    content: input.content,
    enabled: input.enabled,
  });
  return NodeCrypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}
