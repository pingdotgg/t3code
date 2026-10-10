/**
 * AgentSkillSettings - switching a skill off through an agent's own settings.
 *
 * An agent that reaches a skill through a link T3 Code can remove is switched off by removing
 * the link. An agent that reads the skill's real folder directly has no link to remove, so where
 * it has a per-skill setting, that setting is what Off writes (and On takes away). Without one
 * the agent is `fixed`: the Skills page disables its switch and a request reports `alwaysOn`.
 *
 * One decision per adapter on main, each checked against the agent's documentation and, where the
 * CLI is installed, against the CLI itself:
 * - Claude Code: `skillOverrides: { "<name>": "off" }` in the settings files, user and local
 *   layers written here. https://code.claude.com/docs/en/skills ("Override skill visibility from
 *   settings"); the layers and the whole-map validation are in `ClaudeSkills.ts`.
 * - Codex: `[[skills.config]] path = "<SKILL.md>" enabled = false` in `$CODEX_HOME/config.toml`,
 *   written through the app-server's `skills/config/write` and read from the file. Checked
 *   against codex 0.160.1: the path is recorded as the real path of SKILL.md even when it is
 *   given through a link, `enabled = true` removes the entry, and a name-keyed entry is honoured
 *   too. https://developers.openai.com/codex/skills
 * - OpenCode: `permission.skill.<name>: "deny"` in the global config. Checked against opencode
 *   1.18.31 (`opencode debug agent build` shows the rule). https://opencode.ai/docs/skills
 * - Pi: `-skills/<name>/SKILL.md` in the `skills` array of `<agent dir>/settings.json`, the
 *   exact-exclusion form `pi config` writes. https://pi.dev/docs/latest/settings ("Resource
 *   arrays support glob exclusions with `!pattern`, exact inclusion with `+path`, and exact
 *   exclusion with `-path`") and `addAutoDiscoveredResources` in `package-manager.ts` at
 *   https://github.com/earendil-works/pi/blob/43d3763991/packages/coding-agent/src/core/package-manager.ts,
 *   which applies the user's array to the skills found in `~/.agents/skills`. Only for Global
 *   skills: a project's skills are filtered by the project's own `.pi/settings.json`, which is
 *   usually committed, so a project skill is `fixed`, and so is a Global skill used in only some
 *   projects, which Pi finds in the projects' folders. Not run against Pi (not installed here).
 * - Cursor: `fixed`. Its skills page documents no setting to switch one skill off, only the
 *   `disable-model-invocation` field in the skill's own file. https://cursor.com/docs/context/skills
 * - Grok: `fixed`. The docs list `[skills] paths` for extra folders and a TUI `/skills` modal,
 *   but no setting that names a skill. https://docs.x.ai/build/features/skills-plugins-marketplaces
 * - Antigravity: `fixed`. Its CLI settings reference has no skill keys.
 *   https://www.antigravity.google/docs/settings?tab=cli
 * - Muse Code and ACP registry agents: `fixed`. Neither has skill folders in `AgentSkillFolders`,
 *   so they are not on the Skills page and there is nothing to switch.
 *
 * @module AgentSkillSettings
 */
