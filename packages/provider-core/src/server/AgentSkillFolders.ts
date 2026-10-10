/**
 * AgentSkillFolders - the folders each agent reads skills from.
 *
 * One table, shared by the Skills page and the provider skill scanners that read the folders
 * themselves (Claude, Cursor, Antigravity), so a folder is defined once. Paths are relative to
 * the user's home or to the project root. Each agent's list is in the order it looks.
 *
 * Agents differ on two skills sharing a name (`SkillCollision`), so each entry records which:
 * - `first-wins`: only the first copy in the agent's order loads. Claude, Cursor and Antigravity,
 *   as T3 Code's own scanners model them: `ClaudeSkills.ts` ("First root wins"), provider-cursor's
 *   `skills.ts` (`if (!skillsByName.has(skill.name))`) and `AntigravitySkills.ts` ("The first
 *   valid same-name skill wins"). Pi too: https://github.com/earendil-works/pi/blob/43d3763991/packages/coding-agent/src/core/skills.ts
 *   (`addSkills` keeps the existing skill and reports a collision), over the order of
 *   `resourcePrecedenceRank` in `package-manager.ts`: project folders before user folders.
 * - `all`: every copy loads. Codex removes duplicate roots by path and never by name, and the
 *   plain name `$skill` selects the first of them while a skill picked by path is always its own:
 *   `dedupe_skill_roots_by_path` in host_roots.rs, the test
 *   `resolved_config_and_repo_roots_preserve_order_and_dedupe_paths_not_names`, and
 *   `collect_explicit_skill_mentions` in selection.rs (https://github.com/openai/codex/tree/8e23d1836f/codex-rs/ext/skills/src).
 *   OpenCode and Grok are listed as `all` because the evidence doesn't give a first-wins rule:
 *   OpenCode keeps one copy per name but overwrites in an order that isn't fixed (`add` in
 *   skill/index.ts logs "duplicate skill name" and assigns, while the files load concurrently),
 *   and Grok's skills page says nothing about duplicates. Claiming `all` never tells a user an
 *   agent can't use a skill it might load.
 *
 * Codex, Grok, OpenCode and Pi have no scanner here: their skills reach T3 Code through the
 * agent itself. Their folders follow the agent's documentation and source:
 * - Codex: https://developers.openai.com/codex/skills and
 *   https://github.com/openai/codex/blob/8e23d1836f/codex-rs/ext/skills/src/host_roots.rs
 *   (`~/.codex/skills` is the deprecated user location; a project's `.codex` folder is read too).
 * - Grok: https://docs.x.ai/build/features/skills-plugins-marketplaces.md (`.grok/skills`,
 *   `~/.grok/skills`, and `~/.agents/skills` under "Agents.md compatibility"). It also reads
 *   Claude Code skills, but the docs don't say which folders, so none are listed.
 * - OpenCode: https://opencode.ai/docs/skills/ and
 *   https://github.com/anomalyco/opencode/blob/4ac0d9c3d1/packages/opencode/src/skill/index.ts
 *   (`.opencode/skills`, `~/.config/opencode/skills`, and the `.claude` and `.agents` folders).
 * - Pi: https://github.com/earendil-works/pi/blob/43d3763991/packages/coding-agent/docs/skills.md and
 *   https://github.com/earendil-works/pi/blob/43d3763991/packages/coding-agent/src/core/package-manager.ts
 *   (`.pi/skills`, `~/.pi/agent/skills`, and the `.agents` folders).
 * Only a project's top folder is read here; some agents also look in the folders above it.
 *
 * An agent's own config folder moves with the setting or variable that moves the agent's home:
 * `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GROK_HOME` (see `configHome`). OpenCode and Pi can be
 * moved too, but their docs don't say how the skill folders follow, so theirs stay at the default.
 *
 * @module AgentSkillFolders
 */
import { ProviderDriverKind, type SkillScope } from "@t3tools/contracts";

/** The shared folder that Codex, Pi and most other agents read. */
export const STANDARD_SKILL_FOLDER = ".agents/skills";

/** Antigravity's user folders, under `~/.gemini`: shared with its IDE, and where `agy` installs. */
export const ANTIGRAVITY_USER_SKILL_SUBFOLDERS = [
  "config/skills",
  "antigravity-cli/skills",
] as const;

export interface SkillRoot {
  readonly scope: SkillScope;
  /** Relative to the home directory (`global`) or the project root (`project`). */
  readonly folder: string;
}

