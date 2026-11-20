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
import { formatTokens } from "@t3tools/shared/usageFormat";
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
import { ModelEvaluationSettings } from "./ModelEvaluationSettings";
import { SkillsLibrarySettings } from "./SkillsLibrarySettings";
import { AutoSettleSettingsRows } from "./ThreadSettingsSections";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { useHomeListOptions } from "../home/home-list-options";
import { useEnvironments } from "../../state/environments";

type SettingsPage = "threads" | "source-control" | "worktrees" | "maintenance" | "zack";

const PAGE_TITLES: Record<SettingsPage, string> = {
  threads: msg("Threads", { $context: "settings page title" }),
  "source-control": msg("Source control & issues"),
  worktrees: msg("Worktrees"),
  maintenance: msg("Maintenance"),
  zack: msg("Zack"),
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
  zack: [
    "enableAssistedLearning",
    "enableMemoryCuration",
    "enableConversationSummaries",
    "contextRestartAboveTokens",
  ],
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

const CONTEXT_RESTART_CHOICES: ReadonlyArray<number | null> = [
  null,
  150_000,
  200_000,
  300_000,
  500_000,
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

export function SettingsZackRouteScreen() {
  return <ServerSettingsDetail page="zack" />;
}

function ServerSettingsDetail(props: { readonly page: SettingsPage }) {
  const { environments } = useEnvironments();
  const { options, setHideOfflineEnvironments } = useHomeListOptions(
    new Set(environments.map((environment) => environment.environmentId)),
  );
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
  const unsupportedAssistedLearning = targets.filter(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectKnowledgeAssistedLearning !==
      true,
  );
  const assistedLearningUnavailableReason =
    unsupportedAssistedLearning.length === 0
      ? null
      : unsupportedAssistedLearning.length < targets.length
        ? `Automatic memory is supported on only some selected environments. Update T3 Code on ${unsupportedAssistedLearning.map((target) => target.environment.label).join(", ")}, or select a supported environment.`
        : `Automatic memory is not supported on ${unsupportedAssistedLearning.map((target) => target.environment.label).join(", ")}. Update T3 Code on ${unsupportedAssistedLearning.length === 1 ? "that environment" : "those environments"}.`;
  const [pendingWrites, setPendingWrites] = useState(0);
  const memoryCurationUnavailable = targets.some(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectKnowledgeCuration !== true,
  );
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
  const write = (patch: ServerSettingsPatch) => {
    if (patch.enableAssistedLearning !== undefined && assistedLearningUnavailableReason !== null)
      return;
    if (patch.enableMemoryCuration !== undefined && memoryCurationUnavailable) return;
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
        {props.page === "zack" ? (
          <SettingsSection title={gt("Threads")}>
            <SettingsSwitchRow
              icon="wifi.slash"
              label={gt("Hide offline environments")}
              subtitle={gt("Hide threads from offline environments on this device.")}
              value={options.hideOfflineEnvironments}
              onValueChange={setHideOfflineEnvironments}
            />
          </SettingsSection>
        ) : null}
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
                <AutoSettleSettingsRows write={write} pending={pendingWrites > 0} />
              </>
            ) : null}

            {props.page === "zack" ? (
              <>
                <SettingsSection title={gt("Group conversations")}>
                  <SettingsSwitchRow
                    icon="person.2"
                    label={gt("Group conversations")}
                    subtitle={managedSubtitle(
                      "groupConversationsEnabled",
                      gt("Invite models into one thread. Everyone can edit the shared workspace."),
                    )}
                    value={uniform("groupConversationsEnabled")}
                    disabled={disabledFor("groupConversationsEnabled")}
                    onValueChange={(value) => write({ groupConversationsEnabled: value })}
                  />
                </SettingsSection>
                <SettingsSection title={gt("Holographic memory")}>
                  <SettingsSwitchRow
                    icon="brain"
                    label={gt("Save facts from finished runs")}
                    subtitle={
                      assistedLearningUnavailableReason ??
                      gt(
                        "Completed runs are grouped into background learning batches. Your text generation model saves up to three cited facts per batch; eligible batches use at most one model call.",
                      )
                    }
                    value={uniform("enableAssistedLearning")}
                    disabled={
                      disabledFor("enableAssistedLearning") ||
                      assistedLearningUnavailableReason !== null
                    }
                    onValueChange={(value) => write({ enableAssistedLearning: value })}
                  />
                  <SettingsSwitchRow
                    icon="brain"
                    label={gt("Curate project memories")}
                    subtitle={
                      memoryCurationUnavailable
                        ? gt("Update the selected T3 Code servers to use memory curation.")
                        : gt(
                            "Review agent memories within each project. Set aside task notes and link duplicates or replaced decisions, keeping the content and review reasons available to inspect or restore. Uses your text generation model.",
                          )
                    }
                    value={uniform("enableMemoryCuration")}
                    disabled={disabledFor("enableMemoryCuration") || memoryCurationUnavailable}
                    onValueChange={(value) => write({ enableMemoryCuration: value })}
                  />
                </SettingsSection>
                <SettingsSection title={gt("LCM: conversation summaries")}>
                  <SettingsSwitchRow
                    icon="doc.text"
                    label={gt("Summarize older messages")}
                    subtitle={gt(
                      "After turns complete, your text generation model summarizes older messages so provider switches and forks keep their gist. Each summary costs one model call.",
                    )}
                    value={uniform("enableConversationSummaries")}
                    disabled={disabledFor("enableConversationSummaries")}
                    onValueChange={(value) => write({ enableConversationSummaries: value })}
                  />
                </SettingsSection>
                <SettingsSection
                  title={gt("LCM: restart large threads")}
                  footer={gt(
                    "When a Codex thread's context reaches the limit, continue in a fresh conversation built from summaries and the newest messages. Needs summaries.",
                  )}
                  trailing={
                    pendingWrites === 0 && isMixed("contextRestartAboveTokens") ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {[
                    ...CONTEXT_RESTART_CHOICES,
                    ...(reference === null ||
                    CONTEXT_RESTART_CHOICES.includes(reference.settings.contextRestartAboveTokens)
                      ? []
                      : [reference.settings.contextRestartAboveTokens]),
                  ].map((tokens, index) => (
                    <SettingsChoiceRow
                      key={tokens ?? "off"}
                      label={
                        tokens === null
                          ? gt("Off")
                          : gt("Above {count} tokens", { count: formatTokens(tokens) })
                      }
                      selected={
                        !isMixed("contextRestartAboveTokens") &&
                        reference?.settings.contextRestartAboveTokens === tokens
                      }
                      separated={index > 0}
                      disabled={disabledFor("contextRestartAboveTokens")}
                      onPress={() => write({ contextRestartAboveTokens: tokens })}
                    />
                  ))}
                </SettingsSection>
                {!projectSelected &&
                selectedTargets.some(
                  (target) => target.serverConfig.environment.capabilities.externalHistory === 1,
                ) ? (
                  <SettingsSection title={gt("LCM: external history")}>
                    {selectedTargets
                      .filter(
                        (target) =>
                          target.serverConfig.environment.capabilities.externalHistory === 1,
                      )
                      .map((target) => (
                        <SettingsRow
                          key={target.environmentId}
                          icon="magnifyingglass"
                          label={target.label}
                          value="Find and search local agent conversations"
                          onPress={() =>
                            navigation.navigate("SettingsExternalHistory", {
                              environmentId: target.environmentId,
                            })
                          }
                        />
                      ))}
                  </SettingsSection>
                ) : null}
                <SettingsSection title={gt("Skills")}>
                  <SettingsSwitchRow
                    icon="square.grid.2x2"
                    label="pstack"
                    subtitle={
                      projectSelected
                        ? gt("Environment-wide setting. Select All projects to change it.")
                        : gt(
                            "Offer Lauren Tan's pstack workflows as skills in every provider. Run $pstack:setup-pstack once to choose models.",
                          )
                    }
                    value={uniform("pstackEnabled")}
                    disabled={disabledFor("pstackEnabled")}
                    onValueChange={(value) => write({ pstackEnabled: value })}
                  />
                </SettingsSection>
                {selectedTargets
                  .filter(
                    (target) => target.serverConfig.environment.capabilities.skillsLibrary === true,
                  )
                  .map((target) => (
                    <SettingsSection key={target.environmentId} title={target.label}>
                      <SkillsLibrarySettings environment={target} />
                    </SettingsSection>
                  ))}
                <ModelEvaluationSettings />
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
