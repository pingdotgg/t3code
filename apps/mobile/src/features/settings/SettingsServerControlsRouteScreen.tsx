import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { useNavigation } from "@react-navigation/native";
import { SettingsRow } from "./components/SettingsRow";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import {
  type ResponseStreamingMode,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadEnvMode,
  type WorktreeSubmodules,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  RUNTIME_MODE_CHOICES,
  withManagedRuntimeModeLimits,
} from "../threads/thread-settings-options";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { BranchNamingSettings } from "./components/BranchNamingSettings";
import { DatabaseStorageNotice } from "./components/DatabaseStorageNotice";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { IssueTrackerSection } from "./components/IssueTrackerSection";
import { SourceControlProvidersSection } from "./components/SourceControlProvidersSection";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useSettingsWriter } from "./useSettingsWriter";
import {
  managedSettingReason,
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { AutoSettleSettingsRows } from "./ThreadSettingsSections";
import { CompletionAudioSettingsRows } from "./CompletionAudioSettingsRows";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";

type SettingsPage = "threads" | "source-control" | "worktrees" | "maintenance";

const PAGE_TITLES: Record<SettingsPage, string> = {
  threads: msg("Threads", { $context: "settings page title" }),
  "source-control": msg("Source control & issues"),
  worktrees: msg("Worktrees"),
  maintenance: msg("Maintenance"),
};

const PAGE_PROJECT_KEYS: Record<SettingsPage, readonly ProjectScopedServerSettingKey[]> = {
  threads: [
    "defaultThreadEnvMode",
    "defaultRuntimeMode",
    "responseStreamingMode",
    "enableAgentBrowserAccess",
    "sidebarAutoSettleOnMerge",
    "sidebarAutoSettleAfterDays",
  ],
  "source-control": ["defaultAutoPull", "removeAgentCreditsOnMerge"],
  worktrees: [
    "newWorktreesStartFromOrigin",
    "worktreeSubmodules",
    "branchNamingMode",
    "branchNamePrefix",
    "branchNameInstructions",
  ],
  maintenance: ["continueThreadsAfterServerUpdate"],
};

const SUBMODULE_CHOICES: ReadonlyArray<{
  readonly mode: WorktreeSubmodules | null;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: null,
    label: msg("Inherit", { $context: "use the inherited value" }),
    description: msg("Use the repository's t3.json, or initialize recursively."),
  },
  {
    mode: "recursive",
    label: msg("Recursive", { $context: "initialize submodules recursively" }),
    description: msg("Initialize nested submodules too."),
  },
  {
    mode: "top-level",
    label: msg("Top level only"),
    description: msg("Skip submodules declared inside other submodules."),
  },
  {
    mode: "none",
    label: msg("Skip", { $context: "do not initialize submodules" }),
    description: msg("Leave submodules empty for a setup script."),
  },
];

const WORKSPACE_CHOICES: ReadonlyArray<{
  readonly mode: ThreadEnvMode | null;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: null,
    label: msg("Inherit", { $context: "use the inherited value" }),
    description: msg("Use the repository's t3.json, or the current checkout."),
  },
  {
    mode: "local",
    label: msg("Current checkout"),
    description: msg("Start new threads in the existing workspace."),
  },
  {
    mode: "worktree",
    label: msg("New worktree"),
    description: msg("Give each new thread a separate checkout."),
  },
];

const STREAMING_CHOICES: ReadonlyArray<{
  readonly mode: ResponseStreamingMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "turn",
    label: msg("After the turn"),
    description: msg("Show the answer when the agent finishes."),
  },
  {
    mode: "paragraph",
    label: msg("Finished paragraphs"),
    description: msg("Show each paragraph or code block as it completes."),
  },
];

// Only servers with thread auto-settlement store these, so other targets get the rest of a patch.
const AUTO_SETTLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
]);

function planServerSettingsWrites(
  targets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
  patch: ServerSettingsPatch,
) {
  const capable = targets.filter((target) => supportsSharedSettingsSync(target.environment));
  const others = targets.filter((target) => !supportsSharedSettingsSync(target.environment));
  const othersPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => !AUTO_SETTLE_SETTING_KEYS.has(key)),
  ) as ServerSettingsPatch;
  return [
    ...planMobileScopedSettingsPatch(capable, projectSelected, patch),
    ...(Object.keys(othersPatch).length > 0
      ? planMobileScopedSettingsPatch(others, projectSelected, othersPatch)
      : []),
  ];
}