import type { ProviderDriverKind, SkillScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as VcsProcess from "../vcs/VcsProcess.ts";

import { claudeSwitches, setClaudeSwitch } from "./ClaudeSkillSettings.ts";
import { codexSwitches } from "./CodexSkillSettings.ts";
import { openCodeSwitches, setOpenCodeSwitch } from "./OpenCodeSkillSettings.ts";
import { piSwitches, setPiSwitch } from "./PiSkillSettings.ts";

type SwitchKind = "claude" | "codex" | "opencode" | "pi";

/**
 * The adapters that have a per-skill setting, and for which skills. `inProjects`: the setting also
 * reaches a Global skill the agent finds only through links in projects' folders (a skill used in
 * some projects, see `SkillLibrary`). Claude and OpenCode name the skill and Codex records its real
 * folder, so wherever the agent finds it they apply; Pi applies its list to the user-level folders
 * only.
 */
const SWITCHES: Readonly<
  Record<
    string,
    {
      readonly kind: SwitchKind;
      readonly scopes: readonly SkillScope[];
      readonly inProjects: boolean;
    }
  >
> = {
  claudeAgent: { kind: "claude", scopes: ["global", "project"], inProjects: true },
  codex: { kind: "codex", scopes: ["global", "project"], inProjects: true },
  opencode: { kind: "opencode", scopes: ["global", "project"], inProjects: true },
  pi: { kind: "pi", scopes: ["global"], inProjects: false },
};

/**
 * Which settings switch a skill of this scope for the agent, if T3 Code knows any. `reach` is
 * `projects` for a Global skill that the agent finds only through links in projects' folders.
 */
export const skillSwitchKind = (
  driver: ProviderDriverKind,
  scope: SkillScope,
  reach: "folder" | "projects" = "folder",
) => {
  const entry = SWITCHES[driver];
  if (entry === undefined || !entry.scopes.includes(scope)) return undefined;
  return reach === "projects" && !entry.inProjects ? undefined : entry.kind;
};

/** What T3 Code needs to know about an agent instance to read and write its settings. */
export interface SkillSwitchContext {
  readonly driver: ProviderDriverKind;
  /** Claude's config folder or Codex's home, where the instance's settings say. */
  readonly configHome: string;
  readonly homeDirectory: string;
  /** The instance's environment over the server's. */
  readonly environment: NodeJS.ProcessEnv;
  /** The project the list was read for, whose own settings are layered over the user's. */
  readonly cwd: string | undefined;
}

/** A skill as a settings file can name it. */
export interface SwitchedSkill {
  readonly scope: SkillScope;
  /** The skill's folder name, which is how Claude Code and OpenCode name it. */
  readonly name: string;
  /** The `name` in the skill's header, which is how Codex names it; absent when it has none. */
  readonly declaredName: string | undefined;
  /** Absolute path of the skill's folder after following links. */
  readonly home: string;
  /** Every path in the agents' folders that reaches the skill. */
  readonly entryPaths: readonly string[];
}

/** What an agent's settings say, read once for a whole list. */
export interface SkillSwitchView {
  /** The agent's own settings switch the skill off. */
  readonly off: (skill: SwitchedSkill) => boolean;
}

/**
 * What happened to a settings write. `setElsewhere`: a layer the write can't reach still decides
 * the skill, so nothing was written. `failed`: the file can't be edited safely or the disk said no.
 */
export type SkillSwitchWrite = "written" | "unchanged" | "setElsewhere" | "failed";

const NOTHING_SWITCHED: SkillSwitchView = { off: () => false };

/** Reads the agent's settings, which never starts a process. An unreadable file switches nothing. */
export const loadSkillSwitches = (
  context: SkillSwitchContext,
): Effect.Effect<SkillSwitchView, never, FileSystem.FileSystem | Path.Path> => {
  switch (SWITCHES[context.driver]?.kind) {
    case "claude":
      return claudeSwitches(context);
    case "codex":
      return codexSwitches(context);
    case "opencode":
      return openCodeSwitches(context);
    case "pi":
      return piSwitches(context);
    default:
      return Effect.succeed(NOTHING_SWITCHED);
  }
};

/**
 * Writes the agent's settings file so the skill is off (or, with `off: false`, no longer off).
 * Codex's settings are written by Codex itself (see `CodexSkillSettings`), so it isn't handled
 * here.
 */
export const setSkillSwitch = (
  context: SkillSwitchContext,
  skill: SwitchedSkill,
  off: boolean,
): Effect.Effect<
  SkillSwitchWrite,
  never,
  FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess
> => {
  switch (SWITCHES[context.driver]?.kind) {
    case "claude":
      return setClaudeSwitch(context, skill, off);
    case "opencode":
      return setOpenCodeSwitch(context, skill, off);
    case "pi":
      return setPiSwitch(context, skill, off);
    default:
      return Effect.succeed("failed" as const);
  }
};
