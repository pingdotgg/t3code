import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { AsyncResult } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";
import { useEffect, useState } from "react";
import { Alert, AppState, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  buildAndroidSubscriptionUsageSnapshot,
  collectSubscriptionWidgetQuotas,
  subscriptionWidgetAccountId,
} from "../../widgets/androidSubscriptionUsageSnapshot";
import {
  DEFAULT_WIDGET_CONFIGURATION,
  resolveWidgetPreferences,
  toggleWidgetSelection,
  type SubscriptionWidgetConfiguration,
} from "../../widgets/subscriptionWidgetPreferences";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { UsageWidgetPreview } from "./components/UsageWidgetPreview";

const PERIODS = [
  { id: "all", title: "All quotas" },
  { id: "session", title: "Session" },
  { id: "weekly", title: "Weekly" },
  { id: "monthly", title: "Monthly" },
  { id: "tightest", title: "Lowest remaining" },
] as const;

const RESET_DISPLAYS = [
  { id: "reset", title: "Next reset only" },
  { id: "both", title: "Reset + time left" },
  { id: "remaining", title: "Time left only" },
] as const;

function WidgetMenu<Value extends string>(props: {
  label: string;
  subtitle?: string;
  value: Value;
  options: readonly { id: Value; title: string }[];
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <SettingsControlRow
      icon="slider.horizontal.3"
      label={props.label}
      subtitle={props.subtitle}
      disabled={props.disabled}
    >
      <ControlPillMenu
        title={props.label}
        actions={props.options.map((option) => ({
          ...option,
          state: option.id === props.value ? "on" : "off",
        }))}
        onPressAction={({ nativeEvent }) => {
          if (props.disabled) return;
          const option = props.options.find((option) => option.id === nativeEvent.event);
          if (option) props.onChange(option.id);
        }}
      >
        <Pressable
          disabled={props.disabled}
          accessibilityRole="button"
          accessibilityLabel={props.subtitle ? `${props.subtitle} · ${props.label}` : props.label}
          className="rounded-full bg-subtle px-3 py-2"
        >
          <Text className="text-sm text-foreground">
            {props.options.find((option) => option.id === props.value)?.title}
          </Text>
        </Pressable>
      </ControlPillMenu>
    </SettingsControlRow>
  );
}

