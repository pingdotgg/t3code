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
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SKILL_FILE_NAME = "SKILL.md";
const CURSOR_SKILLS_REL = NodePath.join(".cursor", "skills");

/**
 * Max UTF-8 bytes for a skill body stored/injected after frontmatter strip.
 * Keeps ACP prompts bounded if a skill file is accidentally huge.
 */
export const MAX_CURSOR_SKILL_CONTENT_BYTES = 64 * 1024;

/**
 * `$skill-name` mentions (Codex-style composer insert).
 * Leading lookbehind rejects mid-token / assignment forms like `ENV=$skill`
 * and `pre$skill` (must not be preceded by ident or `=`).
 */
const CURSOR_SKILL_MENTION_RE = /(?<![A-Za-z0-9_=-])\$([a-z0-9]+(?:-[a-z0-9]+)*)\b/gi;

export interface CursorSkillRoots {
  /**
   * Primary project cwd (session/thread cwd on send-apply).
   * Scanned first so worktree-local skills win on name collision.
   */
  readonly projectCwd?: string | null | undefined;
  /**
   * Extra project roots scanned after `projectCwd`.
   * Send-apply passes `ServerConfig.cwd` here so `$` menu skills (provider
   * snapshot, process-wide) still resolve when session cwd diverges
   * (worktree/thread). Deduped against `projectCwd` after path resolve.
   */
  readonly additionalProjectCwds?: ReadonlyArray<string | null | undefined>;
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

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

/** Strip leading YAML frontmatter; returns body only (trimmed). */
export function stripYamlFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return normalized.trim();
  }
  const endIdx = normalized.indexOf("\n---", 3);
  if (endIdx === -1) {
    return normalized.trim();
  }
  let bodyStart = endIdx + "\n---".length;
  if (normalized[bodyStart] === "\r") {
    bodyStart += 1;
  }
  if (normalized[bodyStart] === "\n") {
    bodyStart += 1;
  }
  return normalized.slice(bodyStart).trim();
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Body suitable for injection, or null when over the size cap. */
export function skillBodyForInjection(content: string): string | null {
  const body = stripYamlFrontmatter(content);
  if (utf8ByteLength(body) > MAX_CURSOR_SKILL_CONTENT_BYTES) {
    return null;
  }
  return body;
}

