/**
 * Cursor filesystem skill discovery and send-path apply.
 *
 * Cursor skills live as `skill-name/SKILL.md` under:
 * - Project: `<cwd>/.cursor/skills/`
 * - User: `~/.cursor/skills/`
 *
 * Do not scan `~/.cursor/skills-cursor/` (Cursor built-ins).
 *
 * Composer keeps Codex-style `$name` insert UX. Codex interprets `$name` itself;
 * Cursor ACP does not. On send, T3 expands matched `$skill` tokens by injecting
 * the skill's SKILL.md body into the ACP prompt text (Cursor-native `/name`
 * under ACP is not guaranteed, so content injection is the apply path).
 */

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SKILL_FILE_NAME = "SKILL.md";
const CURSOR_SKILLS_REL = NodePath.join(".cursor", "skills");

/** `$skill-name` mentions (Codex-style composer insert). */
const CURSOR_SKILL_MENTION_RE = /\$([a-z0-9]+(?:-[a-z0-9]+)*)\b/gi;

export interface CursorSkillRoots {
  readonly projectCwd?: string | null | undefined;
  readonly userHome?: string | null | undefined;
}

export interface DiscoveredCursorSkill {
  readonly name: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly content: string;
  readonly description?: string;
  readonly scope?: string;
  readonly displayName?: string;
  readonly shortDescription?: string;
}

export function resolveCursorSkillRoots(input: CursorSkillRoots = {}): {
  readonly projectSkillsDir: string | null;
  readonly userSkillsDir: string | null;
} {
  const projectCwd = input.projectCwd?.trim() || null;
  const userHome = (input.userHome ?? NodeOS.homedir()).trim() || null;
  return {
    projectSkillsDir: projectCwd ? NodePath.join(projectCwd, CURSOR_SKILLS_REL) : null,
    userSkillsDir: userHome ? NodePath.join(userHome, CURSOR_SKILLS_REL) : null,
  };
}

function normalizeSkillName(raw: string | undefined, fallbackDirName: string): string | null {
  const candidate = (raw?.trim() || fallbackDirName).trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) || candidate.length > 64) {
    return null;
  }
  return candidate;
}

