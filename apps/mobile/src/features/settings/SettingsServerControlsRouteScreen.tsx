import { translate } from "@t3tools/i18n";
import { useNavigation } from "@react-navigation/native";
import { SettingsRow } from "./components/SettingsRow";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import {
  type ResponseStreamingMode,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadEnvMode,
  type WorktreeSubmodules,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
} from "@t3tools/contracts";
import { useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "@t3tools/i18n/react";
import { Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

type SettingsPage = "new-threads" | "source-control" | "agent-behavior" | "maintenance";

const PAGE_TITLES: Record<SettingsPage, string> = {
  "new-threads": "New threads",
  "source-control": "Source control",
  "agent-behavior": "Agent behavior",
  maintenance: "Maintenance",
};

const PAGE_TITLE_KEYS: Record<SettingsPage, string> = {
  "new-threads": "pageNewThreads",
  "source-control": "pageSourceControl",
  "agent-behavior": "pageAgentBehavior",
  maintenance: "pageMaintenance",
};

const SERVER_SETTING_COPY_KEYS: Record<string, string> = {
  "Unavailable project": "unavailableProject",
  "Select a project with a checkout on a connected environment.": "noConnectedProjectCheckout",
  "Use the filter above to select a connected environment.": "selectConnectedEnvironment",
  Inherit: "inherit",
  "Use the repository's t3.json, or initialize recursively.": "submoduleConfig",
  Recursive: "submoduleRecursive",
  "Initialize nested submodules too.": "initializeNestedSubmodules",
  "Top level only": "submoduleTopLevel",
  "Skip submodules declared inside other submodules.": "skipNestedSubmodules",
  Skip: "submoduleSkip",
  "Leave submodules empty for a setup script.": "leaveSubmodulesEmpty",
  "Use the repository's t3.json, or the current checkout.": "workspaceConfig",
  "Current checkout": "currentCheckout",
  "Start new threads in the existing workspace.": "startInExistingWorkspace",
  "New worktree": "newWorktree",
  "Give each new thread a separate checkout.": "separateCheckout",
  "After the turn": "afterTurn",
  "Show the answer when the agent finishes.": "showAnswerWhenFinished",
  "Finished paragraphs": "finishedParagraphs",
  "Show each paragraph or code block as it completes.": "showFinishedBlocks",
  "Token by token (legacy)": "tokenByTokenLegacy",
  "Repaint for every token; this can be slower.": "repaintEveryToken",
  "Environment-wide setting. Select All projects to change it.": "selectAllProjectsForSetting",
  "Check installed provider CLIs for newer versions.": "checkNewProviderVersions",
  "Resume interrupted threads after an update or restart.": "resumeThreadsAfterRestart",
  "Update older servers to control restart continuation.": "updateOlderServers",
  "Server and provider updates": "serverProviderUpdates",
  "Use legacy token streaming?": "useLegacyTokenStreaming",
  "Repainting every token can make the app slower.": "tokenStreamingPerformance",
  "Use token streaming": "useTokenStreaming",
  Supervised: "runtimeSupervised",
  "Ask before commands and file changes.": "runtimeSupervisedDescription",
  "Auto-accept edits": "runtimeAutoAcceptEdits",
  "Auto-approve edits, ask before other actions.": "runtimeAutoAcceptEditsDescription",
  Auto: "runtimeAuto",
  "Supported providers approve routine actions; others still ask.": "runtimeAutoDescription",
  "Full access": "runtimeFullAccess",
  "Allow commands and edits without prompts.": "runtimeFullAccessDescription",
};

function serverSettingCopy(value: string) {
  const key = SERVER_SETTING_COPY_KEYS[value];
  return key ? translate(`common:mobileServerSettings.${key}`, value) : value;
}

const PAGE_PROJECT_KEYS: Record<SettingsPage, readonly ProjectScopedServerSettingKey[]> = {
  "new-threads": ["defaultThreadEnvMode", "worktreeSubmodules", "defaultRuntimeMode"],
  "source-control": ["defaultAutoPull", "newWorktreesStartFromOrigin"],
  "agent-behavior": ["responseStreamingMode", "enableAgentBrowserAccess"],
  maintenance: ["continueThreadsAfterServerUpdate"],
};

const SUBMODULE_CHOICES: ReadonlyArray<{
  readonly mode: WorktreeSubmodules | null;
  readonly label: string;
  readonly description: string;
}> = [
  // Only offered at environment scope; a project falls back through "Use defaults".
  {
    mode: null,
    label: "Inherit",
    description: "Use the repository's t3.json, or initialize recursively.",
  },
  { mode: "recursive", label: "Recursive", description: "Initialize nested submodules too." },
  {
    mode: "top-level",
    label: "Top level only",
    description: "Skip submodules declared inside other submodules.",
  },
  { mode: "none", label: "Skip", description: "Leave submodules empty for a setup script." },
];

const WORKSPACE_CHOICES: ReadonlyArray<{
  readonly mode: ThreadEnvMode | null;
  readonly label: string;
  readonly description: string;
}> = [
  // Only offered at environment scope; a project falls back through "Use defaults".
  {
    mode: null,
    label: "Inherit",
    description: "Use the repository's t3.json, or the current checkout.",
  },
  {
    mode: "local",
    label: "Current checkout",
    description: "Start new threads in the existing workspace.",
  },
  {
    mode: "worktree",
    label: "New worktree",
    description: "Give each new thread a separate checkout.",
  },
];

const STREAMING_CHOICES: ReadonlyArray<{
  readonly mode: ResponseStreamingMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "turn",
    label: "After the turn",
    description: "Show the answer when the agent finishes.",
  },
  {
    mode: "paragraph",
    label: "Finished paragraphs",
    description: "Show each paragraph or code block as it completes.",
  },
  {
    mode: "token",
    label: "Token by token (legacy)",
    description: "Repaint for every token; this can be slower.",
  },
];

export function SettingsEnvironmentNewThreadsRouteScreen() {
  return <ServerSettingsDetail page="new-threads" />;
}

export function SettingsEnvironmentSourceControlRouteScreen() {
  return <ServerSettingsDetail page="source-control" />;
}

export function SettingsEnvironmentAgentBehaviorRouteScreen() {
  return <ServerSettingsDetail page="agent-behavior" />;
}

export function SettingsEnvironmentMaintenanceRouteScreen() {
  return <ServerSettingsDetail page="maintenance" />;
}

function ServerSettingsDetail(props: { readonly page: SettingsPage }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const displayTargets = pendingWrites > 0 && pendingTargets !== null ? pendingTargets : targets;
  const hasConnectedSelection = targets.length > 0;
  const reference = displayTargets[0] ?? null;
  const uniform = <K extends keyof ServerSettings>(key: K): ServerSettings[K] | null => {
    if (reference === null) return null;
    const value = reference.settings[key];
    return displayTargets.every((entry) => entry.settings[key] === value) ? value : null;
  };
  // `uniform` folds a real null into "mixed"; nullable keys need the distinction.
  const isMixed = (key: keyof ServerSettings) =>
    reference === null ||
    displayTargets.some((entry) => entry.settings[key] !== reference.settings[key]);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });
  const write = (patch: ServerSettingsPatch) => {
    if (writeInFlight.current || !hasConnectedSelection) return;
    const writes = planMobileScopedSettingsPatch(targets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const clearProjectOverrides = () => {
    if (writeInFlight.current) return;
    const writes = planMobileScopedSettingsClear(targets, PAGE_PROJECT_KEYS[props.page]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const supportsProjectOverrides = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled =
    pendingWrites > 0 || !hasConnectedSelection || (projectSelected && !supportsProjectOverrides);
  const supportsContinuation = targets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.threadRestartContinuation === true,
  );
  const disabledFor = (key: string) =>
    disabled ||
    (projectSelected &&
      !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(
        key as (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number],
      ));

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen
        title={translate(
          `common:mobileServerSettings.${PAGE_TITLE_KEYS[props.page]}`,
          PAGE_TITLES[props.page],
        )}
        trailing={<AndroidSettingsEnvironmentFilter />}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {!hasConnectedSelection || reference === null ? (
            <Text className="px-2 text-base text-foreground-muted">
              {serverSettingCopy(
                projectSelected
                  ? "Select a project with a checkout on a connected environment."
                  : "Use the filter above to select a connected environment.",
              )}
            </Text>
          ) : (
            <>
              {projectSelected ? (
                <SettingsProjectOverridesSection
                  projectLabel={selectedProject?.label ?? serverSettingCopy("Unavailable project")}
                  hasOverrides={targets.some((target) =>
                    PAGE_PROJECT_KEYS[props.page].some((key) => target.sources[key] === "project"),
                  )}
                  supportsOverrides={supportsProjectOverrides}
                  pending={pendingWrites > 0}
                  onClear={clearProjectOverrides}
                />
              ) : null}
              {props.page === "new-threads" ? (
                <>
                  <SettingsSection
                    title={translate("projectDefaults:defaultWorkspaceAria", "Default workspace")}
                    trailing={
                      pendingWrites === 0 && isMixed("defaultThreadEnvMode") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {WORKSPACE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <ChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={serverSettingCopy(choice.label)}
                        description={serverSettingCopy(choice.description)}
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
                    title={translate("projectDefaults:worktreeSubmodules", "Worktree submodules")}
                    trailing={
                      pendingWrites === 0 && isMixed("worktreeSubmodules") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {SUBMODULE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <ChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={serverSettingCopy(choice.label)}
                        description={serverSettingCopy(choice.description)}
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
                  <SettingsSection
                    title={translate("projectDefaults:permissions", "Default permissions")}
                    trailing={
                      pendingWrites === 0 && uniform("defaultRuntimeMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {RUNTIME_MODE_CHOICES.map((choice, index) => (
                      <ChoiceRow
                        key={choice.mode}
                        label={serverSettingCopy(choice.label)}
                        description={serverSettingCopy(choice.description)}
                        selected={uniform("defaultRuntimeMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("defaultRuntimeMode")}
                        onPress={() => write({ defaultRuntimeMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "source-control" ? (
                <>
                  <SettingsSection title={translate("gitActions:defaultBranch", "Default branch")}>
                    <FanoutSwitchRow
                      icon="arrow.down.circle"
                      label={translate("projectDefaults:automaticallyPull", "Automatically pull")}
                      subtitle={translate(
                        "common:mobileKeepDefaultBranchCurrent",
                        "Keep the default branch current when there are no local changes.",
                      )}
                      value={uniform("defaultAutoPull")}
                      disabled={disabledFor("defaultAutoPull")}
                      onValueChange={(value) => write({ defaultAutoPull: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title={translate("storage:worktrees", "Worktrees")}>
                    <FanoutSwitchRow
                      icon="arrow.triangle.branch"
                      label={translate("branchToolbar:startFromOrigin", "Start from origin")}
                      subtitle={translate(
                        "common:mobileBaseWorktreesOnRemoteBranch",
                        "Base new worktrees on the remote branch.",
                      )}
                      value={uniform("newWorktreesStartFromOrigin")}
                      disabled={disabledFor("newWorktreesStartFromOrigin")}
                      onValueChange={(value) => write({ newWorktreesStartFromOrigin: value })}
                    />
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "agent-behavior" ? (
                <>
                  <SettingsSection
                    title={translate("common:mobileResponseStreaming", "Response streaming")}
                    trailing={
                      pendingWrites === 0 && uniform("responseStreamingMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {STREAMING_CHOICES.map((choice, index) => (
                      <ChoiceRow
                        key={choice.mode}
                        label={serverSettingCopy(choice.label)}
                        description={serverSettingCopy(choice.description)}
                        selected={uniform("responseStreamingMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("responseStreamingMode")}
                        onPress={() => {
                          if (choice.mode !== "token") {
                            write({ responseStreamingMode: choice.mode });
                            return;
                          }
                          Alert.alert(
                            serverSettingCopy("Use legacy token streaming?"),
                            serverSettingCopy("Repainting every token can make the app slower."),
                            [
                              { text: translate("common:cancel", "Cancel"), style: "cancel" },
                              {
                                text: serverSettingCopy("Use token streaming"),
                                onPress: () => write({ responseStreamingMode: "token" }),
                              },
                            ],
                          );
                        }}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title={translate("common:mobilePreviewBrowser", "Preview browser")}
                  >
                    <FanoutSwitchRow
                      icon="globe"
                      label={translate(
                        "projectDefaults:agentBrowserAccess",
                        "Agent browser access",
                      )}
                      subtitle={translate(
                        "common:mobileAllowInAppPreviewBrowser",
                        "Allow agents to use the in-app preview browser.",
                      )}
                      value={uniform("enableAgentBrowserAccess")}
                      disabled={disabledFor("enableAgentBrowserAccess")}
                      onValueChange={(value) => write({ enableAgentBrowserAccess: value })}
                    />
                  </SettingsSection>
                </>
              ) : null}

              {props.page === "maintenance" ? (
                <>
                  {!projectSelected ? (
                    <SettingsSection
                      title={translate("common:mobileManageEnvironments", "Manage environments")}
                    >
                      {selectedTargets.map((target) => (
                        <SettingsRow
                          key={target.environmentId}
                          icon="server.rack"
                          label={target.label}
                          value={serverSettingCopy("Server and provider updates")}
                          onPress={() =>
                            navigation.navigate("SettingsSheet", {
                              screen: "SettingsContent",
                              params: {
                                screen: "SettingsEnvironmentDetail",
                                params: { environmentId: target.environmentId },
                              },
                            })
                          }
                        />
                      ))}
                    </SettingsSection>
                  ) : null}
                  <SettingsSection title={translate("common:mobileUpdates", "Updates")}>
                    <FanoutSwitchRow
                      icon="arrow.clockwise"
                      label={translate(
                        "common:mobileCheckProviderUpdates",
                        "Check provider updates",
                      )}
                      subtitle={
                        projectSelected
                          ? serverSettingCopy(
                              "Environment-wide setting. Select All projects to change it.",
                            )
                          : serverSettingCopy("Check installed provider CLIs for newer versions.")
                      }
                      value={uniform("enableProviderUpdateChecks")}
                      disabled={disabledFor("enableProviderUpdateChecks")}
                      onValueChange={(value) => write({ enableProviderUpdateChecks: value })}
                    />
                    <View className="border-t border-border-subtle">
                      <FanoutSwitchRow
                        icon="arrow.uturn.forward"
                        label={translate(
                          "common:mobileContinueAfterRestart",
                          "Continue after restart",
                        )}
                        subtitle={
                          supportsContinuation
                            ? serverSettingCopy(
                                "Resume interrupted threads after an update or restart.",
                              )
                            : serverSettingCopy(
                                "Update older servers to control restart continuation.",
                              )
                        }
                        value={uniform("continueThreadsAfterServerUpdate")}
                        disabled={
                          disabledFor("continueThreadsAfterServerUpdate") || !supportsContinuation
                        }
                        onValueChange={(value) =>
                          write({ continueThreadsAfterServerUpdate: value })
                        }
                      />
                    </View>
                  </SettingsSection>
                </>
              ) : null}
            </>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function ChoiceRow(props: {
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.separated
          ? "flex-row items-center gap-4 border-t border-border-subtle p-4 active:opacity-70"
          : "flex-row items-center gap-4 p-4 active:opacity-70"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text
          className={
            Platform.OS === "android" ? "text-base text-foreground" : "text-lg text-foreground"
          }
        >
          {props.label}
        </Text>
        <Text className="text-sm leading-normal text-foreground-muted">{props.description}</Text>
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function MixedValuesLabel(props: { readonly projectSelected: boolean }) {
  const { t } = useTranslation();
  return (
    <Text
      accessibilityLabel={
        props.projectSelected ? t("mixedProjectCheckoutValues") : t("mixedEnvironmentValues")
      }
      className="px-2 text-sm text-foreground-muted android:px-4"
    >
      {t("mixed")}
    </Text>
  );
}

function FanoutSwitchRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly subtitle: string;
  readonly value: boolean | null;
  readonly disabled: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  if (props.value !== null) {
    return (
      <SettingsSwitchRow
        icon={props.icon}
        label={props.label}
        subtitle={props.subtitle}
        value={props.value}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
      />
    );
  }

  return (
    <SettingsControlRow
      disabled={props.disabled}
      icon={props.icon}
      label={props.label}
      subtitle={props.subtitle}
    >
      <Pressable
        accessibilityLabel={t("setFeatureOnForSelectedEnvironments", {
          feature: props.label,
        })}
        accessibilityRole="button"
        disabled={props.disabled}
        className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
        onPress={() => props.onValueChange(true)}
      >
        <Text className="text-sm font-t3-medium text-foreground">{t("mixedSetOn")}</Text>
      </Pressable>
    </SettingsControlRow>
  );
}
