/**
 * SkillsManager - Service for listing, toggling, searching, installing, and
 * uninstalling agent skills.
 *
 * Skills are installed globally at `~/.agents/skills/<name>/` and enabled per
 * platform via `[[skills.config]]` entries in each platform's config file
 * (e.g. `~/.codex/config.toml`).
 *
 * @module SkillsManager
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  SkillMetadata,
  SkillsListResult,
  SkillsToggleInput,
  SkillsToggleResult,
  SkillsSearchInput,
  SkillsSearchResult,
  SkillSearchResultEntry,
  SkillsInstallInput,
  SkillsInstallResult,
  SkillsUninstallInput,
  SkillsUninstallResult,
  SkillsReadContentInput,
  SkillsReadContentResult,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import { runProcess } from "../processRunner";

// ── Error ────────────────────────────────────────────────────────────

export class SkillsError extends Schema.TaggedErrorClass<SkillsError>()("SkillsError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// ── Service Interface ────────────────────────────────────────────────

export interface SkillsManagerShape {
  readonly list: Effect.Effect<SkillsListResult, SkillsError>;
  readonly toggle: (input: SkillsToggleInput) => Effect.Effect<SkillsToggleResult, SkillsError>;
  readonly search: (input: SkillsSearchInput) => Effect.Effect<SkillsSearchResult, SkillsError>;
  readonly install: (input: SkillsInstallInput) => Effect.Effect<SkillsInstallResult, SkillsError>;
  readonly uninstall: (input: SkillsUninstallInput) => Effect.Effect<SkillsUninstallResult, SkillsError>;
  readonly readContent: (input: SkillsReadContentInput) => Effect.Effect<SkillsReadContentResult, SkillsError>;
}

export class SkillsManager extends ServiceMap.Service<SkillsManager, SkillsManagerShape>()(
  "t3/skills/SkillsManager",
) {}

// ── Platform configuration ──────────────────────────────────────────
//
// Each entry maps a display name to:
//   - `cliFlag`: the value passed to `npx skills add -a <flag>`
//   - `configPath`: the platform's config file (TOML) where
//     `[[skills.config]]` entries control enabled/disabled state
//
// To add a new platform (ex. Claude Code), append an entry here.

const home = os.homedir();

interface SkillsPlatform {
  readonly name: string;
  readonly cliFlag: string;
  readonly configPath: string;
}

const SKILLS_PLATFORMS: readonly SkillsPlatform[] = [
  { name: "Codex", cliFlag: "codex", configPath: path.join(home, ".codex", "config.toml") },
];

// ── Helpers ──────────────────────────────────────────────────────────

const AGENTS_SKILLS_DIR = path.join(home, ".agents", "skills");

const VALID_SKILL_SLUG = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function assertValidSkillSlug(name: string): void {
  if (!VALID_SKILL_SLUG.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

function stripQuotes(s: string): string {
  return (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))
    ? s.slice(1, -1)
    : s;
}

/** Extract `name` and `description` from SKILL.md YAML frontmatter. */
function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "" };

  const frontmatter = match[1]!;
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  const rawName = nameMatch?.[1]?.trim() ?? "";
  const rawDesc = descMatch?.[1]?.trim() ?? "";

  return {
    name: stripQuotes(rawName),
    description: stripQuotes(rawDesc),
  };
}

/**
 * Resolve the SKILL.md path for a skill directory, trying SKILL.md then skill.md.
 * Returns the absolute path or undefined if neither exists.
 */