function parseDescriptionField(frontmatter: string): string | undefined {
  const folded = frontmatter.match(/^description:\s*[>|]-?[ \t]*\r?\n((?:[ \t]+.+\r?\n?)*)/m);
  if (folded?.[1]) {
    const collapsed = folded[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^[ \t]+/, "").trim())
      .filter((line) => line.length > 0)
      .join(" ")
      .trim();
    return collapsed.length > 0 ? collapsed.slice(0, 1024) : undefined;
  }

  const single = frontmatter.match(/^description:\s*(?:>-?\s*)?(.+)$/m);
  if (!single?.[1]) {
    return undefined;
  }
  const value = single[1].trim().replace(/^['"]|['"]$/g, "");
  return value.length > 0 ? value.slice(0, 1024) : undefined;
}

export function parseCursorSkillMarkdown(
  raw: string,
  skillPath: string,
  directoryName: string,
  scope?: "user" | "repo",
): DiscoveredCursorSkill | null {
  const content = raw.replace(/^\uFEFF/, "");
  let frontmatter = "";

  if (content.startsWith("---")) {
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx !== -1) {
      frontmatter = content.slice(3, endIdx).replace(/^\r?\n/, "");
    }
  }

  const nameFromFm = frontmatter.match(/^name:\s*['"]?([a-z0-9-]+)['"]?\s*$/im)?.[1];
  const name = normalizeSkillName(nameFromFm, directoryName);
  if (!name) {
    return null;
  }

  const description = parseDescriptionField(frontmatter);
  return {
    name,
    path: skillPath,
    enabled: true,
    content: content.trim(),
    ...(scope ? { scope } : {}),
    ...(description
      ? {
          description,
          shortDescription:
            description.length > 160 ? `${description.slice(0, 157)}...` : description,
        }
      : {}),
  };
}

/**
 * Pure scan helper for tests — pass filesystem callbacks.
 */
export async function discoverCursorSkillsWithFs(
  roots: {
    readonly projectSkillsDir?: string | null;
    readonly userSkillsDir?: string | null;
  },
  fs: {
    readonly readFile: (path: string) => Promise<string | null>;
    readonly readDirectory: (path: string) => Promise<ReadonlyArray<string> | null>;
    readonly isDirectory: (path: string) => Promise<boolean>;
    readonly join: (...parts: string[]) => string;
  },
): Promise<ReadonlyArray<DiscoveredCursorSkill>> {
  const discovered: Array<DiscoveredCursorSkill> = [];
  const seenNames = new Set<string>();

  const scanRoot = async (skillsRoot: string | null | undefined, scope: "user" | "repo") => {
    if (!skillsRoot) {
      return;
    }
    const entries = await fs.readDirectory(skillsRoot);
    if (!entries) {
      return;
    }

    for (const entryName of entries) {
      if (entryName.startsWith(".")) {
        continue;
      }
      const skillDir = fs.join(skillsRoot, entryName);
      if (!(await fs.isDirectory(skillDir))) {
        continue;
      }
      const skillPath = fs.join(skillDir, SKILL_FILE_NAME);
      const raw = await fs.readFile(skillPath);
      if (raw === null) {
        continue;
      }
      const skill = parseCursorSkillMarkdown(raw, skillPath, entryName, scope);
      if (!skill || seenNames.has(skill.name)) {
        continue;
      }
      seenNames.add(skill.name);
      discovered.push(skill);
    }
  };

  // Project skills win over user skills on name collision.
  await scanRoot(roots.projectSkillsDir, "repo");
  await scanRoot(roots.userSkillsDir, "user");

  return discovered;
}

export function toServerProviderSkills(
  skills: ReadonlyArray<DiscoveredCursorSkill>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.map((skill) => ({
    name: skill.name,
    path: skill.path,
    enabled: skill.enabled,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.scope ? { scope: skill.scope } : {}),
    ...(skill.displayName ? { displayName: skill.displayName } : {}),
    ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
  }));
}

export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  input: CursorSkillRoots = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathApi = yield* Path.Path;
  const roots = resolveCursorSkillRoots(input);

  const readFile = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.map((value) => value as string | null),
      Effect.orElseSucceed(() => null),
    );

  const readDirectory = (dirPath: string) =>
    fileSystem.readDirectory(dirPath).pipe(
      Effect.map((entries) => entries as ReadonlyArray<string> | null),
      Effect.orElseSucceed(() => null),
    );

  const isDirectory = (dirPath: string) =>
    fileSystem.stat(dirPath).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const discovered: Array<DiscoveredCursorSkill> = [];
  const seenNames = new Set<string>();

  const scanRoot = (skillsRoot: string | null, scope: "user" | "repo") =>
    Effect.gen(function* () {
      if (!skillsRoot) {
        return;
      }
      const entries = yield* readDirectory(skillsRoot);
      if (!entries) {
        return;
      }
      for (const entryName of entries) {
        if (entryName.startsWith(".")) {
          continue;
        }
        const skillDir = pathApi.join(skillsRoot, entryName);
        if (!(yield* isDirectory(skillDir))) {
          continue;
        }
        const skillPath = pathApi.join(skillDir, SKILL_FILE_NAME);
        const raw = yield* readFile(skillPath);
        if (raw === null) {
          continue;
        }
        const skill = parseCursorSkillMarkdown(raw, skillPath, entryName, scope);
        if (!skill || seenNames.has(skill.name)) {
          continue;
        }
        seenNames.add(skill.name);
        discovered.push(skill);
      }
    });

  yield* scanRoot(roots.projectSkillsDir, "repo");
  yield* scanRoot(roots.userSkillsDir, "user");
  return discovered;
});

export function collectCursorSkillMentions(prompt: string): ReadonlyArray<string> {
  const names: Array<string> = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(CURSOR_SKILL_MENTION_RE)) {
    const name = match[1]?.toLowerCase();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function formatInjectedSkillBlock(skill: Pick<DiscoveredCursorSkill, "name" | "content">): string {
  return [
    `Skill \`${skill.name}\` (applied by T3 Code for Cursor ACP):`,
    "",
    skill.content.trim(),
  ].join("\n");
}

/**
 * Expand Codex-style `$skill` mentions into SKILL.md body injections.
 * Unknown mentions are left unchanged.
 */
export function applyCursorSkillMentions(
  prompt: string,
  skills: ReadonlyArray<Pick<DiscoveredCursorSkill, "name" | "content" | "enabled">>,
): string {
  if (!prompt.includes("$")) {
    return prompt;
  }

  const byName = new Map(
    skills
      .filter((skill) => skill.enabled !== false)
      .map((skill) => [skill.name.toLowerCase(), skill] as const),
  );
  if (byName.size === 0) {
    return prompt;
  }

  const mentioned = collectCursorSkillMentions(prompt);
  const applied: Array<Pick<DiscoveredCursorSkill, "name" | "content">> = [];
  for (const name of mentioned) {
    const skill = byName.get(name);
    if (skill) {
      applied.push(skill);
    }
  }
  if (applied.length === 0) {
    return prompt;
  }

  const appliedNames = new Set(applied.map((skill) => skill.name.toLowerCase()));
  const withoutMentions = prompt
    .replace(CURSOR_SKILL_MENTION_RE, (full, name: string) =>
      appliedNames.has(name.toLowerCase()) ? "" : full,
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const blocks = applied.map(formatInjectedSkillBlock).join("\n\n---\n\n");
  if (!withoutMentions) {
    return blocks;
  }
  return `${blocks}\n\n---\n\n${withoutMentions}`;
}
