import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  SkillSearchInput,
  SkillSearchResult,
  SkillSource,
  SkillSummary,
} from "@t3tools/contracts";

const SKILL_CACHE_TTL_MS = 15_000;
const SKILL_CACHE_MAX_KEYS = 8;

interface SkillRoot {
  readonly rootPath: string;
  readonly source: SkillSource;
}

interface DiscoveredSkill extends SkillSummary {
  readonly priority: number;
  readonly order: number;
  readonly normalizedName: string;
  readonly normalizedDirectoryName: string;
  readonly normalizedDescription: string;
}

interface CachedSkillIndex {
  readonly discoveredAt: number;
  readonly skills: readonly DiscoveredSkill[];
}

const skillIndexCache = new Map<string, CachedSkillIndex>();
const inFlightSkillIndexBuilds = new Map<string, Promise<CachedSkillIndex>>();

function normalizeSkillToken(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSearchQuery(input: string): string {
  return input.trim().replace(/^\$+/, "").toLowerCase();
}

function cacheKeyForRoots(roots: readonly SkillRoot[]): string {
  return JSON.stringify(roots);
}

function touchCacheKey(key: string): void {
  const cached = skillIndexCache.get(key);
  if (!cached) {
    return;
  }
  skillIndexCache.delete(key);
  skillIndexCache.set(key, cached);
  while (skillIndexCache.size > SKILL_CACHE_MAX_KEYS) {
    const oldestKey = skillIndexCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    skillIndexCache.delete(oldestKey);
  }
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

async function statOrNull(targetPath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  const stat = await statOrNull(targetPath);
  return stat?.isDirectory() ?? false;
}

async function listChildDirectories(rootPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name))
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function collectCandidateSkillDirs(rootPath: string): Promise<string[]> {
  if (!(await isDirectory(rootPath))) {
    return [];
  }

  const topLevelDirectories = await listChildDirectories(rootPath);
  const nestedDirectories = await Promise.all(
    topLevelDirectories.map((directoryPath) => listChildDirectories(directoryPath)),
  );

  return [...topLevelDirectories, ...nestedDirectories.flat()];
}

function extractFrontmatterBlock(contents: string): string | null {
  if (!contents.startsWith("---")) {
    return null;
  }

  const normalizedContents = contents.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalizedContents);
  return match?.[1] ?? null;
}

function decodeYamlScalar(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (
    !trimmed ||
    trimmed === "|" ||
    trimmed === ">" ||
    trimmed === "[]" ||
    trimmed === "{}" ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    return null;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unquoted = trimmed.slice(1, -1);
    if (trimmed.startsWith('"')) {
      return (
        unquoted.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\n/g, "\n").trim() || null
      );
    }
    return unquoted.replace(/''/g, "'").trim() || null;
  }

  return trimmed;
}

function readFrontmatterField(frontmatter: string, field: "name" | "description"): string | null {
  for (const rawLine of frontmatter.split("\n")) {
    const match = new RegExp(`^${field}:[ \\t]*(.*)$`).exec(rawLine);
    if (!match) {
      continue;
    }
    return decodeYamlScalar(match[1] ?? "");
  }
  return null;
}

async function readSkillSummary(input: {
  skillDirPath: string;
  rootPath: string;
  source: SkillSource;
  priority: number;
  order: number;
}): Promise<DiscoveredSkill | null> {
  const skillPath = path.join(input.skillDirPath, "SKILL.md");
  const stat = await statOrNull(skillPath);
  if (!stat?.isFile()) {
    return null;
  }

  const fallbackName = path.basename(input.skillDirPath);
  const contents = await fs.readFile(skillPath, "utf8").catch(() => null);
  if (contents === null) {
    return null;
  }

  const frontmatter = extractFrontmatterBlock(contents);
  const parsedName = frontmatter ? readFrontmatterField(frontmatter, "name") : null;
  const parsedDescription = frontmatter ? readFrontmatterField(frontmatter, "description") : null;
  const name = normalizeSkillToken(parsedName?.trim() || fallbackName);

  return {
    name,
    ...(parsedDescription?.trim() ? { description: parsedDescription.trim() } : {}),
    skillPath,
    rootPath: input.rootPath,
    source: input.source,
    priority: input.priority,
    order: input.order,
    normalizedName: normalizeSkillToken(name),
    normalizedDirectoryName: normalizeSkillToken(fallbackName),
    normalizedDescription: normalizeSkillToken(parsedDescription ?? ""),
  };
}

