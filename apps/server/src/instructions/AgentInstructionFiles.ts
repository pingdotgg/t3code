/**
 * AgentInstructionFiles - the instruction files (AGENTS.md, CLAUDE.md and friends) each agent
 * reads, and where.
 *
 * One table for the Instructions section of the Skills page, in the same spirit as
 * `AgentSkillFolders`. Data only: nothing here touches the disk. Paths are relative to a project
 * folder (`project`) or to the user's home directory (`home`). Each file list is in the order the
 * agent prefers it, and `selection` says what the agent does when several of them exist.
 *
 * Only whole instruction files are modelled. Rule folders (`.claude/rules`, `.cursor/rules`,
 * `.grok/rules`, `.agents/rules`) and files an agent is told to load through its own config
 * (OpenCode `instructions`, Codex `project_doc_fallback_filenames`) are out of scope.
 *
 * A level that can't be confirmed from the agent's documentation or source is `null`, which
 * means "no icon, no claim". Reasons for the levels left out:
 * - Cursor, home: User Rules live in the app's Customize -> Rules settings, not in a file.
 * - Antigravity, home: the agent reads `~/.gemini/AGENTS.md`, but T3 Code starts it with
 *   `GEMINI_HOME` pointing at a private profile and links only the skill folders back
 *   (`linkAntigravityUserSkills` in `antigravityAuthSupport.ts`), so the user's file is never seen.
 * - Everyone but Claude, managed: none of the others documents a managed instruction file.
 *
 * Sources, per agent:
 * - Claude: https://code.claude.com/docs/en/memory ("Choose where to put CLAUDE.md files",
 *   "Import additional files", "AGENTS.md", "Choose which instruction files load"). `CLAUDE.md`
 *   and `CLAUDE.local.md` load from the working folder and every folder above it, subfolders when
 *   Claude works in them. `AGENTS.md` and `.claude/AGENTS.md` load only as the "Project
 *   instructions" setting says (see `ClaudeInstructionSetting.ts`, Claude Code 2.1.277 or later).
 *   The user file is `<config dir>/CLAUDE.md`; the config dir is `CLAUDE_CONFIG_DIR` or a T3 Code
 *   instance's `homePath`, resolved as `SkillCatalog` does. The managed file is per OS.
 * - Codex: https://learn.chatgpt.com/docs/agent-configuration/agents-md (also served at
 *   https://developers.openai.com/codex/guides/agents-md) and, in
 *   https://github.com/openai/codex/tree/fac5d0ba91: `core/src/agents_md.rs` (per folder from the
 *   project root, the nearest ancestor with a `.git` marker, down to the working folder, the
 *   first of `AGENTS.override.md` and `AGENTS.md` wins; with no root only the working folder;
 *   nothing is read in an untrusted project; 32 KiB `project_doc_max_bytes` across all files),
 *   `codex-home/src/instructions/mod.rs` (the home folder's first non-empty file of
 *   `AGENTS.override.md` and `AGENTS.md`) and `utils/home-dir/src/lib.rs` (`CODEX_HOME`).
 * - OpenCode: https://opencode.ai/docs/rules/ and, in
 *   https://github.com/anomalyco/opencode/tree/a697115b20, `packages/opencode/src/session/instruction.ts`
 *   (`AGENTS.md` in every folder from the working folder up to the worktree root; `CLAUDE.md`, and
 *   the deprecated `CONTEXT.md`, only when no `AGENTS.md` is found anywhere on that walk; a file in
 *   a subfolder is added when the agent reads a file there; the home folder's `AGENTS.md`, else
 *   `~/.claude/CLAUDE.md`, which `OPENCODE_DISABLE_CLAUDE_CODE` and
 *   `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` turn off together with the project `CLAUDE.md`).
 *   `packages/core/src/global.ts` puts the home folder at `OPENCODE_CONFIG_DIR`, else
 *   `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. Its docs say it doesn't parse file
 *   references in AGENTS.md.
 * - Pi: https://github.com/earendil-works/pi/blob/43d3763991/packages/coding-agent/docs/configuration.md
 *   ("Agent directory", "Context files"), `docs/environment-variables.md` (`PI_CODING_AGENT_DIR`)
 *   and `src/core/resource-loader.ts` (`loadContextFileFromDir`, `loadProjectContextFiles`): the
 *   first existing of five names in the agent directory, then in the working folder and every
 *   folder above it, all the way up. T3 Code's adapter leaves context loading on
 *   (`PiAdapterV2.ts`).
 * - Cursor: https://cursor.com/docs/context/rules ("AGENTS.md": the project root and subfolders,
 *   nested files add to their parents') and https://cursor.com/docs/sdk/typescript (the SDK's
 *   workspace scan reads `AGENTS.md`; T3 Code's adapter loads the `project` and `user` setting
 *   sources). The Cursor CLI also reads a root `CLAUDE.md` (https://cursor.com/docs/cli/using),
 *   but the SDK docs don't say so, so it isn't claimed.
 * - Grok: https://docs.x.ai/build/features/project-rules.md (every folder from the repo root down
 *   to the working folder, or only the working folder outside git; deeper files win) and
 *   https://docs.x.ai/build/settings/reference.md (`GROK_HOME`); in
 *   https://github.com/xai-org/grok-build/tree/2bdd1d6a63, `crates/codegen/xai-grok-config/src/compat.rs`
 *   (`INSTRUCTION_FILENAMES`) and `crates/codegen/xai-grok-agent/src/prompt/agents_md.rs` (every
 *   existing name loads; gitignored files are skipped; nothing is read in an untrusted folder;
 *   the home roots are `$GROK_HOME`, `~/.claude` and `~/.cursor`, the last two through the
 *   Claude and Cursor compatibility scanners that are on by default).
 * - Antigravity: https://antigravity.google/docs/rules ("Directory-scoped rules", "Global rules",
 *   "Managing rules in Antigravity CLI"): `AGENTS.md` and `GEMINI.md`, also under `.agents/`,
 *   in the workspace root and any subfolder, found by walking up from each file the agent reads
 *   or edits; every one that exists loads. Imports there are `@[label](path)`, not Claude's.
 *
 * Claude's `@path` import is the only one that inlines a file. Codex, OpenCode, Pi and Grok don't
 * document any; Cursor's `@file` mention only lets the agent read the file; Antigravity's
 * `@[label](path)` is a different syntax. So `imports` is true for Claude alone.
 *
 * @module AgentInstructionFiles
 */
