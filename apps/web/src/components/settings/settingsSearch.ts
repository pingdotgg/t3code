import { t } from "@palamedes/core/macro";
import { HOSTED_APP_CHANNEL } from "~/branding";
import { isElectron, isSecretsFeatureEnabled } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  sourceControlClients,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { commandLabel } from "./KeybindingsSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/diagnostics"
  | "/settings/voice"
  | "/settings/appearance"
  | "/settings/chat"
  | "/settings/diffs"
  | "/settings/keybindings"
  | "/settings/snap-shot"
  | "/settings/providers"
  | "/settings/threads"
  | "/settings/browser"
  | "/settings/devices"
  | "/settings/scheduled-tasks"
  | "/settings/source-control"
  | "/settings/worktrees"
  | "/settings/connections"
  | "/settings/access"
  | "/settings/secrets"
  | "/settings/maintenance"
  | "/settings/labs"
  | "/settings/about"
  | "/settings/archived";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly windowsOnly?: boolean;
  readonly releaseChannelOnly?: boolean;
  readonly secretsFeatureOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly managedTunnelOnly?: boolean;
  readonly peerLinksOnly?: boolean;
  readonly fastWorktreeCheckoutOnly?: boolean;
  readonly textGeneratorsOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  readonly managedTunnelActive?: boolean;
  readonly hasPeerLinkHost?: boolean;
  readonly hasFastWorktreeCheckoutEnvironment?: boolean;
  /** An environment without a provider allow-list, which hides text generators. */
  readonly hasTextGeneratorsEnvironment?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  get "/settings/diagnostics"() {
    return t({ message: "Diagnostics" });
  },
  get "/settings/projects"() {
    return t({ message: "Projects" });
  },
  get "/settings/general"() {
    return t({ message: "General" });
  },
  get "/settings/appearance"() {
    return t({ message: "Appearance" });
  },
  get "/settings/chat"() {
    return t({ message: "Chat" });
  },
  get "/settings/diffs"() {
    return t({ message: "Diffs & pull requests" });
  },
  get "/settings/keybindings"() {
    return t({ message: "Keybindings" });
  },
  "/settings/snap-shot": "SnapShots",
  get "/settings/providers"() {
    return t({ message: "Providers" });
  },
  get "/settings/threads"() {
    return t({ message: "Threads" });
  },
  get "/settings/browser"() {
    return t({ message: "Browser" });
  },
  get "/settings/devices"() {
    return t({ message: "Devices" });
  },
  get "/settings/scheduled-tasks"() {
    return t({ message: "Scheduled tasks" });
  },
  get "/settings/source-control"() {
    return t({ message: "Source control" });
  },
  get "/settings/worktrees"() {
    return t({ message: "Worktrees" });
  },
  get "/settings/connections"() {
    return t({ message: "Environments" });
  },
  get "/settings/access"() {
    return t({ message: "Sharing & access" });
  },
  get "/settings/secrets"() {
    return t({ message: "Secrets" });
  },
  get "/settings/maintenance"() {
    return t({ message: "Maintenance" });
  },
  get "/settings/labs"() {
    return t({ message: "Labs" });
  },
  get "/settings/about"() {
    return t({ message: "About" });
  },
  get "/settings/voice"() {
    return t({ message: "Voice" });
  },
  get "/settings/archived"() {
    return t({ message: "Archive" });
  },
};

/** Sidebar order. A group without a heading is set apart by space alone. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly heading: string | null;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  {
    heading: null,
    paths: [
      "/settings/general",
      "/settings/appearance",
      "/settings/chat",
      "/settings/diffs",
      "/settings/keybindings",
      "/settings/voice",
      "/settings/snap-shot",
    ],
  },
  {
    get heading() {
      return t({ message: "Agents" });
    },
    paths: [
      "/settings/providers",
      "/settings/threads",
      "/settings/browser",
      "/settings/devices",
      "/settings/scheduled-tasks",
    ],
  },
  {
    get heading() {
      return t({ message: "Code" });
    },
    paths: ["/settings/projects", "/settings/source-control", "/settings/worktrees"],
  },
  {
    get heading() {
      return t({ message: "Connections" });
    },
    paths: [
      "/settings/connections",
      "/settings/access",
      ...(isSecretsFeatureEnabled ? (["/settings/secrets"] as const) : []),
    ],
  },
  {
    heading: null,
    paths: ["/settings/maintenance", "/settings/labs", "/settings/about", "/settings/archived"],
  },
];

export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => {
  const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
    (binding) => binding.key,
  );
  return {
    id: keybindingSearchAnchorId(command),
    title: commandLabel(command),
    to: "/settings/keybindings" as const,
    searchTerms: [command, ...defaultKeys],
    secondary: true,
    ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
  };
});

export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** Each host's own settings: its accounts and token, or the fields of its settings form. */
export function sourceControlHostSearchItems(
  definitions: ReadonlyArray<SourceControlDefinition>,
): ReadonlyArray<
  SettingsSearchItem & { readonly id: ReturnType<typeof sourceControlHostSettingsSearchId> }