async function discoverSkillsForRoot(
  root: SkillRoot,
  priority: number,
): Promise<DiscoveredSkill[]> {
  const candidateDirs = await collectCandidateSkillDirs(root.rootPath);
  const discovered = await Promise.all(
    candidateDirs.map((skillDirPath, index) =>
      readSkillSummary({
        skillDirPath,
        rootPath: root.rootPath,
        source: root.source,
        priority,
        order: priority * 10_000 + index,
      }),
    ),
  );

  return discovered.filter((skill): skill is DiscoveredSkill => skill !== null);
}

function dedupeSkills(skills: readonly DiscoveredSkill[]): DiscoveredSkill[] {
  const seen = new Set<string>();
  const deduped: DiscoveredSkill[] = [];

  for (const skill of skills) {
    if (!skill.normalizedName || seen.has(skill.normalizedName)) {
      continue;
    }
    seen.add(skill.normalizedName);
    deduped.push(skill);
  }

  return deduped;
}

async function buildSkillIndex(roots: readonly SkillRoot[]): Promise<CachedSkillIndex> {
  const discoveredByRoot = await Promise.all(
    roots.map((root, index) => discoverSkillsForRoot(root, index)),
  );

  return {
    discoveredAt: Date.now(),
    skills: dedupeSkills(discoveredByRoot.flat()),
  };
}

async function getCachedSkillIndex(roots: readonly SkillRoot[]): Promise<CachedSkillIndex> {
  const key = cacheKeyForRoots(roots);
  const cached = skillIndexCache.get(key);
  if (cached && Date.now() - cached.discoveredAt < SKILL_CACHE_TTL_MS) {
    touchCacheKey(key);
    return cached;
  }

  const inFlight = inFlightSkillIndexBuilds.get(key);
  if (inFlight) {
    return inFlight;
  }

  const build = buildSkillIndex(roots)
    .then((built) => {
      skillIndexCache.set(key, built);
      touchCacheKey(key);
      return built;
    })
    .finally(() => {
      inFlightSkillIndexBuilds.delete(key);
    });

  inFlightSkillIndexBuilds.set(key, build);
  return build;
}

function resolveSkillRoots(input: SkillSearchInput): SkillRoot[] {
  const orderedRoots: SkillRoot[] = [
    {
      rootPath: path.resolve(input.cwd, ".codex", "skills"),
      source: "workspace",
    },
    ...(input.extraRoots ?? []).map((rootPath) => ({
      rootPath: path.resolve(expandHomePath(rootPath)),
      source: "extra-root" as const,
    })),
    {
      rootPath: path.resolve(
        expandHomePath(input.codexHomePath?.trim().length ? input.codexHomePath : "~/.codex"),
        "skills",
      ),
      source: "codex-home",
    },
  ];

  const seenRoots = new Set<string>();
  const dedupedRoots: SkillRoot[] = [];

  for (const root of orderedRoots) {
    if (seenRoots.has(root.rootPath)) {
      continue;
    }
    seenRoots.add(root.rootPath);
    dedupedRoots.push(root);
  }

  return dedupedRoots;
}

function scoreSkill(skill: DiscoveredSkill, query: string): number {
  if (!query) return skill.priority * 10;
  if (skill.normalizedName === query) return skill.priority * 10;
  if (skill.normalizedName.startsWith(query)) return skill.priority * 10 + 1;
  if (skill.normalizedDirectoryName.startsWith(query)) return skill.priority * 10 + 2;
  if (skill.normalizedName.includes(query)) return skill.priority * 10 + 3;
  if (skill.normalizedDirectoryName.includes(query)) return skill.priority * 10 + 4;
  if (skill.normalizedDescription.includes(query)) return skill.priority * 10 + 5;
  return Number.POSITIVE_INFINITY;
}

export async function searchSkills(input: SkillSearchInput): Promise<SkillSearchResult> {
  const roots = resolveSkillRoots(input);
  const skillIndex = await getCachedSkillIndex(roots);
  const normalizedQuery = normalizeSearchQuery(input.query);

  const matchedSkills = skillIndex.skills
    .map((skill) => ({ skill, score: scoreSkill(skill, normalizedQuery) }))
    .filter((entry) => Number.isFinite(entry.score))
    .toSorted((left, right) => left.score - right.score || left.skill.order - right.skill.order)
    .map(({ skill }) => {
      if (skill.description) {
        return {
          name: skill.name,
          description: skill.description,
          skillPath: skill.skillPath,
          rootPath: skill.rootPath,
          source: skill.source,
        } satisfies SkillSummary;
      }
      return {
        name: skill.name,
        skillPath: skill.skillPath,
        rootPath: skill.rootPath,
        source: skill.source,
      } satisfies SkillSummary;
    });

  return {
    skills: matchedSkills.slice(0, input.limit),
    truncated: matchedSkills.length > input.limit,
  };
}