import { ProviderDriverKind } from "@t3tools/contracts";

/** What an agent does when several of its instruction files exist side by side. */
export type InstructionSelection =
  /** Every file that exists loads. */
  | "all"
  /** Only the first existing file of each folder loads. */
  | "first-per-folder"
  /**
   * The first name that exists anywhere on the search loads, in every folder that has it; later
   * names are fallbacks for when no folder has an earlier one.
   */
  | "first-name";

/** How far above the working folder an agent looks for project files. */
export type InstructionParents =
  /** Not above the project's top folder. */
  | "none"
  /** Up to the root of the repository the working folder is in. */
  | "repo-root"
  /** Up to the top of the file system. */
  | "filesystem-root";

export interface ProjectInstructionFile {
  /** Relative to a folder, so `.claude/CLAUDE.md` is a name too. */
  readonly name: string;
  /** Claude reads this one only as its "Project instructions" setting allows. */
  readonly governedBy?: "claudeProjectInstructions";
}

export interface ProjectInstructionRules {
  /** In the order the agent prefers them. */
  readonly files: readonly ProjectInstructionFile[];
  readonly selection: InstructionSelection;
  readonly parents: InstructionParents;
  /**
   * Whether a file in a subfolder is used when the agent works there (`on-demand`), or only the
   * folders on the way up are read (`none`).
   */
  readonly subfolders: "none" | "on-demand";
  /** Environment variables that switch off the files after the first name in `files`. */
  readonly fallbackDisabledByEnv?: readonly string[];
  /** The agent skips files git ignores, which `CLAUDE.local.md` is meant to be. */
  readonly skipsGitIgnored?: boolean;
}

