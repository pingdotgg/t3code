import { T, useGT, msg, useMessages } from "gt-react-native";
import { Button } from "../../components/ui/Button";
import {
  type AgentFeedbackMode,
  AuthSettingsWriteScope,
  isManagedSettingPath,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  managedSettingReason,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

export function SettingsLabsRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title={gt("Labs")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <MachineBetaSection
          title={gt("Linked environments")}
          icon="link"
          capability="peerLinks"
          setting="linkedEnvironmentsEnabled"
          description={gt(
            "Let agents on a machine work on your other machines, and theirs on it. Turn it on for each machine. While off, nothing new starts over a link; running tasks finish.",
          )}
        />
        <MachineBetaSection
          title={gt("Fast worktree checkout")}
          icon="bolt.circle"
          capability="fastWorktreeCheckout"
          setting="fastWorktreeCheckout"
          description={gt(
            "On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache.",
          )}
        />
        <AgentFeedbackSection />
      </ScrollView>
    </SettingsScreen>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 7;

/**
 * Usage-limit and auto-settle rows. The Threads page owns their writes, so they share its queue
 * with the page's other project overrides, and their project override reset.
 */
export function AutoSettleSettingsRows(props: {
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly pending: boolean;
}) {
  const gt = useGT();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;

  const projectMembers = projectSelected
    ? (selectedProject?.members.map((member) => member.project) ?? [])
    : null;
  const displayTargets = resolveMobileSettingsTargets(
    selectedTargets.filter(supportsSharedSettingsSync),
    projectMembers,
  );
  // The page saves to all its targets, so any read-only one blocks the save.
  const canWriteSettings =
    displayTargets.length > 0 &&
    resolveMobileSettingsTargets(selectedTargets, projectMembers).every((target) =>
      writableEnvironments.has(target.environment.environmentId),
    );
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (
    patch: Partial<AutoSettleSettings> & {
      autoResumeLimitedThreads?: boolean;
      snoozeLimitedThreads?: boolean;
    },
  ) => props.write(patch);

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    {
      environmentId: reference.environment.environmentId,
      projectId: reference.projectId,
      settings: referenceSettings,
    },
    displayTargets.map((target) => ({
      environmentId: target.environment.environmentId,
      projectId: target.projectId,
      label: target.environment.label,
      settings: target.settings,
    })),
  );

  const disabled = !canWriteSettings || props.pending;
  const disabledFor = (...keys: string[]) =>
    disabled || managedSettingReason(displayTargets, keys) !== undefined;
  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;

  return (
    <View className="gap-6">
      {!projectSelected ? (
        <SettingsSection title={gt("Usage limits")}>
          <SettingsSwitchRow
            icon="clock"
            label={gt("Resume after usage limits")}
            subtitle={gt(
              "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.",
            )}
            value={uniformMobileSetting(displayTargets, "autoResumeLimitedThreads")}
            disabled={disabledFor("autoResumeLimitedThreads")}
            onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label={gt("Snooze until limits reset")}
            subtitle={gt(
              "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.",
            )}
            value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
            disabled={disabledFor("snoozeLimitedThreads")}
            onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title={gt("Auto-settle")}>
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label={gt("Auto-settle merged threads")}
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabledFor("sidebarAutoSettleOnMerge")}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label={gt("Auto-settle inactive threads")}
          value={afterDays !== null}
          disabled={disabledFor("sidebarAutoSettleAfterDays")}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
            <View className="w-[22px] android:w-6" />
            <Text className="flex-1 text-foreground text-lg android:text-base">
              <T>Inactive days</T>
            </Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabledFor("sidebarAutoSettleAfterDays")}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {!props.pending && mismatches.length > 0 ? (
        <SettingsSection title={gt("Across environments")}>
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">
              <T>Auto-settle defaults differ</T>
            </Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Button
              label={gt("Apply auto-settle defaults")}
              tone="secondary"
              disabled={disabledFor("sidebarAutoSettleOnMerge", "sidebarAutoSettleAfterDays")}
              onPress={() => writeToAll(autoSettlePatch)}
            />
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

export function WorkingSectionSettings() {
  const gt = useGT();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const workingShelfEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.workingShelfEnabled !== false;

  return (
    <View className="gap-3">
      <SettingsSection title={gt("Sidebar")}>
        <SettingsSwitchRow
          icon="bolt.circle"
          label={gt("Working section")}
          value={workingShelfEnabled}
          onValueChange={(value) => {
            void savePreferences({ workingShelfEnabled: value });
          }}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        <T>
          Fold working and monitoring threads into a Working section. They return to the top of the
          list when they need you. While this is on, active threads are ordered by time and cannot
          be moved.
        </T>
      </Text>
    </View>
  );
}

export function NewThreadSettingsSection() {
  const gt = useGT();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const useLastProject =
    AsyncResult.isSuccess(preferences) && preferences.value.useLastProjectForNewThreads !== false;

  return (
    <SettingsSection title={gt("New threads")}>
      <SettingsSwitchRow
        icon="square.and.pencil"
        label={gt("Use last project")}
        subtitle={gt("Start new threads in the last project you used on this device.")}
        value={useLastProject}
        onValueChange={(value) => {
          void savePreferences({ useLastProjectForNewThreads: value });
        }}
      />
    </SettingsSection>
  );
}

type MachineBetaSetting = "linkedEnvironmentsEnabled" | "fastWorktreeCheckout";

const AGENT_FEEDBACK_CHOICES: ReadonlyArray<{
  readonly mode: AgentFeedbackMode;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "off", label: msg("Off"), description: msg("Agents send no feedback to the T3 team.") },
  {
    mode: "on-request",
    label: msg("When I ask"),
    description: msg("When you ask, you see a short report and send it if you approve."),
  },
  {
    mode: "auto",
    label: msg("Automatic"),
    description: msg("Agents also report T3 Code problems they hit on their own."),
  },
];

/** One choice list per connected machine that offers it, since each machine's own setting decides. */
function AgentFeedbackSection() {
  const gt = useGT();
  const m = useMessages();
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.agentFeedback === true,
  );
  const writable = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "agentFeedback beta update",
    reportFailure: true,
  });
  if (supported.length === 0) return null;
  return (
    <View className="gap-3">
      {supported.map((environment) => {
        const policy = environment.serverConfig?.managedPolicy;
        const managed = isManagedSettingPath(policy, "agentFeedback");
        const mode = environment.serverConfig?.settings.agentFeedback.mode;
        return (
          <SettingsSection
            key={environment.environmentId}
            title={
              supported.length === 1
                ? gt("Beta: Agent feedback")
                : gt("Beta: Agent feedback · {label}", { label: environment.label })
            }
            {...(managed
              ? { footer: gt("Managed by {organization}.", { organization: policy?.organization }) }
              : {})}
          >
            {AGENT_FEEDBACK_CHOICES.map((choice, index) => (
              <SettingsChoiceRow
                key={choice.mode}
                label={m(choice.label)}
                description={m(choice.description)}
                selected={mode === choice.mode}
                separated={index > 0}
                disabled={managed || !writable.has(environment.environmentId)}
                onPress={() =>
                  void updateSettings({
                    environmentId: environment.environmentId,
                    input: { patch: { agentFeedback: { mode: choice.mode } } },
                  })
                }
              />
            ))}
          </SettingsSection>
        );
      })}
      <Text className="px-2 text-sm text-foreground-muted">
        <T>
          Reports go to the T3 team. A report you ask for is shown to you first in a card, with an
          outline of recent turns. Turn on Include the conversation there to add the messages of the
          turns the report is about.
        </T>
      </Text>
    </View>
  );
}

/** One switch per connected machine that offers the beta, since each machine's own setting decides. */
function MachineBetaSection({
  title,
  icon,
  capability,
  setting,
  description,
}: {
  readonly title: string;
  readonly icon: ComponentProps<typeof SettingsSwitchRow>["icon"];
  readonly capability: "peerLinks" | "fastWorktreeCheckout";
  readonly setting: MachineBetaSetting;
  readonly description: string;
}) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities[capability] === true,
  );
  const writable = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `${setting} beta update`,
    reportFailure: true,
  });
  if (supported.length === 0) return null;
  return (
    <View className="gap-3">
      <SettingsSection title={gt("Beta: {feature}", { feature: title })}>
        {supported.map((environment) => {
          const policy = environment.serverConfig?.managedPolicy;
          const managed = isManagedSettingPath(policy, setting);
          return (
            <SettingsSwitchRow
              key={environment.environmentId}
              icon={icon}
              label={environment.label}
              {...(managed
                ? {
                    subtitle: gt("Managed by {organization}.", {
                      organization: policy?.organization,
                    }),
                  }
                : {})}
              value={environment.serverConfig?.settings[setting] === true}
              disabled={managed || !writable.has(environment.environmentId)}
              onValueChange={(value) =>
                void updateSettings({
                  environmentId: environment.environmentId,
                  input: {
                    patch:
                      setting === "linkedEnvironmentsEnabled"
                        ? { linkedEnvironmentsEnabled: value }
                        : { fastWorktreeCheckout: value },
                  },
                })
              }
            />
          );
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">{description}</Text>
    </View>
  );
}
