import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import { Effect } from "effect";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

export type SkillInvocationPrefix = "$" | "/";

interface SkillRoot {
  readonly path: string;
  readonly scope: string;
}

interface SkillDiscoveryInput {
  readonly cwd: string;
  readonly homeDir?: string | undefined;
}

interface DiscoverSkillsFromRootsInput {
  readonly roots: ReadonlyArray<SkillRoot>;
  readonly invocationPrefix: SkillInvocationPrefix;
}

const DESCRIPTION_MAX_CHARS = 1024;
const NAME_MAX_CHARS = 64;

function normalizeDedupePath(pathValue: string): string {
  const resolved = nodePath.resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeSkillName(raw: string | undefined, fallback: string): string {
  const candidate = (raw ?? fallback).trim();
  if (!candidate) {
    return fallback.trim();
  }
  return candidate.slice(0, NAME_MAX_CHARS);
}

function normalizeOptionalText(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateDescription(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= DESCRIPTION_MAX_CHARS
    ? normalized
    : normalized.slice(0, DESCRIPTION_MAX_CHARS).trimEnd();
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseFrontmatter(raw: string): {
  readonly metadata: Readonly<Record<string, string | boolean>>;
  readonly body: string;
} {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return { metadata: {}, body: raw };
  }

  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { metadata: {}, body: raw };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) {
    return { metadata: {}, body: raw };
  }

  const metadata: Record<string, string | boolean> = {};
  for (const line of lines.slice(1, endIndex)) {
    if (!line.trim() || /^\s/.test(line)) {
      continue;
    }

    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1]?.trim();
    const rawValue = match[2] ?? "";
    if (!key || !rawValue.trim()) {
      continue;
    }

    const value = stripYamlQuotes(rawValue);
    const booleanValue = parseBoolean(value);
    metadata[key] = booleanValue ?? value;
  }

  return {
    metadata,
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

function firstBodyParagraph(body: string): string | undefined {
  const paragraphs = body
    .split(/\n\s*\n/g)
    .map((paragraph) =>
      paragraph
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return paragraphs.find(
    (paragraph) =>
      !paragraph.startsWith("#") &&
      !paragraph.startsWith("```") &&
      !paragraph.startsWith("!") &&
      !paragraph.startsWith("---"),
  );
}

function firstSentence(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(.+?[.!?])(?:\s|$)/.exec(value);
  return (match?.[1] ?? value).trim();
}

function isUserInvocable(metadata: Readonly<Record<string, string | boolean>>): boolean {
  const userInvocable = metadata["user-invocable"];
  if (typeof userInvocable === "boolean") {
    return userInvocable;
  }
  if (typeof userInvocable === "string") {
    return parseBoolean(userInvocable) ?? true;
  }
  const enabled = metadata.enabled;
  if (typeof enabled === "boolean") {
    return enabled;
  }
  if (typeof enabled === "string") {
    return parseBoolean(enabled) ?? true;
  }
  return true;
}

export function parseSkillMarkdown(input: {
  readonly path: string;
  readonly contents: string;
  readonly scope: string;
  readonly invocationPrefix: SkillInvocationPrefix;
}): ServerProviderSkill | undefined {
  const { metadata, body } = parseFrontmatter(input.contents);
  const directoryName = nodePath.basename(nodePath.dirname(input.path));
  const name = normalizeSkillName(normalizeOptionalText(metadata.name), directoryName);
  if (!name) {
    return undefined;
  }

  const description = truncateDescription(
    normalizeOptionalText(metadata.description) ?? firstBodyParagraph(body),
  );
  const shortDescription = truncateDescription(
    normalizeOptionalText(metadata.short_description) ??
      normalizeOptionalText(metadata.shortDescription) ??
      firstSentence(description),
  );
  const displayName =
    normalizeOptionalText(metadata.display_name) ??
    normalizeOptionalText(metadata.displayName) ??
    name;

  return {
    name,
    path: input.path,
    scope: input.scope,
    enabled: isUserInvocable(metadata),
    invocationPrefix: input.invocationPrefix,
    ...(description ? { description } : {}),
    ...(shortDescription ? { shortDescription } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await nodeFs.stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function projectSkillSearchDirs(cwd: string): Promise<ReadonlyArray<string>> {
  const start = nodePath.resolve(cwd);
  const dirs: string[] = [];
  let current = start;
  while (true) {
    dirs.push(current);
    if (await pathExists(nodePath.join(current, ".git"))) {
      return dirs;
    }
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return [start];
    }
    current = parent;
  }
}

function dedupeRoots(roots: ReadonlyArray<SkillRoot>): ReadonlyArray<SkillRoot> {
  const seen = new Set<string>();
  const deduped: SkillRoot[] = [];
  for (const root of roots) {
    const key = normalizeDedupePath(root.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(root);
  }
  return deduped;
}

async function listSkillFiles(
  root: SkillRoot,
): Promise<ReadonlyArray<SkillRoot & { filePath: string }>> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = await nodeFs.readdir(root.path, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({
      path: root.path,
      scope: root.scope,
      filePath: nodePath.join(root.path, entry.name, "SKILL.md"),
    }));
}

async function readSkill(input: {
  readonly filePath: string;
  readonly scope: string;
  readonly invocationPrefix: SkillInvocationPrefix;
}): Promise<ServerProviderSkill | undefined> {
  try {
    const contents = await nodeFs.readFile(input.filePath, "utf8");
    return parseSkillMarkdown({
      path: nodePath.resolve(input.filePath),
      contents,
      scope: input.scope,
      invocationPrefix: input.invocationPrefix,
    });
  } catch {
    return undefined;
  }
}

async function discoverSkillsFromRootsPromise(
  input: DiscoverSkillsFromRootsInput,
): Promise<ReadonlyArray<ServerProviderSkill>> {
  const files = (
    await Promise.all(dedupeRoots(input.roots).map((root) => listSkillFiles(root)))
  ).flat();
  const skills = await Promise.all(
    files.map((file) =>
      readSkill({
        filePath: file.filePath,
        scope: file.scope,
        invocationPrefix: input.invocationPrefix,
      }),
    ),
  );
  return skills.filter((skill): skill is ServerProviderSkill => skill !== undefined);
}

export const discoverSkillsFromRoots = (
  input: DiscoverSkillsFromRootsInput,
): Effect.Effect<ReadonlyArray<ServerProviderSkill>> =>
  Effect.tryPromise({
    try: () => discoverSkillsFromRootsPromise(input),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed([])));

async function claudeProjectRoots(cwd: string): Promise<ReadonlyArray<SkillRoot>> {
  const dirs = await projectSkillSearchDirs(cwd);
  return dirs.map((dir) => ({ path: nodePath.join(dir, ".claude", "skills"), scope: "project" }));
}

function claudeUserRoots(homeDir: string): ReadonlyArray<SkillRoot> {
  return [{ path: nodePath.join(homeDir, ".claude", "skills"), scope: "user" }];
}

async function openCodeProjectRoots(cwd: string): Promise<ReadonlyArray<SkillRoot>> {
  const dirs = await projectSkillSearchDirs(cwd);
  return dirs.flatMap((dir) => [
    { path: nodePath.join(dir, ".opencode", "skills"), scope: "project" },
    { path: nodePath.join(dir, ".claude", "skills"), scope: "project" },
    { path: nodePath.join(dir, ".agents", "skills"), scope: "project" },
  ]);
}

function openCodeUserRoots(homeDir: string): ReadonlyArray<SkillRoot> {
  return [
    { path: nodePath.join(homeDir, ".config", "opencode", "skills"), scope: "user" },
    { path: nodePath.join(homeDir, ".opencode", "skills"), scope: "user" },
    { path: nodePath.join(homeDir, ".claude", "skills"), scope: "user" },
    { path: nodePath.join(homeDir, ".agents", "skills"), scope: "user" },
  ];
}

function resolveHomeDir(input: SkillDiscoveryInput): string {
  return input.homeDir?.trim() || nodeOs.homedir();
}

export const discoverClaudeSkills = (
  input: SkillDiscoveryInput,
): Effect.Effect<ReadonlyArray<ServerProviderSkill>> =>
  Effect.tryPromise({
    try: async () => {
      const homeDir = resolveHomeDir(input);
      return discoverSkillsFromRootsPromise({
        roots: [...claudeUserRoots(homeDir), ...(await claudeProjectRoots(input.cwd))],
        invocationPrefix: "/",
      });
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed([])));

export const discoverOpenCodeSkills = (
  input: SkillDiscoveryInput,
): Effect.Effect<ReadonlyArray<ServerProviderSkill>> =>
  Effect.tryPromise({
    try: async () => {
      const homeDir = resolveHomeDir(input);
      return discoverSkillsFromRootsPromise({
        roots: [...(await openCodeProjectRoots(input.cwd)), ...openCodeUserRoots(homeDir)],
        invocationPrefix: "$",
      });
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed([])));

export function mergeProviderSkills(
  primary: ReadonlyArray<ServerProviderSkill>,
  secondary: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const byPath = new Set<string>();
  const byNameAndScope = new Set<string>();
  const merged: ServerProviderSkill[] = [];

  for (const skill of [...primary, ...secondary]) {
    const pathKey = normalizeDedupePath(skill.path);
    const nameScopeKey = `${skill.name.toLowerCase()}\u0000${(skill.scope ?? "").toLowerCase()}`;
    if (byPath.has(pathKey) || byNameAndScope.has(nameScopeKey)) {
      continue;
    }
    byPath.add(pathKey);
    byNameAndScope.add(nameScopeKey);
    merged.push(skill);
  }

  return merged;
}

export function mergeSkillsIntoSlashCommands(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();
  for (const command of slashCommands) {
    byName.set(command.name.toLowerCase(), command);
  }
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (byName.has(key) || skill.enabled === false) {
      continue;
    }
    byName.set(key, {
      name: skill.name,
      ...((skill.shortDescription ?? skill.description)
        ? { description: skill.shortDescription ?? skill.description }
        : {}),
    });
  }
  return [...byName.values()];
}