function resolveSkillMdPath(skillDir: string): string | undefined {
  for (const filename of ["SKILL.md", "skill.md"]) {
    const p = path.join(skillDir, filename);
    try {
      fs.accessSync(p);
      return p;
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * Parse all `[[skills.config]]` entries from a TOML config file.
 * Returns a map of SKILL.md path → enabled boolean.
 *
 * We parse only `[[skills.config]]` blocks without a full TOML parser
 * because the format is simple and predictable.
 */
function readSkillsConfigEntries(configPath: string): Map<string, boolean> {
  const entries = new Map<string, boolean>();
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    return entries;
  }

  // Match each [[skills.config]] block: grab text until the next [[...]] header or EOF.
  const blockRe = /^\[\[skills\.config\]\]\s*\n((?:(?!\[).*\n?)*)/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(content)) !== null) {
    const block = m[1]!;
    const pathMatch = block.match(/^path\s*=\s*"(.+?)"/m);
    const enabledMatch = block.match(/^enabled\s*=\s*(true|false)/m);
    if (pathMatch) {
      // Unescape TOML basic string sequences relevant to file paths
      const unescapedPath = pathMatch[1]!.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
      entries.set(unescapedPath, enabledMatch ? enabledMatch[1] === "true" : true);
    }
  }
  return entries;
}

/**
 * Write/update a `[[skills.config]]` entry in a TOML config file.
 * If `enabled` is true, removes any existing disabled entry.
 * If `enabled` is false, adds or updates the entry with `enabled = false`.
 */
async function writeSkillConfigEntry(
  configPath: string,
  skillMdPath: string,
  enabled: boolean,
): Promise<void> {
  let content: string;
  try {
    content = await fsp.readFile(configPath, "utf-8");
  } catch {
    content = "";
  }

  // Build a regex that matches the full [[skills.config]] block for this specific path.
  // The block ends at the next [[...]] header, a blank line followed by a non-indented key, or EOF.
  const escapedPath = skillMdPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entryRe = new RegExp(
    `\\[\\[skills\\.config\\]\\]\\s*\\npath\\s*=\\s*"${escapedPath}"\\s*\\nenabled\\s*=\\s*(?:true|false)\\s*\\n?`,
    "g",
  );

  // Remove any existing entry for this path
  const cleaned = content.replace(entryRe, "");

  if (enabled) {
    // Just remove the disabled entry — skill is enabled by default
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, cleaned);
  } else {
    // Append a disabled entry
    const entry = `\n[[skills.config]]\npath = "${skillMdPath}"\nenabled = false\n`;
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, cleaned + entry);
  }
}

/** Check which configured platforms have this skill enabled. */
function resolveSkillAgents(skillName: string): string[] {
  const skillDir = path.join(AGENTS_SKILLS_DIR, skillName);
  const skillMdPath = resolveSkillMdPath(skillDir);
  if (!skillMdPath) return [];

  const agents: string[] = [];
  for (const platform of SKILLS_PLATFORMS) {
    const entries = readSkillsConfigEntries(platform.configPath);
    // Skill is enabled unless explicitly disabled in the config
    const entry = entries.get(skillMdPath);
    if (entry !== false) {
      agents.push(platform.name);
    }
  }
  return agents;
}

/** Run a CLI command and return stdout. */
function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Effect.Effect<string, SkillsError> {
  return Effect.tryPromise({
    try: () => runProcess(command, args, { timeoutMs }).then((r) => r.stdout),
    catch: (cause) =>
      new SkillsError({ message: `Command failed: ${command} ${args.join(" ")}`, cause }),
  });
}

/** Read all installed skills from ~/.agents/skills/ */
function listSkills(): Effect.Effect<SkillsListResult, SkillsError> {
  return Effect.tryPromise({
    try: async () => {
      const skills: SkillMetadata[] = [];

      let dirEntries: fs.Dirent[];
      try {
        dirEntries = await fsp.readdir(AGENTS_SKILLS_DIR, { withFileTypes: true });
      } catch {
        return { skills } satisfies SkillsListResult;
      }

      for (const entry of dirEntries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

        const skillDir = path.join(AGENTS_SKILLS_DIR, entry.name);
        const skillMdPath = resolveSkillMdPath(skillDir);

        let content = "";
        if (skillMdPath) {
          try {
            content = fs.readFileSync(skillMdPath, "utf-8");
          } catch {
            // Couldn't read SKILL.md
          }
        }

        const { description } = parseSkillFrontmatter(content);

        // Skill is enabled unless explicitly disabled in a platform config.
        const agents = resolveSkillAgents(entry.name);
        const enabled = agents.length > 0;

        skills.push({
          name: entry.name,
          description,
          enabled,
          agents,
        });
      }

      skills.sort((a, b) => a.name.localeCompare(b.name));
      return { skills } satisfies SkillsListResult;
    },
    catch: (cause) =>
      new SkillsError({ message: `Failed to list skills`, cause }),
  });
}