function normalizeProjectCwds(
  primary: string | null | undefined,
  additional: ReadonlyArray<string | null | undefined> | undefined,
): ReadonlyArray<string> {
  const out: Array<string> = [];
  const seen = new Set<string>();
  for (const raw of [primary, ...(additional ?? [])]) {
    const trimmed = raw?.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = NodePath.resolve(trimmed);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function resolveCursorSkillRoots(input: CursorSkillRoots = {}): {
  /** Ordered project skill dirs (primary first). Empty when no project cwd. */
  readonly projectSkillsDirs: ReadonlyArray<string>;
  readonly userSkillsDir: string | null;
} {
  const projectCwds = normalizeProjectCwds(input.projectCwd, input.additionalProjectCwds);
  const userHome = (input.userHome ?? NodeOS.homedir()).trim() || null;
  return {
    projectSkillsDirs: projectCwds.map((cwd) => NodePath.join(cwd, CURSOR_SKILLS_REL)),
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
  let body = content;

  if (content.startsWith("---")) {
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx !== -1) {
      frontmatter = content.slice(3, endIdx).replace(/^\r?\n/, "");
      body = stripYamlFrontmatter(content);
    }
  } else {
    body = content.trim();
  }

  const nameFromFm = frontmatter.match(/^name:\s*['"]?([a-z0-9-]+)['"]?\s*$/im)?.[1];
  const name = normalizeSkillName(nameFromFm, directoryName);
  if (!name) {
    return null;
  }

  if (utf8ByteLength(body) > MAX_CURSOR_SKILL_CONTENT_BYTES) {
    return null;
  }

  const description = parseDescriptionField(frontmatter);
  return {
    name,
    path: skillPath,
    enabled: true,
    content: body,
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

export type CursorSkillDiscoveryFs = {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly readDirectory: (path: string) => Promise<ReadonlyArray<string> | null>;
  readonly isDirectory: (path: string) => Promise<boolean>;
  readonly join: (...parts: string[]) => string;
  /** Canonicalize path; return null when the path cannot be resolved. */
  readonly realPath?: (path: string) => Promise<string | null>;
  /** `lstat`-based regular-file check (rejects symlinks). Defaults to true. */
  readonly lstatIsRegularFile?: (path: string) => Promise<boolean>;
};

/**
 * Pure scan helper for tests — pass filesystem callbacks.
 */
export async function discoverCursorSkillsWithFs(
  roots: {
    readonly projectSkillsDirs?: ReadonlyArray<string | null | undefined>;
    /** @deprecated Prefer `projectSkillsDirs`. Kept for call-site convenience. */
    readonly projectSkillsDir?: string | null;
    readonly userSkillsDir?: string | null;
  },
  fs: CursorSkillDiscoveryFs,
): Promise<ReadonlyArray<DiscoveredCursorSkill>> {
  const discovered: Array<DiscoveredCursorSkill> = [];
  const seenNames = new Set<string>();
  const realPath = fs.realPath ?? (async (path: string) => path);
  const lstatIsRegularFile = fs.lstatIsRegularFile ?? (async () => true);

  const scanRoot = async (skillsRoot: string | null | undefined, scope: "user" | "repo") => {
    if (!skillsRoot) {
      return;
    }
    const realSkillsRoot = await realPath(skillsRoot);
    if (!realSkillsRoot) {
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
      const realSkillDir = await realPath(skillDir);
      if (!realSkillDir || !isPathInsideRoot(realSkillsRoot, realSkillDir)) {
        continue;
      }
      const skillPath = fs.join(skillDir, SKILL_FILE_NAME);
      if (!(await lstatIsRegularFile(skillPath))) {
        continue;
      }
      const realSkillPath = await realPath(skillPath);
      if (!realSkillPath || !isPathInsideRoot(realSkillsRoot, realSkillPath)) {
        continue;
      }
      const raw = await fs.readFile(realSkillPath);
      if (raw === null) {
        continue;
      }
      const skill = parseCursorSkillMarkdown(raw, realSkillPath, entryName, scope);
      if (!skill || seenNames.has(skill.name)) {
        continue;
      }
      seenNames.add(skill.name);
      discovered.push(skill);
    }
  };

  const projectDirs = [
    ...(roots.projectSkillsDirs ?? []),
    ...(roots.projectSkillsDir ? [roots.projectSkillsDir] : []),
  ];
  // Earlier project roots win on name collision; project wins over user.
  for (const projectDir of projectDirs) {
    await scanRoot(projectDir, "repo");
  }
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

  const realPath = (filePath: string) =>
    fileSystem.realPath(filePath).pipe(Effect.orElseSucceed(() => null as string | null));

  const lstatIsRegularFile = (filePath: string) =>
    Effect.promise(() =>
      NodeFS.lstat(filePath)
        .then((stat) => stat.isFile())
        .catch(() => false),
    );

  const discovered: Array<DiscoveredCursorSkill> = [];
  const seenNames = new Set<string>();

  const scanRoot = (skillsRoot: string | null, scope: "user" | "repo") =>
    Effect.gen(function* () {
      if (!skillsRoot) {
        return;
      }
      const realSkillsRoot = yield* realPath(skillsRoot);
      if (!realSkillsRoot) {
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
        const realSkillDir = yield* realPath(skillDir);
        if (!realSkillDir || !isPathInsideRoot(realSkillsRoot, realSkillDir)) {
          continue;
        }
        const skillPath = pathApi.join(skillDir, SKILL_FILE_NAME);
        if (!(yield* lstatIsRegularFile(skillPath))) {
          continue;
        }
        const realSkillPath = yield* realPath(skillPath);
        if (!realSkillPath || !isPathInsideRoot(realSkillsRoot, realSkillPath)) {
          continue;
        }
        const raw = yield* readFile(realSkillPath);
        if (raw === null) {
          continue;
        }
        const skill = parseCursorSkillMarkdown(raw, realSkillPath, entryName, scope);
        if (!skill || seenNames.has(skill.name)) {
          continue;
        }
        seenNames.add(skill.name);
        discovered.push(skill);
      }
    });

  for (const projectDir of roots.projectSkillsDirs) {
    yield* scanRoot(projectDir, "repo");
  }
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
  const body = skillBodyForInjection(skill.content) ?? "";
  return [`Skill \`${skill.name}\` (applied by T3 Code for Cursor ACP):`, "", body].join("\n");
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
    if (!skill) {
      continue;
    }
    const body = skillBodyForInjection(skill.content);
    if (body === null) {
      continue;
    }
    applied.push({ name: skill.name, content: body });
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