const inProject = (folder: string): SkillRoot => ({ scope: "project", folder });
const inHome = (folder: string): SkillRoot => ({ scope: "global", folder });

/** What an agent does when skills in its folders share a name. */
export type SkillCollision = "first-wins" | "all";

export interface AgentSkillFolderList {
  readonly agent: ProviderDriverKind;
  readonly collision: SkillCollision;
  /**
   * The agent's own config folder under the home directory, for agents whose instance settings or
   * environment can move it (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`). Its global roots
   * below it move with it.
   */
  readonly configHome?: string;
  /** In the order the agent looks. */
  readonly reads: readonly SkillRoot[];
}

export const AGENT_SKILL_FOLDERS: ReadonlyArray<AgentSkillFolderList> = [
  {
    agent: ProviderDriverKind.make("claudeAgent"),
    collision: "first-wins",
    configHome: ".claude",
    reads: [inHome(".claude/skills"), inProject(".claude/skills")],
  },
  {
    agent: ProviderDriverKind.make("codex"),
    collision: "all",
    configHome: ".codex",
    reads: [
      inHome(STANDARD_SKILL_FOLDER),
      inHome(".codex/skills"),
      inProject(STANDARD_SKILL_FOLDER),
      inProject(".codex/skills"),
    ],
  },
  {
    agent: ProviderDriverKind.make("cursor"),
    collision: "first-wins",
    reads: [
      inProject(".cursor/skills"),
      inProject(STANDARD_SKILL_FOLDER),
      inProject(".codex/skills"),
      inProject(".claude/skills"),
      inHome(".cursor/skills"),
      inHome(STANDARD_SKILL_FOLDER),
      inHome(".codex/skills"),
      inHome(".claude/skills"),
    ],
  },
  {
    agent: ProviderDriverKind.make("grok"),
    collision: "all",
    configHome: ".grok",
    reads: [inHome(".grok/skills"), inHome(STANDARD_SKILL_FOLDER), inProject(".grok/skills")],
  },
  {
    agent: ProviderDriverKind.make("opencode"),
    collision: "all",
    reads: [
      inHome(".config/opencode/skills"),
      inHome(".claude/skills"),
      inHome(STANDARD_SKILL_FOLDER),
      inProject(".opencode/skills"),
      inProject(".claude/skills"),
      inProject(STANDARD_SKILL_FOLDER),
    ],
  },
  {
    agent: ProviderDriverKind.make("antigravity"),
    collision: "first-wins",
    reads: [
      inHome(`.gemini/${ANTIGRAVITY_USER_SKILL_SUBFOLDERS[0]}`),
      inProject(".gemini/skills"),
      inHome(`.gemini/${ANTIGRAVITY_USER_SKILL_SUBFOLDERS[1]}`),
      inProject(STANDARD_SKILL_FOLDER),
      inProject(".agent/skills"),
    ],
  },
  {
    agent: ProviderDriverKind.make("pi"),
    collision: "first-wins",
    reads: [
      inProject(".pi/skills"),
      inProject(STANDARD_SKILL_FOLDER),
      inHome(".pi/agent/skills"),
      inHome(STANDARD_SKILL_FOLDER),
    ],
  },
];

/** Everything an agent reads, in the order it looks across both scopes. */
export const skillRootsFor = (agent: ProviderDriverKind): readonly SkillRoot[] =>
  AGENT_SKILL_FOLDERS.find((entry) => entry.agent === agent)?.reads ?? [];

/** How an agent treats skills that share a name. */
export const skillCollisionFor = (agent: ProviderDriverKind): SkillCollision =>
  AGENT_SKILL_FOLDERS.find((entry) => entry.agent === agent)?.collision ?? "all";

/** What one agent reads in one scope, in the order it looks. */
export const skillFoldersFor = (agent: ProviderDriverKind, scope: SkillScope): readonly string[] =>
  skillRootsFor(agent)
    .filter((root) => root.scope === scope)
    .map((root) => root.folder);

/**
 * The project folder, besides the shared one, an agent needs a link in to use a skill: its own
 * (`.claude/skills` for Claude). Undefined for an agent that reads the shared folder, which a
 * skill used in a project is linked into anyway.
 */
export const ownProjectFolderFor = (agent: ProviderDriverKind) => {
  const folders = skillFoldersFor(agent, "project");
  return folders.includes(STANDARD_SKILL_FOLDER) ? undefined : folders[0];
};
