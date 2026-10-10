/**
 * AgentSkillFolders - where each agent reads skills from, and which `skills`
 * CLI agent id installs into them.
 *
 * Paths are relative to the home folder (`home`) or the project root
 * (`project`), in the order the agent looks. `.agents/skills` is the folder the
 * `skills` CLI writes every install to; agents that read only their own folder
 * get a link there, made by naming their CLI id. Sources for each agent:
 * - Claude: `ClaudeSkills.ts` (`~/.claude/skills`, `.claude/skills`; it does
 *   not read `.agents/skills`).
 * - Codex: https://developers.openai.com/codex/skills (`.agents/skills` at both
 *   levels; `~/.codex/skills` is the deprecated user folder).
 * - Cursor: provider-cursor's `skills.ts`.
 * - OpenCode: https://opencode.ai/docs/skills/ (its own folders plus the
 *   `.claude` and `.agents` ones).
 * - Grok: https://docs.x.ai/build/features/skills-plugins-marketplaces.md.
 * - Antigravity: `AntigravitySkills.ts` (`.agents/skills` only in a project).
 * - Pi: its docs/skills.md (`.pi/skills`, `~/.pi/agent/skills`, `.agents`).
 * The CLI ids and folders follow vercel-labs/skills' `src/agents.ts`.
 *
 * @module AgentSkillFolders
 */
import type { ProviderDriverKind } from "@t3tools/contracts";

/** The folder the `skills` CLI installs into, at home and in a project. */
export const STANDARD_SKILL_FOLDER = ".agents/skills";

export interface AgentSkillFolders {
  /** Folders under the home folder, in the order the agent looks. */
  readonly home: ReadonlyArray<string>;
  /** Folders under a project root, in the order the agent looks. */
  readonly project: ReadonlyArray<string>;
  /**
   * The `skills` CLI agent that links an install into a folder this agent
   * reads, when `.agents/skills` alone doesn't reach it at that level.
   */
  readonly installAgent?: { readonly home?: string; readonly project?: string };
}

const AGENT_SKILL_FOLDERS: Readonly<Record<string, AgentSkillFolders>> = {
  claudeAgent: {
    home: [".claude/skills"],
    project: [".claude/skills"],
    installAgent: { home: "claude-code", project: "claude-code" },
  },
  codex: {
    home: [STANDARD_SKILL_FOLDER, ".codex/skills"],
    project: [STANDARD_SKILL_FOLDER, ".codex/skills"],
  },
  cursor: {
    home: [".cursor/skills", STANDARD_SKILL_FOLDER, ".codex/skills", ".claude/skills"],
    project: [".cursor/skills", STANDARD_SKILL_FOLDER, ".codex/skills", ".claude/skills"],
  },
  opencode: {
    home: [".config/opencode/skills", ".claude/skills", STANDARD_SKILL_FOLDER],
    project: [".opencode/skills", ".claude/skills", STANDARD_SKILL_FOLDER],
  },
  grok: {
    home: [".grok/skills", STANDARD_SKILL_FOLDER],
    project: [".grok/skills"],
    installAgent: { project: "grok" },
  },
  antigravity: {
    home: [".gemini/config/skills", ".gemini/antigravity-cli/skills"],
    project: [".gemini/skills", STANDARD_SKILL_FOLDER, ".agent/skills"],
    installAgent: { home: "antigravity-cli" },
  },
  pi: {
    home: [".pi/agent/skills", STANDARD_SKILL_FOLDER],
    project: [".pi/skills", STANDARD_SKILL_FOLDER],
  },
};

/** The folders a driver reads, or undefined for a driver this table doesn't know. */
const agentSkillFolders = (driver: ProviderDriverKind): AgentSkillFolders | undefined =>
  AGENT_SKILL_FOLDERS[driver];

/**
 * The `skills` CLI agents an install names so every listed driver can use the
 * skill: `universal` writes `.agents/skills`, and each driver that doesn't read
 * it at that level adds the agent that links into its own folder.
 */
export function skillsCliInstallAgents(
  drivers: ReadonlyArray<ProviderDriverKind>,
  level: "home" | "project",
): ReadonlyArray<string> {
  const agents = new Set(["universal"]);
  for (const driver of drivers) {
    const agent = agentSkillFolders(driver)?.installAgent?.[level];
    if (agent !== undefined) agents.add(agent);
  }
  return [...agents];
}