/** Toggle a skill on or off for all configured platforms via config.toml. */
function toggleSkill(input: SkillsToggleInput): Effect.Effect<SkillsToggleResult, SkillsError> {
  return Effect.tryPromise({
    try: async () => {
      assertValidSkillSlug(input.skillName);
      const skillDir = path.join(AGENTS_SKILLS_DIR, input.skillName);
      const skillMdPath = resolveSkillMdPath(skillDir);
      if (!skillMdPath) {
        throw new Error(`No SKILL.md found for ${input.skillName}`);
      }

      for (const platform of SKILLS_PLATFORMS) {
        await writeSkillConfigEntry(platform.configPath, skillMdPath, input.enabled);
      }

      return { skillName: input.skillName, enabled: input.enabled } satisfies SkillsToggleResult;
    },
    catch: (cause) =>
      new SkillsError({ message: `Failed to toggle skill: ${input.skillName}`, cause }),
  });
}

/** Search skills.sh registry via HTTP API. */
function searchSkills(input: SkillsSearchInput): Effect.Effect<SkillsSearchResult, SkillsError> {
  return Effect.tryPromise({
    try: async () => {
      const url = `https://skills.sh/api/search?q=${encodeURIComponent(input.query)}&limit=10`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`skills.sh API returned ${res.status}`);
      const data = (await res.json()) as {
        skills: Array<{ id: string; name: string; installs: number; source: string }>;
      };
      const skills: SkillSearchResultEntry[] = data.skills.map((s) => ({
        name: s.name,
        source: s.source,
        installs: `${s.installs} installs`,
        url: `https://skills.sh/${s.id}`,
      }));
      return { skills } satisfies SkillsSearchResult;
    },
    catch: (cause) =>
      new SkillsError({ message: `Failed to search skills.sh`, cause }),
  });
}

/** Install a skill from skills.sh for all configured platforms. */
function installSkill(input: SkillsInstallInput): Effect.Effect<SkillsInstallResult, SkillsError> {
  const agentFlags = SKILLS_PLATFORMS.flatMap((p) => ["-a", p.cliFlag]);
  return runCommand(
    "npx",
    ["skills", "add", input.source, "-s", input.skillName, "-g", ...agentFlags, "-y"],
    120_000,
  ).pipe(
    Effect.map(() => ({
      success: true,
      message: `Successfully installed ${input.skillName}`,
    }) satisfies SkillsInstallResult),
    Effect.catch((error: SkillsError) =>
      Effect.succeed({
        success: false,
        message: error.message,
      } satisfies SkillsInstallResult),
    ),
  );
}

/** Uninstall a skill globally. */
function uninstallSkill(input: SkillsUninstallInput): Effect.Effect<SkillsUninstallResult, SkillsError> {
  return runCommand(
    "npx",
    ["skills", "remove", input.skillName, "-g", "-y"],
    120_000,
  ).pipe(
    Effect.map(() => ({
      success: true,
      message: `Successfully uninstalled ${input.skillName}`,
    }) satisfies SkillsUninstallResult),
    Effect.catch((error: SkillsError) =>
      Effect.succeed({
        success: false,
        message: error.message,
      } satisfies SkillsUninstallResult),
    ),
  );
}

/** Read the full SKILL.md content (stripping YAML frontmatter) for a given skill. */
function readContent(input: SkillsReadContentInput): Effect.Effect<SkillsReadContentResult, SkillsError> {
  return Effect.tryPromise({
    try: async () => {
      assertValidSkillSlug(input.skillName);
      const skillDir = path.join(AGENTS_SKILLS_DIR, input.skillName);
      const skillMdPath = resolveSkillMdPath(skillDir);
      if (!skillMdPath) {
        throw new Error(`No SKILL.md found for ${input.skillName}`);
      }

      const raw = await fsp.readFile(skillMdPath, "utf-8");

      // Strip YAML frontmatter (everything between opening and closing ---)
      const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();

      return { skillName: input.skillName, content } satisfies SkillsReadContentResult;
    },
    catch: (cause) =>
      new SkillsError({ message: `Failed to read skill content: ${input.skillName}`, cause }),
  });
}

// ── Live Layer ───────────────────────────────────────────────────────

export const SkillsManagerLive = Layer.succeed(SkillsManager, {
  list: listSkills(),
  toggle: toggleSkill,
  search: searchSkills,
  install: installSkill,
  uninstall: uninstallSkill,
  readContent,
});