export function SettingsUsageWidgetRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<{ Widget: { widgetId?: string } | undefined }, "Widget">>();
  const focused = useIsFocused();
  const result = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const ready = AsyncResult.isSuccess(result) && !result.waiting;
  const preferences = resolveWidgetPreferences(
    AsyncResult.isSuccess(result) ? result.value.subscriptionWidgets : undefined,
  );
  const [widgetIds, setWidgetIds] = useState<number[]>([]);
  const [selection, setSelection] = useState(() => ({
    params: route.params,
    target: route.params?.widgetId ?? "defaults",
  }));
  if (selection.params !== route.params) {
    setSelection({ params: route.params, target: route.params?.widgetId ?? "defaults" });
  }
  const { target } = selection;
  const setTarget = (target: string) => setSelection({ params: route.params, target });
  const native = requireOptionalNativeModule<{
    getWidgetIds: () => number[];
    pinWidget: () => boolean;
  }>("T3WidgetExpiry");
  useEffect(() => {
    if (!focused) return;
    const update = () => setWidgetIds(native?.getWidgetIds() ?? []);
    update();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") update();
    });
    return () => listener.remove();
  }, [focused, native]);
  const isDefault = target === "defaults";
  const exists = isDefault || widgetIds.includes(Number(target));
  const configuration = preferences.widgets[target] ?? preferences.defaults;
  const disabled = !ready || !exists;
  const accounts = collectLimitAccounts(presentations).filter(
    (account) => account.driver === "codex" || account.driver === "claudeAgent",
  );
  const preview = buildAndroidSubscriptionUsageSnapshot(presentations, configuration);
  const quotas = collectSubscriptionWidgetQuotas(presentations, configuration);
  const availableAccounts = accounts.map(subscriptionWidgetAccountId);
  const availableEnvironments = [...presentations.keys()];
  const save = (patch: Partial<SubscriptionWidgetConfiguration> | null) => {
    void savePreferences({
      transform: (current) => {
        const latest = resolveWidgetPreferences(current.subscriptionWidgets);
        if (isDefault)
          return {
            subscriptionWidgets: {
              ...latest,
              defaults:
                patch === null ? DEFAULT_WIDGET_CONFIGURATION : { ...latest.defaults, ...patch },
            },
          };
        const widgets = { ...latest.widgets };
        if (patch === null) delete widgets[target];
        else widgets[target] = { ...(widgets[target] ?? latest.defaults), ...patch };
        return { subscriptionWidgets: { ...latest, widgets } };
      },
    }).catch(() => Alert.alert("Could not save widget settings", "Please try again."));
  };
  return (
    <SettingsScreen title="Usage widget">
      <UsageWidgetPreview
        snapshot={preview}
        target={
          isDefault
            ? "Default settings"
            : exists
              ? `Home screen widget ${widgetIds.indexOf(Number(target)) + 1}`
              : "Removed widget"
        }
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          Choose what appears on your home screen. Each widget can have its own settings. Changes
          apply immediately.
        </Text>
        <SettingsSection title="Widget">
          <WidgetMenu
            label="Configure"
            value={target}
            options={[
              { id: "defaults", title: "Default settings" },
              ...widgetIds.map((id, index) => ({
                id: String(id),
                title: `Home screen widget ${index + 1}`,
              })),
            ]}
            disabled={!ready}
            onChange={setTarget}
          />
          {!isDefault ? (
            <SettingsSwitchRow
              icon="arrow.clockwise"
              label="Use default settings"
              value={!preferences.widgets[target]}
              disabled={disabled}
              onValueChange={(enabled) => save(enabled ? null : configuration)}
            />
          ) : null}
          <SettingsActionRow
            icon="plus"
            label="Add to home screen"
            disabled={!native || !ready}
            onPress={() => {
              if (!native?.pinWidget())
                Alert.alert(
                  "Add the widget from your launcher",
                  "Open your home screen's widget gallery and choose Subscription usage.",
                );
            }}
          />
          <SettingsActionRow
            icon="chart.bar.xaxis"
            label="Open usage limits"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsUsage" },
              })
            }
          />
        </SettingsSection>
        {!exists ? (
          <Text className="text-sm text-danger-foreground">
            This widget was removed. Choose Default settings or another home screen widget.
          </Text>
        ) : null}
        <SettingsSection title="Providers">
          {(
            [
              { id: "codex", label: "Codex" },
              { id: "claudeAgent", label: "Claude" },
            ] as const
          ).map((provider) => (
            <SettingsSwitchRow
              key={provider.id}
              icon="person.crop.circle"
              label={provider.label}
              disabled={disabled}
              value={configuration.providers.includes(provider.id)}
              onValueChange={(enabled) =>
                save({
                  providers: enabled
                    ? [...configuration.providers, provider.id]
                    : configuration.providers.filter((id) => id !== provider.id),
                })
              }
            />
          ))}
        </SettingsSection>
        <SettingsSection title="Accounts">
          <SettingsSwitchRow
            icon="person.2"
            label="All accounts"
            subtitle="Include new accounts automatically."
            disabled={disabled}
            value={configuration.accountIds === null}
            onValueChange={(enabled) => save({ accountIds: enabled ? null : availableAccounts })}
          />
          {accounts.map((account, index) => (
            <SettingsSwitchRow
              key={account.key}
              icon="person.crop.circle"
              label={account.displayName ?? `Account ${index + 1}`}
              subtitle={`${account.driver === "codex" ? "Codex" : "Claude"} · ${account.environments.map((e) => e.label).join(", ") || account.sourceLabel || "Usage source"}`}
              disabled={disabled}
              value={
                configuration.accountIds === null ||
                configuration.accountIds.includes(subscriptionWidgetAccountId(account))
              }
              onValueChange={() =>
                save({
                  accountIds: toggleWidgetSelection(
                    configuration.accountIds,
                    availableAccounts,
                    subscriptionWidgetAccountId(account),
                  ),
                })
              }
            />
          ))}
          {accounts.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              Connect an environment and refresh Usage → Limits to choose accounts.
            </Text>
          ) : null}
          {configuration.accountIds?.some((id) => !availableAccounts.includes(id)) ? (
            <Text className="p-4 text-sm text-foreground-muted">
              Some selected accounts are unavailable. They will return when their environment
              reconnects and reports limits.
            </Text>
          ) : null}
        </SettingsSection>
        <SettingsSection title="Environments">
          <SettingsSwitchRow
            icon="server.rack"
            label="All environments"
            subtitle="Include new environments automatically."
            disabled={disabled}
            value={configuration.environmentIds === null}
            onValueChange={(enabled) =>
              save({ environmentIds: enabled ? null : availableEnvironments })
            }
          />
          {[...presentations].map(([id, presentation]) => (
            <SettingsSwitchRow
              key={id}
              icon="server.rack"
              label={presentation.entry.target.label}
              disabled={disabled}
              value={
                configuration.environmentIds === null || configuration.environmentIds.includes(id)
              }
              onValueChange={() =>
                save({
                  environmentIds: toggleWidgetSelection(
                    configuration.environmentIds,
                    availableEnvironments,
                    id,
                  ),
                })
              }
            />
          ))}
        </SettingsSection>
        <SettingsSection title="Quotas">
          <WidgetMenu
            label="Account view"
            value={configuration.grouping}
            options={[
              { id: "accounts", title: "Separate accounts" },
              { id: "pooled", title: "Combined by provider" },
            ]}
            disabled={disabled}
            onChange={(grouping) => save({ grouping })}
          />
          <WidgetMenu
            label="Codex quotas"
            value={configuration.codexPeriod}
            options={PERIODS}
            disabled={disabled}
            onChange={(codexPeriod) => save({ codexPeriod })}
          />
          <WidgetMenu
            label="Claude quotas"
            value={configuration.claudePeriod}
            options={PERIODS}
            disabled={disabled}
            onChange={(claudePeriod) => save({ claudePeriod })}
          />
          <WidgetMenu
            label="Quotas per account"
            value={String(configuration.windowsPerAccount)}
            options={[
              { id: "0", title: "All · scroll to see more" },
              { id: "1", title: "1" },
              { id: "2", title: "2" },
              { id: "3", title: "3" },
            ]}
            disabled={disabled}
            onChange={(value) =>
              save({
                windowsPerAccount: value === "1" ? 1 : value === "2" ? 2 : value === "3" ? 3 : 0,
              })
            }
          />
          <WidgetMenu
            label="Sort accounts"
            value={configuration.sort}
            options={[
              { id: "provider", title: "Provider" },
              { id: "name", title: "Name" },
              { id: "remaining", title: "Lowest remaining" },
              { id: "reset", title: "Next reset" },
            ]}
            disabled={disabled}
            onChange={(sort) => save({ sort })}
          />
        </SettingsSection>
        <SettingsSection title="Appearance">
          <WidgetMenu
            label="Density"
            value={configuration.density}
            options={[
              { id: "comfortable", title: "Comfortable" },
              { id: "compact", title: "Compact" },
            ]}
            disabled={disabled}
            onChange={(density) => save({ density })}
          />
          <WidgetMenu
            label="Percentage"
            value={configuration.percentage}
            options={[
              { id: "remaining", title: "Remaining" },
              { id: "used", title: "Used" },
            ]}
            disabled={disabled}
            onChange={(percentage) => save({ percentage })}
          />
          <WidgetMenu
            label="Theme"
            value={configuration.theme}
            options={[
              { id: "system", title: "System" },
              { id: "light", title: "Light" },
              { id: "dark", title: "Dark" },
            ]}
            disabled={disabled}
            onChange={(theme) => save({ theme })}
          />
          <SettingsSwitchRow
            icon="chart.bar.xaxis"
            label="Progress bars"
            disabled={disabled}
            value={configuration.showBars}
            onValueChange={(showBars) => save({ showBars })}
          />
          <WidgetMenu
            label="Environment names"
            subtitle="Auto hides names with one connected environment."
            disabled={disabled}
            value={
              configuration.showEnvironment === "auto"
                ? "auto"
                : configuration.showEnvironment
                  ? "show"
                  : "hide"
            }
            options={[
              { id: "auto", title: "Auto" },
              { id: "show", title: "Always show" },
              { id: "hide", title: "Always hide" },
            ]}
            onChange={(value) =>
              save({ showEnvironment: value === "auto" ? "auto" : value === "show" })
            }
          />
          <SettingsSwitchRow
            icon="clock"
            label="Last updated"
            disabled={disabled}
            value={configuration.showUpdatedAt}
            onValueChange={(showUpdatedAt) => save({ showUpdatedAt })}
          />
        </SettingsSection>
        <SettingsSection title="Reset display">
          <SettingsSwitchRow
            icon="clock"
            label="Show reset details"
            disabled={disabled}
            value={configuration.showResetTimes}
            onValueChange={(showResetTimes) => save({ showResetTimes })}
          />
          <WidgetMenu
            label="Default display"
            value={configuration.resetDisplay}
            options={RESET_DISPLAYS}
            disabled={disabled || !configuration.showResetTimes}
            onChange={(resetDisplay) => save({ resetDisplay })}
          />
          {quotas.map((quota) => (
            <WidgetMenu
              key={quota.id}
              label={quota.label}
              subtitle={quota.account}
              value={configuration.quotaResetDisplays[quota.id] ?? "default"}
              options={[{ id: "default", title: "Use default" }, ...RESET_DISPLAYS]}
              disabled={disabled || !configuration.showResetTimes}
              onChange={(value) => {
                const quotaResetDisplays = { ...configuration.quotaResetDisplays };
                if (value === "default") delete quotaResetDisplays[quota.id];
                else quotaResetDisplays[quota.id] = value;
                save({ quotaResetDisplays });
              }}
            />
          ))}
        </SettingsSection>
        <SettingsSection>
          <SettingsActionRow
            icon="arrow.clockwise"
            label={isDefault ? "Reset default settings" : "Reset to default settings"}
            disabled={disabled}
            onPress={() => save(null)}
          />
        </SettingsSection>
        <Text className="text-sm text-foreground-muted">
          Scroll the widget to see additional accounts and quotas. Open T3 to refresh readings;
          readings expire after 15 minutes or when a quota resets.
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
