import type { ProviderDriverKind } from "@t3tools/contracts";

export type HarnessDeliveryStrategy = "proxy" | "token-lease" | "remote-only";

export type HarnessTurnInjectionStrategy = "codex-additional-context" | "turn-envelope";

export type HarnessEphemeralTokenFormat =
  | "antigravity-oauth-json"
  | "claude-credentials-json"
  | "in-memory"
  | "none";

export type HarnessPersonalSkillLayout =
  | {
      readonly kind: "directory-symlinks";
      readonly personalRelativeDir: ReadonlyArray<string>;
    }
  | {
      readonly kind: "antigravity-config-and-plugins";
      readonly personalSkillRelativeDirs: ReadonlyArray<ReadonlyArray<string>>;
      readonly personalPluginsRelativeDir: ReadonlyArray<string>;
      readonly personalConfigRelativePath: ReadonlyArray<string>;
    }
  | { readonly kind: "none" };

export interface HarnessProfileSpec {
  readonly driver: string;
  /** Environment variable pointing the harness at its isolated profile directory. */
  readonly profileEnvVar: string;
  /** Additional static env vars required for isolated team profiles. */
  readonly extraProfileEnv?: Readonly<Record<string, string>>;
  /** Additional ambient env vars stripped to prevent personal credential leakage. */
  readonly extraStrippedAmbientEnv?: ReadonlyArray<string>;
  /** Whether `ProviderInstanceConfig.config.homePath` is set to `profileDir`. */
  readonly setsHomePathConfig: boolean;
  /** Optional `config.setupMode` set when using `token-lease` delivery. */
  readonly tokenLeaseSetupMode?: string;
  /** Optional provider config override applied when using `proxy` delivery. */
  readonly proxyConfigMode?: "gemini-api-key";
  /** Profile root strategy: native Antigravity SHA-256 profile vs `<stateDir>/team-profiles/<driver>/<hash>`. */
  readonly profileStorage: "antigravity-native" | "team-profiles";
  /** Subdirectory under `profileDir` where materialized team skills live. */
  readonly skillsSubdir: string;
  /** Filename under `profileDir` for `"thread"`-scoped pre-prompts, or `null` for Turn 1 inline injection. */
  readonly threadInstructionFilename: string | null;
  /** Strategy for injecting `"turn"`-scoped pre-prompts on every turn. */
  readonly turnInjectionStrategy: HarnessTurnInjectionStrategy;
  /** Supported team credential delivery strategies for this harness. */
  readonly deliveryCapabilities: ReadonlyArray<HarnessDeliveryStrategy>;
  /** True when the child process caches OAuth tokens in RAM and requires session recycling on rotation. */
  readonly cachesTokenInRam: boolean;
  /** Ephemeral on-disk token file format (never storing `refresh_token`). */
  readonly ephemeralTokenFormat: HarnessEphemeralTokenFormat;
  /** Relative path segments under `profileDir` for primary + legacy ephemeral token files. */
  readonly ephemeralTokenRelativePaths: ReadonlyArray<ReadonlyArray<string>>;
  /** Optional 4th-segment leaf under `<stateDir>/providers/<driver>/<instance>/` allowed in bwrap. */
  readonly bwrapAllowedShadowLeaf?: string;
  /** How teammates' personal skills and plugins are surfaced read-only in isolated team profiles. */
  readonly personalSkillLayout: HarnessPersonalSkillLayout;
}

export const TEAM_PROFILE_MARKER_FILENAME = ".t3-team-profile.json";
const TEAM_ANTIGRAVITY_SKILLS_DIRNAME = "team-skills";
export const TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME = "antigravity-oauth-token";
const TEAM_ANTIGRAVITY_ACP_DIRNAME = "antigravity-acp";

export const DEFAULT_TEAM_HARNESS_PROFILE: HarnessProfileSpec = {
  driver: "default",
  profileEnvVar: "T3_TEAM_PROFILE_DIR",
  setsHomePathConfig: false,
  profileStorage: "team-profiles",
  skillsSubdir: TEAM_ANTIGRAVITY_SKILLS_DIRNAME,
  threadInstructionFilename: null,
  turnInjectionStrategy: "turn-envelope",
  deliveryCapabilities: ["proxy", "remote-only"],
  cachesTokenInRam: false,
  ephemeralTokenFormat: "none",
  ephemeralTokenRelativePaths: [],
  personalSkillLayout: { kind: "none" },
};