/** A folder of another agent that this one reads too, at a fixed place under the home directory. */
export interface AlsoReadFolder {
  /** Relative to the home directory. */
  readonly folder: string;
  readonly files: readonly string[];
  /** `no-own-file`: only when the agent's own home folder has none of its files. */
  readonly when: "always" | "no-own-file";
  /** Environment variables that switch this fallback off. */
  readonly disabledByEnv?: readonly string[];
}

export interface HomeInstructionRules {
  /** The agent's own folder under the home directory, by default. */
  readonly folder: string;
  /** In the order the agent prefers them. */
  readonly files: readonly string[];
  readonly selection: Exclude<InstructionSelection, "first-name">;
  /** A file with no text is passed over, so the next name in `files` is the one that loads. */
  readonly skipsEmpty?: boolean;
  /** The variable that names the folder itself. */
  readonly folderEnv?: string;
  /** The default folder sits under `$XDG_CONFIG_HOME` when that is set, else under `~/.config`. */
  readonly xdgConfigHome?: boolean;
  /** A T3 Code provider instance's `homePath` setting moves the folder, ahead of `folderEnv`. */
  readonly instanceHomePath?: boolean;
  /**
   * How the shared all-projects file reaches the agent: `link` is a symlink at `file` in the
   * folder, `import` is a line that imports it as the first line of `file`.
   */
  readonly shared: { readonly file: string; readonly join: "link" | "import" };
  readonly alsoReads?: readonly AlsoReadFolder[];
}

/** Where an organization puts Claude's managed CLAUDE.md. WSL counts as `linux`. */
export interface ManagedInstructionPaths {
  readonly darwin: string;
  readonly linux: string;
  readonly win32: string;
}

export interface AgentInstructionRules {
  readonly agent: ProviderDriverKind;
  /** `null` when no project file is confirmed. */
  readonly project: ProjectInstructionRules | null;
  /** `null` when no file in the user's home is confirmed. */
  readonly home: HomeInstructionRules | null;
  readonly managed: ManagedInstructionPaths | null;
  /** Whether a file can pull in another with Claude's `@path` line. */
  readonly imports: boolean;
}

const file = (name: string): ProjectInstructionFile => ({ name });
const governed = (name: string): ProjectInstructionFile => ({
  name,
  governedBy: "claudeProjectInstructions",
});

/** The names Grok reads in a folder, in the order of its `INSTRUCTION_FILENAMES`. */
const GROK_FILE_NAMES = [
  "Agents.md",
  "Claude.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENT.md",
  "AGENTS.md",
] as const;

/** The variables that turn off OpenCode's reading of Claude's files, its project `CLAUDE.md` too. */
const OPENCODE_CLAUDE_COMPAT_ENV = [
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
] as const;

