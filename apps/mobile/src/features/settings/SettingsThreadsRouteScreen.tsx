import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

export function SettingsThreadsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Thread behavior" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <AutoSettleSettingsRows />
          <LegacySettingsSection />
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

/**
 * Mobile edits auto-settle defaults across selected capable targets.
 */
function AutoSettleSettingsRows() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const projectSelected = selectedProjectKey !== null;
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncEnvironments = selectedTargets.filter(supportsSharedSettingsSync);
  const syncTargets = resolveMobileSettingsTargets(
    syncEnvironments,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const displayTargets =
    pendingWrites > 0 && pendingTargets !== null ? pendingTargets : syncTargets;
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (
    patch: Partial<AutoSettleSettings> & { autoResumeLimitedThreads?: boolean },
  ) => {
    if (writeInFlight.current) return;
    const writes = planMobileScopedSettingsPatch(syncTargets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
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

  const supportsProjectOverrides = syncTargets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled = pendingWrites > 0 || (projectSelected && !supportsProjectOverrides);
  const hasProjectOverrides =
    projectSelected &&
    syncTargets.some(
      (target) =>
        target.sources.sidebarAutoSettleOnMerge === "project" ||
        target.sources.sidebarAutoSettleAfterDays === "project",
    );
  const clearProjectOverrides = () => {
    if (writeInFlight.current) return;
    const writes = planMobileScopedSettingsClear(syncTargets, [
      "sidebarAutoSettleOnMerge",
      "sidebarAutoSettleAfterDays",
    ]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
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

  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;

  return (
    <View className="gap-6">
      {projectSelected ? (
        <SettingsProjectOverridesSection
          projectLabel={selectedProject?.label ?? "Unavailable project"}
          hasOverrides={hasProjectOverrides}
          supportsOverrides={supportsProjectOverrides}
          pending={pendingWrites > 0}
          onClear={clearProjectOverrides}
        />
      ) : null}
      {!projectSelected ? (
        <SettingsSection title="Usage limits">
          <SettingsSwitchRow
            icon="clock"
            label="Auto-resume limited threads"
            value={referenceSettings.autoResumeLimitedThreads}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title="Auto-settle">
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Auto-settle merged threads"
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabled}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label="Auto-settle inactive threads"
          value={afterDays !== null}
          disabled={disabled}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View
            className={cn(
              "flex-row items-center gap-4 px-4",
              Platform.OS === "android" ? "min-h-14 py-3" : "py-4",
            )}
          >
            <View style={{ width: Platform.OS === "android" ? 24 : 22 }} />
            <Text
              className={cn(
                "flex-1 text-foreground",
                Platform.OS === "android" ? "text-base" : "text-lg",
              )}
            >
              Inactive days
            </Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabled}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {pendingWrites === 0 && mismatches.length > 0 ? (
        <SettingsSection title="Across environments">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => writeToAll(autoSettlePatch)}
              className="self-start rounded-full bg-subtle px-4 py-2 active:opacity-70"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                Apply auto-settle defaults
              </Text>
            </Pressable>
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

/**
 * Device-local legacy toggles. Mobile has no client-settings sync, so this is
 * the counterpart of web's Settings → General → Legacy features backed by
 * mobile preferences.
 */
function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const threadListV2Enabled = useThreadListV2Enabled();
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="sidebar.left"
          label="Legacy Thread List"
          value={!threadListV2Enabled}
          onValueChange={(value) => savePreferences({ legacyThreadListEnabled: value })}
        />
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}