export const TEAM_HARNESS_PROFILES: Readonly<Record<string, HarnessProfileSpec>> = {
  antigravity: {
    driver: "antigravity",
    profileEnvVar: "GEMINI_HOME",
    extraProfileEnv: {
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
    },
    setsHomePathConfig: false,
    proxyConfigMode: "gemini-api-key",
    profileStorage: "antigravity-native",
    skillsSubdir: TEAM_ANTIGRAVITY_SKILLS_DIRNAME,
    threadInstructionFilename: "GEMINI.md",
    turnInjectionStrategy: "turn-envelope",
    deliveryCapabilities: ["proxy", "token-lease", "remote-only"],
    cachesTokenInRam: true,
    ephemeralTokenFormat: "antigravity-oauth-json",
    ephemeralTokenRelativePaths: [
      [TEAM_ANTIGRAVITY_ACP_DIRNAME, TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME],
      [TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME],
      [TEAM_ANTIGRAVITY_ACP_DIRNAME, "acp_token.json"],
    ],
    personalSkillLayout: {
      kind: "antigravity-config-and-plugins",
      personalSkillRelativeDirs: [
        [".gemini", "config", "skills"],
        [".gemini", "antigravity-cli", "skills"],
      ],
      personalPluginsRelativeDir: [".gemini", "config", "plugins"],
      personalConfigRelativePath: [".gemini", "config", "config.json"],
    },
  },
  codex: {
    driver: "codex",
    profileEnvVar: "CODEX_HOME",
    setsHomePathConfig: true,
    tokenLeaseSetupMode: "managed",
    profileStorage: "team-profiles",
    skillsSubdir: "skills",
    threadInstructionFilename: "AGENTS.md",
    turnInjectionStrategy: "codex-additional-context",
    deliveryCapabilities: ["proxy", "token-lease", "remote-only"],
    cachesTokenInRam: false,
    ephemeralTokenFormat: "in-memory",
    ephemeralTokenRelativePaths: [],
    bwrapAllowedShadowLeaf: "shadow",
    personalSkillLayout: {
      kind: "directory-symlinks",
      personalRelativeDir: [".codex", "skills"],
    },
  },
  claudeAgent: {
    driver: "claudeAgent",
    profileEnvVar: "CLAUDE_CONFIG_DIR",
    extraStrippedAmbientEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
    setsHomePathConfig: true,
    profileStorage: "team-profiles",
    skillsSubdir: "skills",
    threadInstructionFilename: "CLAUDE.md",
    turnInjectionStrategy: "turn-envelope",
    deliveryCapabilities: ["proxy", "token-lease", "remote-only"],
    cachesTokenInRam: true,
    ephemeralTokenFormat: "claude-credentials-json",
    ephemeralTokenRelativePaths: [[".credentials.json"]],
    personalSkillLayout: {
      kind: "directory-symlinks",
      personalRelativeDir: [".claude", "skills"],
    },
  },
  opencode: {
    driver: "opencode",
    profileEnvVar: "OPENCODE_CONFIG_DIR",
    setsHomePathConfig: false,
    profileStorage: "team-profiles",
    skillsSubdir: TEAM_ANTIGRAVITY_SKILLS_DIRNAME,
    threadInstructionFilename: null,
    turnInjectionStrategy: "turn-envelope",
    deliveryCapabilities: ["proxy", "remote-only"],
    cachesTokenInRam: false,
    ephemeralTokenFormat: "none",
    ephemeralTokenRelativePaths: [],
    personalSkillLayout: { kind: "none" },
  },
  pi: {
    driver: "pi",
    profileEnvVar: "PI_CODING_AGENT_DIR",
    setsHomePathConfig: false,
    profileStorage: "team-profiles",
    skillsSubdir: TEAM_ANTIGRAVITY_SKILLS_DIRNAME,
    threadInstructionFilename: null,
    turnInjectionStrategy: "turn-envelope",
    deliveryCapabilities: ["proxy", "remote-only"],
    cachesTokenInRam: false,
    ephemeralTokenFormat: "none",
    ephemeralTokenRelativePaths: [],
    personalSkillLayout: { kind: "none" },
  },
};

export function getTeamHarnessProfile(driver: ProviderDriverKind | string): HarnessProfileSpec {
  return TEAM_HARNESS_PROFILES[driver] ?? DEFAULT_TEAM_HARNESS_PROFILE;
}

export const TEAM_PROVIDER_PROFILE_ENV_VARS: ReadonlyArray<string> = [
  ...new Set([
    ...Object.values(TEAM_HARNESS_PROFILES).map((spec) => spec.profileEnvVar),
    DEFAULT_TEAM_HARNESS_PROFILE.profileEnvVar,
  ]),
];

export function isAllowedBwrapShadowProfileLeaf(driver: string, leaf: string): boolean {
  const spec = TEAM_HARNESS_PROFILES[driver];
  return spec?.bwrapAllowedShadowLeaf !== undefined && spec.bwrapAllowedShadowLeaf === leaf;
}