> {
  return definitions.flatMap((definition) => {
    if (!definition.settings) return [];
    const names = [definition.label, ...(definition.searchKeywords ?? [])].join(" ");
    const { credentials } = definition;
    return [
      {
        id: sourceControlHostSettingsSearchId(definition.kind),
        title: credentials
          ? t`${definition.label} accounts and token`
          : t`${definition.label} credentials`,
        to: "/settings/source-control" as const,
        searchTerms: [
          credentials
            ? `${names} ${credentials.cliName} account login user host switch multiple accounts disable sign in token personal access token pat api key credential`
            : `${names} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
        ],
        environmentOnly: true,
        scope: "environment-defaults" as const,
      },
    ];
  });
}

/** For settings that apply to every host. */
const SOURCE_CONTROL_HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label)
  .join(" ");
const SOURCE_CONTROL_HOST_TERMS = sourceControlClients.definitions
  .flatMap((definition) => [definition.label, ...(definition.searchKeywords ?? [])])
  .join(" ");

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    get title() {
      return t({ message: "Keep worktrees with local changes" });
    },
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "Keep worktrees with local changes",
      "Worktrees",
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    get title() {
      return t({ message: "Delete now" });
    },
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "Delete now",
      "Maintenance",
      "storage cleanup run now results report removed kept failed",
    ],
  },
  {
    id: "storage-worktrees",
    get title() {
      return t({ message: "Worktree cleanup" });
    },
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "Worktree cleanup",
      "Worktrees",
      "disk storage automatic delete deleted archived threads old inactive merged settled unchanged worktrees retention days project inherit off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    get title() {
      return t({ message: "Worktree location" });
    },
    to: "/settings/worktrees",
    scope: "environment-defaults",
    searchTerms: [
      "Worktree location",
      "Worktrees",
      "worktree location folder directory path drive external disk",
    ],
  },
  {
    id: "storage-artifacts",
    get title() {
      return t({ message: "Artifacts and logs" });
    },
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "Artifacts and logs",
      "Maintenance",
      "disk storage delete old browser artifacts screenshots captures rotated logs cleanup retention",
    ],
  },
  {
    id: "project-defaults",
    get title() {
      return t({ message: "Project defaults and overrides" });
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "Project defaults and overrides",
      "Threads",
      "model workspace environments projects inheritance checkout",
    ],
  },
  {
    id: "project-overview",
    get title() {
      return t({ message: "Project overview" });
    },
    to: "/settings/projects",
    searchTerms: ["Project overview", "Projects", "name icon emoji image checkout remove delete"],
  },
  {
    id: "default-model",
    get title() {
      return t({ message: "Default model" });
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["Default model", "Threads", "new thread project provider reasoning effort"],
  },
  {
    id: "fallback-model",
    get title() {
      return t({ message: "Fallback model" });
    },
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["Fallback model", "Threads", "fallback agent provider out of usage new threads"],
    environmentOnly: true,
  },
  {
    id: "default-permissions",
    get title() {
      return t({ message: "Permissions" });
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "Permissions",
      "Threads",
      "new thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    id: "color-scheme",
    get title() {
      return t({ message: "Color scheme" });
    },
    to: "/settings/appearance",
    searchTerms: ["Color scheme", "Appearance", "appearance light dark system mode"],
    targetId: "appearance",
  },
  {
    id: "theme",
    get title() {
      return t({ message: "Themes" });
    },
    to: "/settings/appearance",
    searchTerms: ["Themes", "Appearance", "appearance colors palette custom import"],
    targetId: "appearance",
  },
  {
    id: "interface-language",
    get title() {
      return t({ message: "Interface language" });
    },
    to: "/settings/appearance",
    targetId: "language",
    searchTerms: [
      "Interface language",
      "Appearance",
      "locale language translation Sprache Deutsch English langue français idioma español 中文 语言 简体中文",
    ],
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    get title() {
      return t({ message: "Contrast" });
    },
    to: "/settings/appearance",
    searchTerms: ["Contrast", "Appearance", "colors borders interface"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    get title() {
      return t({ message: "Glass opacity" });
    },
    to: "/settings/appearance",
    searchTerms: [
      "Glass opacity",
      "Appearance",
      "transparent transparency solid menus dialogs composer",
    ],
  },
  {
    id: "diff-color-scheme",
    get title() {
      return t({ message: "Diff colors" });
    },
    to: "/settings/diffs",
    searchTerms: [
      "Diff colors",
      "Diffs & pull requests",
      "red green blue orange additions deletions changes counts palette colorblind",
    ],
  },
  {
    id: "chat-width",
    get title() {
      return t({ message: "Chat width" });
    },
    to: "/settings/appearance",
    searchTerms: [
      "Chat width",
      "Appearance",
      "wide full width column layout messages composer monitor",
    ],
  },
  {
    id: "thread-details-items",
    get title() {
      return t({ message: "Thread details" });
    },
    to: "/settings/appearance",
    searchTerms: [
      "Thread details",
      "Appearance",
      "customize show hide panel card environment editor scripts branch pull request git changes servers automations lineage usage limits 5 hour weekly quota tokens context window",
    ],
  },
  {
    id: "effort-display",
    get title() {
      return t({ message: "Effort display" });
    },
    to: "/settings/appearance",
    searchTerms: [
      "Effort display",
      "Appearance",
      "reasoning effort thinking bars graph word label level composer",
    ],
  },
  {
    id: "math-rendering",
    get title() {
      return t({ message: "Render math" });
    },
    to: "/settings/appearance",
    searchTerms: ["Render math", "Appearance", "latex tex katex equations formulas markdown"],
  },
  {
    searchTerms: ["Panel animations", "Appearance"],

    id: "panel-animations",
    get title() {
      return t({ message: "Panel animations" });
    },
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    get title() {
      return t({ message: "Environment identification" });
    },
    to: "/settings/appearance",
    searchTerms: [
      "Environment identification",
      "Appearance",
      "dev nightly latest channel artwork pill label hide none",
    ],
    targetId: "appearance-interface",
  },
  {
    id: "interface-font",
    get title() {
      return t({ message: "Interface font" });
    },
    to: "/settings/appearance",
    searchTerms: ["Interface font", "Appearance", "typography family size system sans"],
  },
  {
    id: "prompt-font",
    get title() {
      return t({ message: "Prompt font" });
    },
    to: "/settings/appearance",
    searchTerms: ["Prompt font", "Appearance", "typography family size composer input"],
  },
  {
    id: "code-font",
    get title() {
      return t({ message: "Code font" });
    },
    to: "/settings/appearance",
    searchTerms: [
      "Code font",
      "Appearance",
      "typography family size monospace code blocks diffs file previews",
    ],
  },
  {
    id: "terminal-font",
    get title() {
      return t({ message: "Terminal font" });
    },
    to: "/settings/appearance",
    searchTerms: ["Terminal font", "Appearance", "typography family size monospace output"],
  },
  {
    id: "separate-fonts",
    get title() {
      return t({ message: "Separate fonts" });
    },
    to: "/settings/appearance",
    searchTerms: [
      "Separate fonts",
      "Appearance",
      "typography advanced prompt code terminal font family size individually",
    ],
  },
  {
    id: "font-smoothing",
    get title() {
      return t({ message: "Font smoothing" });
    },
    to: "/settings/appearance",
    searchTerms: [
      "Font smoothing",
      "Appearance",
      "typography text grayscale anti aliasing macos thin",
    ],
    macOnly: true,
  },
  {
    id: "word-wrap",
    get title() {
      return t({ message: "Word wrap" });
    },
    to: "/settings/appearance",
    searchTerms: ["Word wrap", "Appearance", "long lines code blocks diffs file previews"],
  },
  {
    searchTerms: ["Composer context", "Appearance"],

    id: "composer-context",
    get title() {
      return t({ message: "Composer context" });
    },
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    get title() {
      return t({ message: "Project grouping" });
    },
    to: "/settings/general",
    searchTerms: [
      "Project grouping",
      "General",
      "combine matching repositories environments sidebar",
    ],
  },
  {
    id: "project-order",
    get title() {
      return t({ message: "Project order" });
    },
    to: "/settings/general",
    searchTerms: ["Project order", "General", "sort projects sidebar manual created recent"],
  },
  {
    id: "snooze-options",
    get title() {
      return t({ message: "Snooze options" });
    },
    to: "/settings/threads",
    searchTerms: [
      "Snooze options",
      "Threads",
      "snooze presets times later tonight tomorrow next week remind",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "snooze-limited-threads",
    get title() {
      return t({ message: "Snooze until limits reset" });
    },
    to: "/settings/threads",
    searchTerms: [
      "Snooze until limits reset",
      "Threads",
      "usage quota rate limit reset wake recover continue",
    ],
  },
  {
    id: "auto-resume-limited-threads",
    get title() {
      return t({ message: "Resume after usage limits" });
    },
    to: "/settings/threads",
    searchTerms: [
      "Resume after usage limits",
      "Threads",
      "usage quota rate limit reset recover continue",
    ],
  },
  {
    id: "working-shelf",
    get title() {
      return t({ message: "Working section" });
    },
    to: "/settings/general",
    searchTerms: [
      "Working section",
      "General",
      "hide fold running monitoring threads inbox sidebar shelf",
    ],
  },
  {
    id: "boring-sidebar",
    get title() {
      return t({ message: "Boring sidebar (group by project)" });
    },
    to: "/settings/labs",
    searchTerms: [
      "Boring sidebar (group by project)",
      "Labs",
      "beta folders project tree classic sidebar",
    ],
  },
  {
    id: "boring-sidebar-multiline",
    get title() {
      return t({ message: "Two-line folder rows" });
    },
    to: "/settings/labs",
    // Shown inside the boring sidebar row only while it is on, so search lands on the parent.
    targetId: "boring-sidebar",
    searchTerms: [
      "Two-line folder rows",
      "Labs",
      "beta boring sidebar folder rows multiline branch pull request details",
    ],
  },
  {
    id: "tool-call-visibility",
    get title() {
      return t({ message: "Tool calls in chat" });
    },
    to: "/settings/chat",
    searchTerms: [
      "Tool calls in chat",
      "Chat",
      "hide tool calls commands edits searches work log activity quiet chat zen final answers only",
    ],
  },
  {
    id: "guest-links",
    get title() {
      return t({ message: "Guest links" });
    },
    to: "/settings/labs",
    scope: "environment",
    searchTerms: [
      "Guest links",
      "Labs",
      "beta share guest invite link teammate watch t3 connect tunnel",
    ],
  },
  {
    id: "linked-environments-beta",
    get title() {
      return t({ message: "Linked environments" });
    },
    to: "/settings/labs",
    scope: "environment",
    searchTerms: [
      "Linked environments",
      "Labs",
      "beta link another machine vps peer agents work there delegate",
    ],
  },
  {
    id: "prompt-suggestions-beta",
    get title() {
      return t({ message: "Suggest next prompt" });
    },
    to: "/settings/labs",
    scope: "environment",
    searchTerms: [
      "Suggest next prompt",
      "Labs",
      "beta tab autocomplete predict next message claude codex ghost text",
    ],
  },
  {
    id: "simlock-hosts",
    get title() {
      return t({ message: "Simlock device hosts (alpha)" });
    },
    to: "/settings/labs",
    scope: "environment",
    searchTerms: [
      "Simlock device hosts (alpha)",
      "Labs",
      "beta alpha simlock callstack simulator emulator ios android pool lease gateway",
    ],
  },
  {
    id: "worktree-fast-checkout",
    get title() {
      return t({ message: "Fast worktree checkout" });
    },
    to: "/settings/labs",
    scope: "environment",
    fastWorktreeCheckoutOnly: true,
    searchTerms: [
      "Fast worktree checkout",
      "Labs",
      "beta fast worktree checkout clone apfs copy-on-write cache macos speed",
    ],
  },
  {
    id: "voice-transcription-destination",
    get title() {
      return t({ message: "Transcribe with" });
    },
    to: "/settings/voice",
    searchTerms: [
      "Transcribe with",
      "Voice",
      "send microphone audio dictation destination speech voice stt transcription environment machine consent privacy cloud OpenAI Grok OpenRouter",
    ],
  },
  {
    id: "voice-microphone",
    get title() {
      return t({ message: "Microphone" });
    },
    to: "/settings/voice",
    searchTerms: ["Microphone", "Voice", "mic input audio device"],
  },
  {
    id: "dictation-shortcut-mode",
    get title() {
      return t({ message: "Dictation shortcut" });
    },
    to: "/settings/voice",
    searchTerms: ["Dictation shortcut", "Voice", "speech voice keyboard hotkey hold toggle auto"],
  },
  {
    id: "speech-language",
    get title() {
      return t({ message: "Transcription language" });
    },
    to: "/settings/voice",
    searchTerms: ["Transcription language", "Voice", "speech voice translate english auto detect"],
  },
  {
    id: "speech-dictionary",
    get title() {
      return t({ message: "Dictionary" });
    },
    to: "/settings/voice",
    searchTerms: [
      "Dictionary",
      "Voice",
      "speech voice transcription vocabulary names glossary alias",
    ],
  },
  {
    id: "speech-project-dictionary",
    get title() {
      return t({ message: "Project dictionary" });
    },
    to: "/settings/voice",
    scope: "project-defaults",
    searchTerms: [
      "Project dictionary",
      "Voice",
      "speech voice transcription vocabulary shared dictionary team environment glossary",
    ],
  },
  {
    id: "speech-post-processing-model",
    get title() {
      return t({ message: "Cleanup model" });
    },
    to: "/settings/voice",
    scope: "environment",
    searchTerms: [
      "Cleanup model",
      "Voice",
      "speech voice transcript cleanup provider model post-processing",
    ],
  },
  {
    id: "speech-correction-word",
    get title() {
      return t({ message: "Correction cue" });
    },
    to: "/settings/voice",
    searchTerms: ["Correction cue", "Voice", "speech voice cleanup sorry scratch that fix mistake"],
  },
  {
    id: "speech-silence-filtering",
    get title() {
      return t({ message: "Silence filtering" });
    },
    to: "/settings/voice",
    searchTerms: ["Silence filtering", "Voice", "voice speech vad silero pauses noise"],
  },
  {
    id: "remove-filler-words",
    get title() {
      return t({ message: "Remove filler words" });
    },
    to: "/settings/voice",
    searchTerms: [
      "Remove filler words",
      "Voice",
      "voice speech transcription hesitation um uh cleanup",
    ],
  },
  {
    id: "speech-post-processing",
    get title() {
      return t({ message: "Clean up transcripts" });
    },
    to: "/settings/voice",
    searchTerms: [
      "Clean up transcripts",
      "Voice",
      "speech transcription polish clean provider prompt post-processing",
    ],
  },
  {
    id: "speech-models",
    get title() {
      return t({ message: "Transcription models" });
    },
    to: "/settings/voice",
    searchTerms: [
      "Transcription models",
      "Voice",
      "speech voice stt download whisper parakeet canary moonshine accuracy speed benchmark languages",
    ],
  },
  {
    id: "speech-hardware",
    get title() {
      return t({ message: "Transcription hardware and model unloading" });
    },
    to: "/settings/voice",
    searchTerms: [
      "Transcription hardware and model unloading",
      "Voice",
      "speech voice stt advanced gpu cpu acceleration memory unload idle",
    ],
  },
  {
    id: "microphone-test",
    get title() {
      return t({ message: "Test microphone" });
    },
    to: "/settings/voice",
    searchTerms: [
      "Test microphone",
      "Voice",
      "test mic audio playback loopback record input level",
    ],
  },
  {
    id: "transcription-test",
    get title() {
      return t({ message: "Test model" });
    },
    to: "/settings/voice",
    searchTerms: ["Test model", "Voice", "test voice speech model transcription recognition"],
  },
  {
    id: "auto-settle-inactive-threads",
    get title() {
      return t({ message: "Auto-settle inactive threads" });
    },
    to: "/settings/threads",
    searchTerms: [
      "Auto-settle inactive threads",
      "Threads",
      "sidebar inactivity days no activity automatically",
    ],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "compact-idle-threads",
    get title() {
      return t({ message: "Compact idle threads" });
    },
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: [
      "Compact idle threads",
      "Providers",
      "claude context compaction idle cache tokens usage summary resume",
    ],
  },
  {
    id: "auto-settle-merged-threads",
    get title() {
      return t({ message: "Auto-settle merged threads" });
    },
    to: "/settings/threads",
    searchTerms: [
      "Auto-settle merged threads",
      "Threads",
      "pull request merge closed automatically sidebar",
    ],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "keep-threads-with-pull-requests",
    get title() {
      return t({ message: "Keep threads with a PR" });
    },
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: [
      "Keep threads with a PR",
      "Threads",
      "pull request inactivity auto-settle merge close sidebar",
    ],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    get title() {
      return t({ message: "Days of inactivity before auto-settle" });
    },
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: [
      "Days of inactivity before auto-settle",
      "Threads",
      "thread timeout activity sidebar",
    ],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    get title() {
      return t({ message: "Thread notifications" });
    },
    to: "/settings/general",
    searchTerms: [
      "Thread notifications",
      "General",
      "notification sound alert completion input approval desktop",
    ],
  },
  {
    id: "in-app-notifications",
    get title() {
      return t({ message: "In-app notifications" });
    },
    to: "/settings/general",
    searchTerms: [
      "In-app notifications",
      "General",
      "notification toast popup completion input approval failure",
    ],
  },
  {
    id: "time-format",
    get title() {
      return t({ message: "Time format" });
    },
    to: "/settings/general",
    searchTerms: [
      "Time format",
      "General",
      "timestamp clock locale system browser os 12 hour 24 hour",
    ],
  },
  {
    id: "response-streaming",
    get title() {
      return t({ message: "Response streaming" });
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "Response streaming",
      "Threads",
      "output token paragraph buffered wait turn legacy",
    ],
  },
  {
    id: "hide-whitespace-changes",
    get title() {
      return t({ message: "Hide whitespace changes" });
    },
    to: "/settings/diffs",
    searchTerms: [
      "Hide whitespace changes",
      "Diffs & pull requests",
      "diff ignore spaces edits default",
    ],
  },
  {
    id: "default-diff-file-state",
    get title() {
      return t({ message: "Default diff file state" });
    },
    to: "/settings/diffs",
    searchTerms: [
      "Default diff file state",
      "Diffs & pull requests",
      "collapsed expanded collapse expand files pull request pr code tab",
    ],
  },
  {
    id: "diff-layout",
    get title() {
      return t({ message: "Diff layout" });
    },
    to: "/settings/diffs",
    searchTerms: [
      "Diff layout",
      "Diffs & pull requests",
      "stacked split side by side unified inline view",
    ],
  },
  {
    id: "proactive-panels",
    get title() {
      return t({ message: "Open pull requests and changes panels proactively" });
    },
    to: "/settings/diffs",
    searchTerms: [
      "Open pull requests and changes panels proactively",
      "Diffs & pull requests",
      "proactive automatically open diff pull request pr right panel agent completion",
    ],
  },
  {
    id: "skills-in-slash-menu",
    get title() {
      return t({ message: "Show skills in slash menu" });
    },
    to: "/settings/chat",
    searchTerms: ["Show skills in slash menu", "Chat", "command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    get title() {
      return t({ message: "Rich text composer" });
    },
    to: "/settings/chat",
    searchTerms: [
      "Rich text composer",
      "Chat",
      "composer rich text tiptap bold italic markdown styled wysiwyg",
    ],
  },
  {
    id: "send-shortcut",
    get title() {
      return t({ message: "Send shortcut" });
    },
    to: "/settings/chat",
    searchTerms: [
      "Send shortcut",
      "Chat",
      "enter return command ctrl multiline prompt new line composer",
    ],
  },
  {
    id: "follow-up-behavior",
    get title() {
      return t({ message: "Follow-up behavior" });
    },
    to: "/settings/chat",
    searchTerms: [
      "Follow-up behavior",
      "Chat",
      "queue steer running turn send default behavior composer",
    ],
  },
  {
    id: "provider-update-checks",
    get title() {
      return t({ message: "Provider update checks" });
    },
    to: "/settings/maintenance",
    searchTerms: [
      "Provider update checks",
      "Maintenance",
      "installed cli versions newer available codex claude cursor grok fx kiro opencode",
    ],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    get title() {
      return t({ message: "Continue threads after restarts" });
    },
    to: "/settings/maintenance",
    scope: "project-defaults",
    searchTerms: [
      "Continue threads after restarts",
      "Maintenance",
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    get title() {
      return t({ message: "Background activity" });
    },
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "Background activity",
      "Maintenance",
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    get title() {
      return t({ message: "New threads" });
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["New threads", "Threads", "default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    get title() {
      return t({ message: "Submodules" });
    },
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "Submodules",
      "Worktrees",
      "git submodule init recursive top-level none worktree t3.json",
    ],
  },
  {
    id: "start-from-origin",
    get title() {
      return t({ message: "Start from remote" });
    },
    to: "/settings/worktrees",
    scope: "project-defaults",
    searchTerms: [
      "Start from remote",
      "Worktrees",
      "new worktrees start remote origin latest fetched branch local",
    ],
  },
  {
    id: "add-project-starts-in",
    get title() {
      return t({ message: "Add project starts in" });
    },
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["Add project starts in", "Threads", "base directory folder browser path home"],
  },
  {
    id: "ghq-clone-layout",
    get title() {
      return t({ message: "Clone into host folders" });
    },
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: [
      "Clone into host folders",
      "Threads",
      "ghq clone destination host owner repository root layout",
    ],
  },
  {
    id: "unpin-confirmation",
    get title() {
      return t({ message: "Unpin confirmation" });
    },
    to: "/settings/general",
    searchTerms: ["Unpin confirmation", "General", "ask before thread pinned section"],
  },
  {
    id: "archive-confirmation",
    get title() {
      return t({ message: "Archive confirmation" });
    },
    to: "/settings/general",
    searchTerms: [
      "Archive confirmation",
      "General",
      "ask before thread second click inline action",
    ],
  },
  {
    id: "delete-confirmation",
    get title() {
      return t({ message: "Delete confirmation" });
    },
    to: "/settings/general",
    searchTerms: ["Delete confirmation", "General", "ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    get title() {
      return t({ message: "Quit shortcut" });
    },
    to: "/settings/general",
    searchTerms: [
      "Quit shortcut",
      "General",
      "confirmation desktop app exit direct hold double click press twice",
    ],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    get title() {
      return t({ message: "Text generation model" });
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "Text generation model",
      "Threads",
      "generated thread titles source control content default provider",
    ],
  },
  {
    id: "thread-title-instructions",
    get title() {
      return t({ message: "Thread title instructions" });
    },
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "Thread title instructions",
      "Threads",
      "generated thread titles prompt custom style naming rename regenerate",
    ],
  },
  {
    id: "app-version",
    get title() {
      return t({ message: "Version" });
    },
    to: "/settings/about",
    searchTerms: ["Version", "About", "about check for updates download install upgrade release"],
  },
  {
    id: "update-track",
    get title() {
      return t({ message: "Update track" });
    },
    to: "/settings/about",
    searchTerms: ["Update track", "About", "release channel stable latest nightly prerelease"],
    releaseChannelOnly: true,
  },
  {
    id: "cli-command",
    get title() {
      return t({ message: "t3 command" });
    },
    to: "/settings/about",
    searchTerms: ["t3 command", "About", "cli terminal shell path install command line"],
    desktopOnly: true,
  },
  {
    id: "mobile-app",
    get title() {
      return t({ message: "Mobile app" });
    },
    to: "/settings/about",
    searchTerms: [
      "Mobile app",
      "About",
      "phone tablet iPhone iPad iOS Android App Store Google Play QR",
    ],
  },
  {
    id: "privacy-policy",
    get title() {
      return t({ message: "Privacy policy" });
    },
    to: "/settings/about",
    searchTerms: [
      "Privacy policy",
      "About",
      "telemetry analytics usage data tracking legal opt out",
    ],
  },
  {
    id: "telemetry-export",
    get title() {
      return t({ message: "OpenTelemetry export" });
    },
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: [
      "OpenTelemetry export",
      "Diagnostics",
      "OTel OTLP telemetry export endpoints logs traces metrics Grafana",
    ],
  },
  {
    id: "diagnostics",
    get title() {
      return t({ message: "Diagnostics" });
    },
    to: "/settings/maintenance",
    searchTerms: [
      "Diagnostics",
      "Maintenance",
      "logs traces processes resource history failures spans cpu memory",
    ],
  },
  {
    searchTerms: ["Open source licenses", "About"],

    id: "open-source-licenses",
    get title() {
      return t({ message: "Open source licenses" });
    },
    to: "/settings/about",
  },
  {
    id: "keybindings",
    get title() {
      return t({ message: "Keybindings" });
    },
    to: "/settings/keybindings",
    searchTerms: [
      "Keybindings",
      "Keybindings",
      "keyboard shortcuts hotkeys commands bindings json",
    ],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "snap-shot-enabled",
    title: "SnapShots",
    searchTerms: ["window capture screenshot"],
    to: "/settings/snap-shot",
  },
  {
    id: "snap-shot-accessibility",
    get title() {
      return t({ message: "Include app text" });
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
    searchTerms: [
      "Include app text",
      "SnapShots",
      "capture accessibility data text UI structure elements privacy omit agent context",
    ],
  },
  {
    searchTerms: ["Capture shortcut", "SnapShots"],

    id: "snap-shot-shortcut",
    get title() {
      return t({ message: "Capture shortcut" });
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    searchTerms: ["Capture sound", "SnapShots"],

    id: "snap-shot-sound",
    get title() {
      return t({ message: "Capture sound" });
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    searchTerms: ["Capture flash", "SnapShots"],

    id: "snap-shot-flash",
    get title() {
      return t({ message: "Capture flash" });
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    searchTerms: ["Capture animations", "SnapShots"],

    id: "snap-shot-animations",
    get title() {
      return t({ message: "Capture animations" });
    },
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "providers",
    get title() {
      return t({ message: "Providers" });
    },
    to: "/settings/providers",
    searchTerms: [
      "Providers",
      "Providers",
      "agents cli codex claude cursor grok fx kiro opencode antigravity google sign in sign out install subscription instances authentication api key models configuration binary path config directory codex_home shadow home endpoint arguments environment variables display name accent color custom favorite hidden auto compact native sessions import resume",
    ],
  },
  {
    id: "usage-providers",
    get title() {
      return t({ message: "Usage providers" });
    },
    to: "/settings/providers",
    searchTerms: [
      "Usage providers",
      "Providers",
      "usage sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "text-generators",
    get title() {
      return t({ message: "Text generators" });
    },
    to: "/settings/providers",
    searchTerms: [
      "Text generators",
      "Providers",
      "model api api key openai openrouter anthropic ollama lm studio custom endpoint base url thread titles commit messages",
    ],
    providerSettingsOnly: true,
    textGeneratorsOnly: true,
  },
  {
    id: "provider-health-check-interval",
    get title() {
      return t({ message: "Health check interval" });
    },
    to: "/settings/providers",
    searchTerms: [
      "Health check interval",
      "Providers",
      "refresh availability versions auth state models background probes seconds off",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "agent-browser-access",
    get title() {
      return t({ message: "Agent browser access" });
    },
    to: "/settings/browser",
    scope: "project-defaults",
    searchTerms: [
      "Agent browser access",
      "Browser",
      "allow disable enable open drive preview tools sessions project override",
    ],
  },
  {
    id: "device-sources",
    get title() {
      return t({ message: "Device sources" });
    },
    to: "/settings/devices",
    searchTerms: [
      "Device sources",
      "Devices",
      "device hosts ssh remote mac mini identity key connection eas expo cloud simlock pool gateway local simulators",
    ],
  },
  {
    id: "agent-device-access",
    get title() {
      return t({ message: "Agents can use devices" });
    },
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: [
      "Agents can use devices",
      "Devices",
      "allow simulator emulator ios android drive tools sessions",
    ],
  },
  {
    id: "device-hub",
    get title() {
      return t({ message: "Use devices" });
    },
    to: "/settings/devices",
    targetId: "devices",
    searchTerms: [
      "Use devices",
      "Devices",
      "device hub simulator emulator ios android install start version",
    ],
  },
  {
    id: "device-platform-support",
    get title() {
      return t({ message: "Local simulators" });
    },
    to: "/settings/devices",
    targetId: "device-sources",
    searchTerms: [
      "Local simulators",
      "Devices",
      "simulator support xcode android studio sdk avd runtime",
    ],
  },
  {
    searchTerms: ["Browser profiles", "Browser"],

    id: "browser-profiles",
    get title() {
      return t({ message: "Browser profiles" });
    },
    to: "/settings/browser",
    targetId: "browser",
  },
  {
    searchTerms: ["Default browser profile", "Browser"],

    id: "browser-default-profile",
    get title() {
      return t({ message: "Default browser profile" });
    },
    to: "/settings/browser",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    get title() {
      return t({ message: "Default browser viewport" });
    },
    to: "/settings/browser",
    searchTerms: [
      "Default browser viewport",
      "Browser",
      "preview size width height device desktop mobile rotate",
    ],
  },
  {
    id: "browser-default-zoom",
    get title() {
      return t({ message: "Default browser zoom" });
    },
    to: "/settings/browser",
    searchTerms: ["Default browser zoom", "Browser", "preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    get title() {
      return t({ message: "Default browser appearance" });
    },
    to: "/settings/browser",
    searchTerms: [
      "Default browser appearance",
      "Browser",
      "preview color scheme light dark system os",
    ],
  },
  {
    searchTerms: ["Browser recording frame rate", "Browser"],

    id: "browser-recording-frame-rate",
    get title() {
      return t({ message: "Browser recording frame rate" });
    },
    to: "/settings/browser",
  },
  {
    id: "browser-recording-key-presses",
    get title() {
      return t({ message: "Show key presses in recordings" });
    },
    to: "/settings/browser",
    searchTerms: [
      "Show key presses in recordings",
      "Browser",
      "browser preview keyboard shortcuts keystrokes overlay capture",
    ],
  },
  {
    id: "browser-recording-mouse-presses",
    get title() {
      return t({ message: "Show mouse presses in recordings" });
    },
    to: "/settings/browser",
    searchTerms: [
      "Show mouse presses in recordings",
      "Browser",
      "browser preview clicks buttons drag overlay capture",
    ],
  },
  {
    id: "browser-link-target",
    get title() {
      return t({ message: "Open links in" });
    },
    to: "/settings/browser",
    searchTerms: ["Open links in", "Browser", "links default browser in-app browser external open"],
  },
  {
    id: "browser-search-engine",
    get title() {
      return t({ message: "Search engine" });
    },
    to: "/settings/browser",
    searchTerms: [
      "Search engine",
      "Browser",
      "address bar duckduckgo google bing brave kagi ecosia custom url",
    ],
  },
  {
    id: "pull-request-links-open-in-app",
    get title() {
      return t({ message: "Open pull requests in T3 Code" });
    },
    to: "/settings/diffs",
    searchTerms: [
      "Open pull requests in T3 Code",
      "Diffs & pull requests",
      `pr commit links ${SOURCE_CONTROL_HOST_LABELS} browser external click default pull request view panel`,
    ],
  },
  {
    id: "browser-auto-show-floating-preview",
    get title() {
      return t({ message: "Auto-show floating preview" });
    },
    to: "/settings/browser",
    searchTerms: [
      "Auto-show floating preview",
      "Browser",
      "agent opens browser device simulator pop into view hide",
    ],
  },
  {
    id: "automatic-pull",
    get title() {
      return t({ message: "Automatically pull" });
    },
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      "Automatically pull",
      "Source control",
      "auto pull default branch current checkout fast forward upstream",
    ],
  },
  {
    id: "remove-agent-credits-on-merge",
    get title() {
      return t({ message: "Remove agent credits when merging" });
    },
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      "Remove agent credits when merging",
      "Source control",
      `pull request ${SOURCE_CONTROL_HOST_LABELS} squash co-authored-by attribution claude codex generated`,
    ],
  },
  {
    id: "pull-request-merge-method",
    get title() {
      return t({ message: "Default merge method" });
    },
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: [
      "Default merge method",
      "Source control",
      "pull request merge squash rebase last selected",
    ],
  },
  {
    id: "source-control",
    get title() {
      return t({ message: "Source control" });
    },
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: [
      "Source control",
      "Source control",
      `version control git ${SOURCE_CONTROL_HOST_TERMS} hosting integrations credentials scan server environment`,
    ],
  },
  {
    id: "git-fetch-interval",
    get title() {
      return t({ message: "Git fetch interval" });
    },
    to: "/settings/maintenance",
    targetId: "background-activity",
    searchTerms: [
      "Git fetch interval",
      "Maintenance",
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    get title() {
      return t({ message: "Worktree branch naming" });
    },
    to: "/settings/worktrees",
    searchTerms: [
      "Worktree branch naming",
      "Worktrees",
      "static semantic prefix custom prompt instructions feat fix refactor chore",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  ...sourceControlHostSearchItems(sourceControlClients.definitions),
  {
    id: "source-control-writing-style",
    get title() {
      return t({ message: "Source control writing style" });
    },
    to: "/settings/source-control",
    searchTerms: [
      "Source control writing style",
      "Source control",
      "repository conventions conventional commits custom instructions change descriptions request titles",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    get title() {
      return t({ message: "Follow change request templates" });
    },
    to: "/settings/source-control",
    searchTerms: [
      "Follow change request templates",
      "Source control",
      "repository pr pull request description structure",
    ],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    get title() {
      return t({ message: "Source control writer model" });
    },
    to: "/settings/source-control",
    searchTerms: [
      "Source control writer model",
      "Source control",
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guides",
    get title() {
      return t({ message: "Review guides (beta)" });
    },
    to: "/settings/source-control",
    searchTerms: [
      "Review guides (beta)",
      "Source control",
      "pull request pr guided review guide tour beta experimental",
    ],
    environmentOnly: true,
  },
  {
    id: "review-guide-model",
    get title() {
      return t({ message: "Review guide model" });
    },
    to: "/settings/source-control",
    // Hidden until review guides are on, so a search lands on the switch that shows it.
    targetId: "review-guides",
    searchTerms: [
      "Review guide model",
      "Source control",
      "pull request pr guided review guide brief maintainer",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "review-guide-instructions",
    get title() {
      return t({ message: "Review guide instructions" });
    },
    to: "/settings/source-control",
    targetId: "review-guides",
    searchTerms: [
      "Review guide instructions",
      "Source control",
      "pull request pr guided review guide preferences taste prompt custom",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    get title() {
      return t({ message: "Actions" });
    },
    to: "/settings/projects",
    searchTerms: [
      "Actions",
      "Projects",
      "commands scripts setup run dev server checkout worktree t3.json import",
    ],
  },
  {
    id: "environment-icon",
    get title() {
      return t({ message: "Environment icon" });
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "Environment icon",
      "Sharing & access",
      "machine glyph sidebar mac mini studio laptop desktop server cloud vm",
    ],
  },
  {
    id: "local-environment",
    get title() {
      return t({ message: "Local environment" });
    },
    to: "/settings/connections",
    searchTerms: [
      "Local environment",
      "Environments",
      "turn off on disable enable local server agents remote only restart",
    ],
    desktopOnly: true,
  },
  {
    id: "network-access",
    get title() {
      return t({ message: "Network access" });
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "Network access",
      "Sharing & access",
      "expose backend remote pairing local machine interfaces host restart",
    ],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    get title() {
      return t({ message: "Tailscale HTTPS" });
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "Tailscale HTTPS",
      "Sharing & access",
      "serve magicdns endpoint remote secure network",
    ],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    get title() {
      return t({ message: "WSL backend" });
    },
    to: "/settings/access",
    searchTerms: [
      "WSL backend",
      "Sharing & access",
      "windows subsystem linux distro second server projects stop windows backend restart wsl only",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "t3-connect",
    localEnvironmentOnly: true,
    get title() {
      return t({ message: "T3 Connect" });
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "T3 Connect",
      "Sharing & access",
      "managed tunnel cloud other devices remote tunnels limit t3 chat",
    ],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    get title() {
      return t({ message: "Hold webhooks while offline" });
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "Hold webhooks while offline",
      "Sharing & access",
      "webhook automations offline queue mailbox t3 connect",
    ],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    get title() {
      return t({ message: "Publish agent activity" });
    },
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [
      "Publish agent activity",
      "Sharing & access",
      "mobile push notifications live activities cloud tunnel",
    ],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    get title() {
      return t({ message: "This machine" });
    },
    to: "/settings/access",
    searchTerms: [
      "This machine",
      "Sharing & access",
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
    ],
  },
  {
    id: "linked-environments",
    peerLinksOnly: true,
    get title() {
      return t({ message: "Linked environments" });
    },
    to: "/settings/connections",
    targetId: "linked-environments",
    searchTerms: [
      "Linked environments",
      "Environments",
      "link peer another machine vps agents work there handoff pairing code",
    ],
  },
  {
    id: "remote-environments",
    get title() {
      return t({ message: "Environments" });
    },
    to: "/settings/connections",
    searchTerms: [
      "Environments",
      "Environments",
      "add pair backend host code ssh config agent tunnel saved t3 connect",
    ],
  },
  {
    id: "load-balancing",
    get title() {
      return t({ message: "Load balancing" });
    },
    to: "/settings/connections",
    searchTerms: [
      "Load balancing",
      "Environments",
      "automatic machine environment resources cpu memory capacity preference weight shared projects",
    ],
  },
  {
    id: "pull-request-routing",
    get title() {
      return t({ message: "Pull request sharing" });
    },
    to: "/settings/connections",
    searchTerms: [
      "Pull request sharing",
      "Environments",
      `pull request routing trusted environments shared credentials permissions read actions source control ${SOURCE_CONTROL_HOST_LABELS}`,
    ],
  },
  {
    id: "secret-providers",
    get title() {
      return t({ message: "Secret providers" });
    },
    to: "/settings/secrets",
    searchTerms: ["Secret providers", "Secrets", "1password vault credentials api key"],
    secretsFeatureOnly: true,
  },
  {
    id: "secret-providers-add",
    get title() {
      return t({ message: "Add secret provider" });
    },
    to: "/settings/secrets",
    targetId: "secret-providers",
    searchTerms: ["Add secret provider", "Secrets", "new 1password vault op cli account"],
    secretsFeatureOnly: true,
  },
  {
    id: "archive",
    get title() {
      return t({ message: "Archived threads" });
    },
    to: "/settings/archived",
    searchTerms: ["Archived threads", "Archive", "restore reopen deleted history projects"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/diagnostics": "environment",
  "/settings/projects": "project",
  "/settings/general": null,
  "/settings/voice": null,
  "/settings/appearance": null,
  "/settings/chat": null,
  "/settings/diffs": null,
  "/settings/snap-shot": null,
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/threads": null,
  "/settings/browser": null,
  "/settings/devices": null,
  "/settings/source-control": "environment-defaults",
  "/settings/worktrees": "project-defaults",
  "/settings/connections": "connections",
  "/settings/access": "connections",
  "/settings/secrets": null,
  "/settings/scheduled-tasks": null,
  "/settings/maintenance": null,
  "/settings/labs": null,
  "/settings/about": null,
  "/settings/archived": "project-defaults",
};

const RENAMED_SETTINGS_PATHS: Readonly<Record<string, SettingsPath>> = {
  "/settings/integrations": "/settings/browser",
  "/settings/storage": "/settings/maintenance",
  "/settings/beta": "/settings/labs",
};
const SPLIT_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/source-control",
  "/settings/connections",
  ...Object.keys(RENAMED_SETTINGS_PATHS),
]);
// Section anchors that moved but are not search results themselves.
const MOVED_SECTION_ANCHORS: Readonly<Record<string, SettingsPath>> = {
  "authorized-clients": "/settings/access",
  "text-generation": "/settings/threads",
  about: "/settings/about",
};

/** Where an old settings link now lives. Its anchor finds the page its row moved to. */
export function movedSettingsPath(pathname: string, hash: string): SettingsPath | null {
  if (!SPLIT_SETTINGS_PATHS.has(pathname)) return null;
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const anchored = hash
    ? (items.find((item) => item.id === hash) ?? items.find((item) => item.targetId === hash))
    : undefined;
  const to =
    anchored?.to ?? MOVED_SECTION_ANCHORS[hash] ?? RENAMED_SETTINGS_PATHS[pathname] ?? null;
  return to === pathname ? null : to;
}

export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to],
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}

export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected.map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true) &&
      (!item.peerLinksOnly || availability.hasPeerLinkHost === true) &&
      (!item.fastWorktreeCheckoutOnly ||
        availability.hasFastWorktreeCheckoutEnvironment === true) &&
      (!item.textGeneratorsOnly || availability.hasTextGeneratorsEnvironment === true),
  );
}

/** The settings that exist on this platform and app channel. */
export function settingsForThisPlatform(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      (!item.releaseChannelOnly || isElectron || HOSTED_APP_CHANNEL !== null) &&
      (!item.secretsFeatureOnly || isSecretsFeatureEnabled) &&
      (!item.macOnly || isMacPlatform(platform)) &&
      (!item.windowsOnly || isWindowsPlatform(platform)),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

// These rows only exist with separate fonts on, so a search jump to one turns them on.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
]);

export function isAdvancedTypographyTarget(targetId: string): boolean {
  return ADVANCED_TYPOGRAPHY_TARGET_IDS.has(targetId);
}

/**
 * Opens the persisted section a search result lives in before jumping to it, so
 * its row is mounted to scroll to. The terminal reads the same flag, so it must
 * stay on after the jump.
 */
export function revealSettingsSearchTarget(targetId: string): void {
  if (isAdvancedTypographyTarget(targetId)) {
    writeLocalStorageValue(TYPOGRAPHY_ADVANCED_STORAGE_KEY, true, false, Schema.Boolean);
  }
}