export const AGENT_INSTRUCTION_FILES: ReadonlyArray<AgentInstructionRules> = [
  {
    agent: ProviderDriverKind.make("claudeAgent"),
    project: {
      files: [
        file("CLAUDE.md"),
        file(".claude/CLAUDE.md"),
        file("CLAUDE.local.md"),
        governed("AGENTS.md"),
        governed(".claude/AGENTS.md"),
      ],
      selection: "all",
      parents: "filesystem-root",
      subfolders: "on-demand",
    },
    home: {
      folder: ".claude",
      files: ["CLAUDE.md"],
      selection: "all",
      folderEnv: "CLAUDE_CONFIG_DIR",
      instanceHomePath: true,
      shared: { file: "CLAUDE.md", join: "import" },
    },
    managed: {
      darwin: "/Library/Application Support/ClaudeCode/CLAUDE.md",
      linux: "/etc/claude-code/CLAUDE.md",
      win32: "C:\\Program Files\\ClaudeCode\\CLAUDE.md",
    },
    imports: true,
  },
  {
    agent: ProviderDriverKind.make("codex"),
    project: {
      files: [file("AGENTS.override.md"), file("AGENTS.md")],
      selection: "first-per-folder",
      parents: "repo-root",
      subfolders: "none",
    },
    home: {
      folder: ".codex",
      files: ["AGENTS.override.md", "AGENTS.md"],
      selection: "first-per-folder",
      skipsEmpty: true,
      folderEnv: "CODEX_HOME",
      instanceHomePath: true,
      shared: { file: "AGENTS.md", join: "link" },
    },
    managed: null,
    imports: false,
  },
  {
    agent: ProviderDriverKind.make("opencode"),
    project: {
      files: [file("AGENTS.md"), file("CLAUDE.md")],
      selection: "first-name",
      parents: "repo-root",
      subfolders: "on-demand",
      fallbackDisabledByEnv: OPENCODE_CLAUDE_COMPAT_ENV,
    },
    home: {
      folder: ".config/opencode",
      files: ["AGENTS.md"],
      selection: "first-per-folder",
      folderEnv: "OPENCODE_CONFIG_DIR",
      xdgConfigHome: true,
      shared: { file: "AGENTS.md", join: "link" },
      alsoReads: [
        {
          folder: ".claude",
          files: ["CLAUDE.md"],
          when: "no-own-file",
          disabledByEnv: OPENCODE_CLAUDE_COMPAT_ENV,
        },
      ],
    },
    managed: null,
    imports: false,
  },
  {
    agent: ProviderDriverKind.make("pi"),
    project: {
      files: [
        file("AGENTS.override.md"),
        file("AGENTS.md"),
        file("AGENTS.MD"),
        file("CLAUDE.md"),
        file("CLAUDE.MD"),
      ],
      selection: "first-per-folder",
      parents: "filesystem-root",
      subfolders: "none",
    },
    home: {
      folder: ".pi/agent",
      files: ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"],
      selection: "first-per-folder",
      folderEnv: "PI_CODING_AGENT_DIR",
      shared: { file: "AGENTS.md", join: "link" },
    },
    managed: null,
    imports: false,
  },
  {
    agent: ProviderDriverKind.make("cursor"),
    project: {
      files: [file("AGENTS.md")],
      selection: "all",
      parents: "none",
      subfolders: "on-demand",
    },
    home: null,
    managed: null,
    imports: false,
  },
  {
    agent: ProviderDriverKind.make("grok"),
    project: {
      files: [...GROK_FILE_NAMES, ".claude/CLAUDE.md", ".claude/CLAUDE.local.md"].map(file),
      selection: "all",
      parents: "repo-root",
      subfolders: "on-demand",
      skipsGitIgnored: true,
    },
    home: {
      folder: ".grok",
      files: [...GROK_FILE_NAMES],
      selection: "all",
      folderEnv: "GROK_HOME",
      shared: { file: "AGENTS.md", join: "link" },
      alsoReads: [
        { folder: ".claude", files: [...GROK_FILE_NAMES], when: "always" },
        { folder: ".cursor", files: [...GROK_FILE_NAMES], when: "always" },
      ],
    },
    managed: null,
    imports: false,
  },
  {
    agent: ProviderDriverKind.make("antigravity"),
    project: {
      files: ["AGENTS.md", "GEMINI.md", ".agents/AGENTS.md", ".agents/GEMINI.md"].map(file),
      selection: "all",
      parents: "none",
      subfolders: "on-demand",
    },
    home: null,
    managed: null,
    imports: false,
  },
];

/** What one agent reads, or `undefined` for an agent the table doesn't know. */
export const instructionRulesFor = (agent: ProviderDriverKind): AgentInstructionRules | undefined =>
  AGENT_INSTRUCTION_FILES.find((entry) => entry.agent === agent);

/** The agent's rule for a project file name, or `undefined` when it doesn't read that name. */
export const projectInstructionFile = (
  agent: ProviderDriverKind,
  name: string,
): ProjectInstructionFile | undefined =>
  instructionRulesFor(agent)?.project?.files.find((entry) => entry.name === name);

/** Claude's managed CLAUDE.md on a platform, or `undefined` on one the docs don't list. */
export const claudeManagedInstructionPath = (platform: NodeJS.Platform): string | undefined => {
  const managed = instructionRulesFor(ProviderDriverKind.make("claudeAgent"))?.managed;
  if (managed === null || managed === undefined) return undefined;
  if (platform === "darwin") return managed.darwin;
  if (platform === "linux") return managed.linux;
  if (platform === "win32") return managed.win32;
  return undefined;
};