export function SettingsThreadsRouteScreen() {
  return <ServerSettingsDetail page="threads" />;
}

export function SettingsEnvironmentSourceControlRouteScreen() {
  return <ServerSettingsDetail page="source-control" />;
}

export function SettingsWorktreesRouteScreen() {
  return <ServerSettingsDetail page="worktrees" />;
}

export function SettingsEnvironmentMaintenanceRouteScreen() {
  return <ServerSettingsDetail page="maintenance" />;
}

function ServerSettingsDetail(props: { readonly page: SettingsPage }) {
  const gt = useGT();
  const m = useMessages();
  const environmentMenu = useSettingsEnvironmentMenu();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  // Closing views can save after controls disable; queue those patches behind the pending write.
  const queuedPatch = useRef<{ key: string; patch: ServerSettingsPatch } | null>(null);
  const targetsKey = targets
    .map((target) => `${target.environment.environmentId}:${target.projectId}`)
    .join(",");
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const canWriteSettings =
    targets.length > 0 &&
    targets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const displayTargets = pendingWrites > 0 && pendingTargets !== null ? pendingTargets : targets;
  const hasConnectedSelection = targets.length > 0;
  const reference = displayTargets[0] ?? null;
  const uniform = <K extends keyof ServerSettings>(key: K) =>
    uniformMobileSetting(displayTargets, key);
  // `uniform` folds a real null into "mixed"; nullable keys need the distinction.
  const isMixed = (key: keyof ServerSettings) =>
    reference === null ||
    displayTargets.some((entry) => entry.settings[key] !== reference.settings[key]);
  const writeSettings = useSettingsWriter();
  const requestRules = reference?.settings.requestRewriteRules ?? [];
  const write = (patch: ServerSettingsPatch) => {
    if (writeInFlight.current) {
      const queued = queuedPatch.current;
      queuedPatch.current = {
        key: targetsKey,
        patch: queued?.key === targetsKey ? { ...queued.patch, ...patch } : patch,
      };
      return;
    }
    if (
      !hasConnectedSelection ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planServerSettingsWrites(targets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void writeSettings(targets, writes).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
      const queued = queuedPatch.current;
      queuedPatch.current = null;
      // These targets may not show this write yet, so send it again with the
      // queued patch; project overrides are replaced whole.
      if (queued?.key === targetsKey) write({ ...patch, ...queued.patch });
    });
  };
  const clearProjectOverrides = () => {
    if (
      writeInFlight.current ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsClear(targets, PAGE_PROJECT_KEYS[props.page]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void writeSettings(targets, writes).finally(() => {
      writeInFlight.current = false;
      // Resending a draft over these pre-clear targets would undo the clear.
      queuedPatch.current = null;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const disabled = !canWriteSettings || pendingWrites > 0 || !hasConnectedSelection;
  const managed = (...keys: string[]) => managedSettingReason(targets, keys, m);
  // A locked row keeps its explanation and says who manages it.
  const managedSubtitle = (key: string, subtitle: string) => {
    const reason = managed(key);
    return reason === undefined ? subtitle : gt("{subtitle} {reason}", { subtitle, reason });
  };
  const runtimeModeChoices = withManagedRuntimeModeLimits(
    RUNTIME_MODE_CHOICES,
    targets.map((target) => target.environment.serverConfig.managedPolicy),
    m,
  );
  const disabledFor = (key: string) =>
    disabled ||
    managed(key) !== undefined ||
    (projectSelected &&
      !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(
        key as (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number],
      ));

  return (
    <SettingsScreen title={m(PAGE_TITLES[props.page])} menus={[environmentMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!hasConnectedSelection || reference === null ? (
          <Text className="px-2 text-base text-foreground-muted">
            {projectSelected
              ? gt("Select a project with a checkout on a connected environment.")
              : gt("Use the filter above to select a connected environment.")}
          </Text>
        ) : (
          <>
            <ManagedPolicyNotice targets={targets} />
            {projectSelected ? (
              <SettingsProjectOverridesSection
                projectLabel={selectedProject?.label ?? gt("Unavailable project")}
                hasOverrides={targets.some((target) =>
                  PAGE_PROJECT_KEYS[props.page].some((key) => target.sources[key] === "project"),
                )}
                pending={pendingWrites > 0}
                disabled={!canWriteSettings}
                onClear={clearProjectOverrides}
              />
            ) : null}
            {props.page === "threads" ? (
              <>
                <SettingsSection
                  title={gt("Default workspace")}
                  footer={managed("defaultThreadEnvMode")}
                  trailing={
                    pendingWrites === 0 && isMixed("defaultThreadEnvMode") ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {WORKSPACE_CHOICES.filter(
                    (choice) => choice.mode !== null || !projectSelected,
                  ).map((choice, index) => (
                    <SettingsChoiceRow
                      key={choice.mode ?? "inherit"}
                      label={m(choice.label)}
                      description={m(choice.description)}
                      selected={
                        !isMixed("defaultThreadEnvMode") &&
                        uniform("defaultThreadEnvMode") === choice.mode
                      }
                      separated={index > 0}
                      disabled={disabledFor("defaultThreadEnvMode")}
                      onPress={() => write({ defaultThreadEnvMode: choice.mode })}
                    />
                  ))}
                </SettingsSection>
                <SettingsSection
                  title={gt("Default permissions")}
                  footer={managed("defaultRuntimeMode")}
                  trailing={
                    pendingWrites === 0 && uniform("defaultRuntimeMode") === null ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {runtimeModeChoices.map((choice, index) => (
                    <SettingsChoiceRow
                      key={choice.mode}
                      label={m(choice.label)}
                      description={choice.disabledReason ?? m(choice.description)}
                      selected={uniform("defaultRuntimeMode") === choice.mode}
                      separated={index > 0}
                      disabled={
                        disabledFor("defaultRuntimeMode") || choice.disabledReason !== undefined
                      }
                      onPress={() => write({ defaultRuntimeMode: choice.mode })}
                    />
                  ))}
                </SettingsSection>
                <SettingsSection
                  title={gt("Response streaming")}
                  footer={managed("responseStreamingMode")}
                  trailing={
                    pendingWrites === 0 && uniform("responseStreamingMode") === null ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {STREAMING_CHOICES.map((choice, index) => (
                    <SettingsChoiceRow
                      key={choice.mode}
                      label={m(choice.label)}
                      description={m(choice.description)}
                      selected={uniform("responseStreamingMode") === choice.mode}
                      separated={index > 0}
                      disabled={disabledFor("responseStreamingMode")}
                      onPress={() => write({ responseStreamingMode: choice.mode })}
                    />
                  ))}
                </SettingsSection>
                <SettingsSection title={gt("Preview browser")}>
                  <SettingsSwitchRow
                    icon="globe"
                    label={gt("Agent browser access")}
                    subtitle={managedSubtitle(
                      "enableAgentBrowserAccess",
                      gt("Allow agents to use the in-app preview browser."),
                    )}
                    value={uniform("enableAgentBrowserAccess")}
                    disabled={disabledFor("enableAgentBrowserAccess")}
                    onValueChange={(value) => write({ enableAgentBrowserAccess: value })}
                  />
                </SettingsSection>
                <SettingsSection title={gt("Automatic additions")}>
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code agent instructions")}
                    subtitle={managedSubtitle(
                      "t3AgentInstructions",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "T3 Code tells each agent session about its own tools. Off removes this from new sessions. The tools stay available.",
                    )}
                    value={uniform("t3AgentInstructions")}
                    disabled={disabledFor("t3AgentInstructions")}
                    onValueChange={(value) => write({ t3AgentInstructions: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code: context handoff")}
                    subtitle={managedSubtitle(
                      "t3ContextHandoff",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off sends no earlier conversation after a provider or model switch, fork, merge back or lost session. The agent starts without that history.",
                    )}
                    value={uniform("t3ContextHandoff")}
                    disabled={disabledFor("t3ContextHandoff")}
                    onValueChange={(value) => write({ t3ContextHandoff: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code: side-chat context")}
                    subtitle={managedSubtitle(
                      "t3SideChatContext",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off starts a side chat without the parent conversation's summary. The agent will not know what the main thread was doing.",
                    )}
                    value={uniform("t3SideChatContext")}
                    disabled={disabledFor("t3SideChatContext")}
                    onValueChange={(value) => write({ t3SideChatContext: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code: restart note")}
                    subtitle={managedSubtitle(
                      "t3RestartNote",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off stops telling the agent which background work a server restart cancelled. It may wait on work that is gone.",
                    )}
                    value={uniform("t3RestartNote")}
                    disabled={disabledFor("t3RestartNote")}
                    onValueChange={(value) => write({ t3RestartNote: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code: wake when a delegated task finishes")}
                    subtitle={managedSubtitle(
                      "t3WakeOnDelegateFinished",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off starts no turn when a delegated task finishes. The agent will not pick up the result on its own.",
                    )}
                    value={uniform("t3WakeOnDelegateFinished")}
                    disabled={disabledFor("t3WakeOnDelegateFinished")}
                    onValueChange={(value) => write({ t3WakeOnDelegateFinished: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code: wake when a delegated task asks")}
                    subtitle={managedSubtitle(
                      "t3WakeOnDelegateQuestion",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off starts no turn when a delegated task asks a question. The task waits until it is answered.",
                    )}
                    value={uniform("t3WakeOnDelegateQuestion")}
                    disabled={disabledFor("t3WakeOnDelegateQuestion")}
                    onValueChange={(value) => write({ t3WakeOnDelegateQuestion: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code: wake on pull request updates")}
                    subtitle={managedSubtitle(
                      "t3WakeOnPullRequestUpdate",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off starts no turn for a watched pull request's checks, reviews and comments. The agent will not react to them.",
                    )}
                    value={uniform("t3WakeOnPullRequestUpdate")}
                    disabled={disabledFor("t3WakeOnPullRequestUpdate")}
                    onValueChange={(value) => write({ t3WakeOnPullRequestUpdate: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code: goal continuation")}
                    subtitle={managedSubtitle(
                      "t3GoalContinuation",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off pauses a goal after each turn instead of sending the next one. Resume the goal to run one more turn.",
                    )}
                    value={uniform("t3GoalContinuation")}
                    disabled={disabledFor("t3GoalContinuation")}
                    onValueChange={(value) => write({ t3GoalContinuation: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("T3 Code: block messages from other threads")}
                    subtitle={managedSubtitle(
                      "agentMessagePolicy",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "On refuses messages that agents in unrelated threads or on linked machines send into a thread. A thread's own delegates are unaffected.",
                    )}
                    value={uniform("agentMessagePolicy") === "block"}
                    disabled={disabledFor("agentMessagePolicy")}
                    onValueChange={(value) =>
                      write({ agentMessagePolicy: value ? "block" : "allow" })
                    }
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("Claude Code: instruction files")}
                    subtitle={managedSubtitle(
                      "claudeInstructionFiles",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off stops Claude Code sending CLAUDE.md files, including your global one. The agent works without your project rules.",
                    )}
                    value={uniform("claudeInstructionFiles")}
                    disabled={disabledFor("claudeInstructionFiles")}
                    onValueChange={(value) => write({ claudeInstructionFiles: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("Claude Code: auto-memory")}
                    subtitle={managedSubtitle(
                      "claudeAutoMemory",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off removes the memory instructions from the system prompt. The agent no longer reads or saves memories.",
                    )}
                    value={uniform("claudeAutoMemory")}
                    disabled={disabledFor("claudeAutoMemory")}
                    onValueChange={(value) => write({ claudeAutoMemory: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("Claude Code: git context")}
                    subtitle={managedSubtitle(
                      "claudeGitContext",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off removes the git status snapshot and commit attribution guidance. The agent must run git itself.",
                    )}
                    value={uniform("claudeGitContext")}
                    disabled={disabledFor("claudeGitContext")}
                    onValueChange={(value) => write({ claudeGitContext: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("Claude Code: skill list")}
                    subtitle={managedSubtitle(
                      "claudeSkillList",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off removes the list of skills. The agent can no longer see skills or run them with its Skill tool.",
                    )}
                    value={uniform("claudeSkillList")}
                    disabled={disabledFor("claudeSkillList")}
                    onValueChange={(value) => write({ claudeSkillList: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("Claude Code: tool, MCP and skill lists")}
                    subtitle={managedSubtitle(
                      "claudeContextLists",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off removes the deferred tool list, MCP server instructions, skill list and token reminders. The agent may not find MCP tools or skills.",
                    )}
                    value={uniform("claudeContextLists")}
                    disabled={disabledFor("claudeContextLists")}
                    onValueChange={(value) => write({ claudeContextLists: value })}
                  />
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("Claude Code: hooks")}
                    subtitle={managedSubtitle(
                      "claudeHooks",
                      projectSelected
                        ? "Environment-wide setting. Select All projects to change it."
                        : "Off stops every Claude Code hook from running, including security and permission hooks.",
                    )}
                    value={uniform("claudeHooks")}
                    disabled={disabledFor("claudeHooks")}
                    onValueChange={(value) => write({ claudeHooks: value })}
                  />
                </SettingsSection>
                {requestRules.length > 0 ? (
                  <SettingsSection title={gt("Request rules")}>
                    {requestRules.map((rule) => (
                      <SettingsSwitchRow
                        key={rule.id}
                        icon="doc.text"
                        label={rule.name.trim() || gt("Unnamed rule")}
                        subtitle={managedSubtitle(
                          "requestRewriteRules",
                          `${rule.action} · ${rule.target}. Applies to Claude sessions opened while it is on. Edit rules on web or desktop.`,
                        )}
                        value={rule.enabled}
                        disabled={
                          disabledFor("requestRewriteRules") || isMixed("requestRewriteRules")
                        }
                        onValueChange={(value) =>
                          write({
                            requestRewriteRules: requestRules.map((candidate) =>
                              candidate.id === rule.id
                                ? { ...candidate, enabled: value }
                                : candidate,
                            ),
                          })
                        }
                      />
                    ))}
                  </SettingsSection>
                ) : null}
                <AutoSettleSettingsRows write={write} pending={pendingWrites > 0} />
                <CompletionAudioSettingsRows />
              </>
            ) : null}

            {props.page === "source-control" ? (
              <>
                {projectSelected ? null : (
                  <SourceControlProvidersSection
                    environments={selectedTargets}
                    canWrite={(environmentId) => writableEnvironments.has(environmentId)}
                  />
                )}
                {projectSelected ? null : <IssueTrackerSection environments={selectedTargets} />}
                <SettingsSection title={gt("Pull requests")}>
                  <SettingsSwitchRow
                    icon={PullRequestGlyph.merged}
                    label={gt("Remove agent credits when merging")}
                    subtitle={managedSubtitle(
                      "removeAgentCreditsOnMerge",
                      gt(
                        "Remove recognized agent credits from merge and squash messages on hosts that support it, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits.",
                      ),
                    )}
                    value={uniform("removeAgentCreditsOnMerge")}
                    disabled={disabledFor("removeAgentCreditsOnMerge")}
                    onValueChange={(value) => write({ removeAgentCreditsOnMerge: value })}
                  />
                </SettingsSection>
                <SettingsSection title={gt("Default branch")}>
                  <SettingsSwitchRow
                    icon="arrow.down.circle"
                    label={gt("Automatically pull")}
                    subtitle={managedSubtitle(
                      "defaultAutoPull",
                      gt("Keep the default branch current when there are no local changes."),
                    )}
                    value={uniform("defaultAutoPull")}
                    disabled={disabledFor("defaultAutoPull")}
                    onValueChange={(value) => write({ defaultAutoPull: value })}
                  />
                </SettingsSection>
                <SettingsSection title={gt("Clones")}>
                  <SettingsSwitchRow
                    icon="folder"
                    label={gt("Clone into host folders")}
                    subtitle={gt("Clones go to {path} under the Add project folder, like {tool}.", {
                      path: "github.com/owner/repo",
                      tool: "ghq",
                    })}
                    value={uniform("ghqCloneLayout")}
                    disabled={disabledFor("ghqCloneLayout")}
                    onValueChange={(value) => write({ ghqCloneLayout: value })}
                  />
                </SettingsSection>
              </>
            ) : null}

            {props.page === "worktrees" ? (
              <>
                <SettingsSection title={gt("New worktrees")}>
                  <SettingsSwitchRow
                    icon="arrow.triangle.branch"
                    label={gt("Start from remote")}
                    subtitle={managedSubtitle(
                      "newWorktreesStartFromOrigin",
                      gt(
                        "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.",
                      ),
                    )}
                    value={uniform("newWorktreesStartFromOrigin")}
                    disabled={disabledFor("newWorktreesStartFromOrigin")}
                    onValueChange={(value) => write({ newWorktreesStartFromOrigin: value })}
                  />
                </SettingsSection>
                <SettingsSection
                  title={gt("Worktree submodules")}
                  footer={managed("worktreeSubmodules")}
                  trailing={
                    pendingWrites === 0 && isMixed("worktreeSubmodules") ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {SUBMODULE_CHOICES.filter(
                    (choice) => choice.mode !== null || !projectSelected,
                  ).map((choice, index) => (
                    <SettingsChoiceRow
                      key={choice.mode ?? "inherit"}
                      label={m(choice.label)}
                      description={m(choice.description)}
                      selected={
                        !isMixed("worktreeSubmodules") &&
                        uniform("worktreeSubmodules") === choice.mode
                      }
                      separated={index > 0}
                      disabled={disabledFor("worktreeSubmodules")}
                      onPress={() => write({ worktreeSubmodules: choice.mode })}
                    />
                  ))}
                </SettingsSection>
                <BranchNamingSettings
                  key={targetsKey}
                  mode={uniform("branchNamingMode")}
                  prefix={uniform("branchNamePrefix")}
                  instructions={uniform("branchNameInstructions")}
                  disabled={{
                    mode: disabledFor("branchNamingMode"),
                    prefix: disabledFor("branchNamePrefix"),
                    instructions: disabledFor("branchNameInstructions"),
                  }}
                  onChange={write}
                />
              </>
            ) : null}

            {props.page === "maintenance" ? (
              <>
                {!projectSelected ? (
                  <DatabaseStorageNotice
                    targets={selectedTargets.filter(
                      (target) =>
                        target.serverConfig.environment.capabilities.databaseStorage === true,
                    )}
                  />
                ) : null}
                {!projectSelected ? (
                  <SettingsSection title={gt("Manage environments")}>
                    {selectedTargets.map((target) => (
                      <SettingsRow
                        key={target.environmentId}
                        icon="server.rack"
                        label={target.label}
                        value={gt("Server and provider updates")}
                        onPress={() =>
                          navigation.navigate("SettingsEnvironmentDetail", {
                            environmentId: target.environmentId,
                          })
                        }
                      />
                    ))}
                  </SettingsSection>
                ) : null}
                <SettingsSection title={gt("Updates")}>
                  <SettingsSwitchRow
                    icon="arrow.clockwise"
                    label={gt("Check provider updates")}
                    subtitle={managedSubtitle(
                      "enableProviderUpdateChecks",
                      projectSelected
                        ? gt("Environment-wide setting. Select All projects to change it.")
                        : gt(
                            "Check installed provider CLIs for newer versions and fetch model catalog updates. When off, new models may not appear.",
                          ),
                    )}
                    value={uniform("enableProviderUpdateChecks")}
                    disabled={disabledFor("enableProviderUpdateChecks")}
                    onValueChange={(value) => write({ enableProviderUpdateChecks: value })}
                  />
                  <View className="border-t border-border-subtle">
                    <SettingsSwitchRow
                      icon="arrow.uturn.forward"
                      label={gt("Continue after restart")}
                      subtitle={managedSubtitle(
                        "continueThreadsAfterServerUpdate",
                        gt("Resume interrupted threads after an update or restart."),
                      )}
                      value={uniform("continueThreadsAfterServerUpdate")}
                      disabled={disabledFor("continueThreadsAfterServerUpdate")}
                      onValueChange={(value) => write({ continueThreadsAfterServerUpdate: value })}
                    />
                  </View>
                  <View className="border-t border-border-subtle">
                    <SettingsSwitchRow
                      icon="bolt.circle"
                      label={gt("Keep awake while agents work")}
                      subtitle={managedSubtitle(
                        "keepAwakeWhileAgentsWork",
                        projectSelected
                          ? gt("Environment-wide setting. Select All projects to change it.")
                          : gt(
                              "Stop the computer from sleeping while agents work. Closing a laptop lid still sleeps it.",
                            ),
                      )}
                      value={uniform("keepAwakeWhileAgentsWork")}
                      disabled={disabledFor("keepAwakeWhileAgentsWork")}
                      onValueChange={(value) => write({ keepAwakeWhileAgentsWork: value })}
                    />
                  </View>
                </SettingsSection>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function MixedValuesLabel(props: { readonly projectSelected: boolean }) {
  const gt = useGT();
  return (
    <Text
      accessibilityLabel={
        props.projectSelected
          ? gt("Selected project checkouts use different values")
          : gt("Selected environments use different values")
      }
      className="px-2 text-sm text-foreground-muted android:px-4"
    >
      <T>Mixed</T>
    </Text>
  );
}

/** Locked settings are refused when saved; say so before the user tries. */
function ManagedPolicyNotice(props: { readonly targets: readonly ScopedMobileSettingsTarget[] }) {
  const organizations = [
    ...new Set(
      props.targets.flatMap((target) => {
        const policy = target.environment.serverConfig.managedPolicy;
        return policy !== undefined && policy.lockedSettings.length > 0
          ? [policy.organization]
          : [];
      }),
    ),
  ];
  if (organizations.length === 0) return null;
  return (
    <Text className="px-2 text-sm text-foreground-muted android:px-4">
      <T>
        Some settings are managed by <Var>{organizations.join(", ")}</Var> and cannot be changed
        here.
      </T>
    </Text>
  );
}
