import type {
  EnvironmentId,
  ServerSettingsPatch,
  VibeProxySettings,
  VibeProxyUsageAccount,
} from "@t3tools/contracts";
import {
  describeMissingConfiguration,
  formatQuotaPercent,
  formatQuotaReset,
  formatSnapshotAge,
  formatSuccessRate,
  groupVibeProxyAccounts,
  resolveVibeProxyUsageStage,
  vibeProxyAccountName,
  vibeProxyAccountStatus,
  vibeProxyAccountSubtitle,
  vibeProxyProviderInitials,
  vibeProxyProviderKind,
  vibeProxyQuotaSummary,
  vibeProxyRecentActivity,
  vibeProxyRequestHealth,
  type VibeProxyAccountTone,
  type VibeProxyQuotaState,
  type VibeProxyQuotaWindowView,
} from "@t3tools/shared/vibeProxyUsage";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Switch, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useThemeColor } from "../../lib/useThemeColor";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { VibeProxyUsageView } from "../../state/vibeProxyUsage";
import { SettingsSection } from "../settings/components/SettingsSection";

const TONE_TEXT_CLASS: Readonly<Record<VibeProxyAccountTone, string>> = {
  ok: "text-success",
  warning: "text-warning",
  error: "text-danger-foreground",
  muted: "text-foreground-muted",
};

const TONE_DOT_CLASS: Readonly<Record<VibeProxyAccountTone, string>> = {
  ok: "bg-success",
  warning: "bg-warning",
  error: "bg-danger-foreground",
  muted: "bg-foreground-tertiary",
};

const QUOTA_FILL_CLASS: Readonly<Record<VibeProxyQuotaState, string>> = {
  ok: "bg-success",
  low: "bg-warning",
  critical: "bg-danger-foreground",
  exhausted: "bg-danger-foreground",
  unknown: "bg-foreground-tertiary",
};

type SettingsUpdateOutcome = { readonly _tag: "Success" } | { readonly _tag: "Failure" };

export function VibeProxyUsageSection(props: { readonly usage: VibeProxyUsageView }) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "Vibe-Proxy settings update",
    reportFailure: false,
  });
  const { usage } = props;
  const environmentId = usage.environmentId;
  const settings = usage.settings;

  if (environmentId === null || settings === null) {
    return (
      <SettingsSection title="Vibe-Proxy" card>
        <StateNotice>Connect an environment to configure Vibe-Proxy.</StateNotice>
      </SettingsSection>
    );
  }

  const saveSettings = async (
    environmentId: EnvironmentId,
    patch: ServerSettingsPatch,
  ): Promise<SettingsUpdateOutcome> => {
    const outcome = await updateSettings({ environmentId, input: { patch } });
    if (outcome._tag === "Success") usage.refresh();
    return outcome;
  };

  return (
    <>
      <SettingsSection title="Vibe-Proxy" card>
        <VibeProxyConfigurationForm
          settings={settings}
          onSave={(patch) => saveSettings(environmentId, patch)}
        />
      </SettingsSection>
      <AccountsSection settings={settings} usage={usage} />
    </>
  );
}

function VibeProxyConfigurationForm(props: {
  readonly settings: VibeProxySettings;
  readonly onSave: (patch: ServerSettingsPatch) => Promise<SettingsUpdateOutcome>;
}) {
  const activeTrack = String(useThemeColor("--color-switch-active"));
  const inactiveTrack = String(useThemeColor("--color-secondary-border"));
  const [enabled, setEnabled] = useState(props.settings.enabled);
  const [baseUrl, setBaseUrl] = useState(props.settings.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isSaving) return;
    setEnabled(props.settings.enabled);
    setBaseUrl(props.settings.baseUrl);
  }, [isSaving, props.settings.baseUrl, props.settings.enabled]);

  const save = async () => {
    setIsSaving(true);
    setMessage(null);
    const trimmedKey = apiKey.trim();
    const outcome = await props.onSave({
      vibeProxy: {
        enabled,
        baseUrl: baseUrl.trim(),
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
      },
    });
    setIsSaving(false);
    if (outcome._tag === "Failure") {
      setMessage("Could not save Vibe-Proxy settings.");
      return;
    }
    setApiKey("");
    setMessage("Saved");
  };

  const removeKey = async () => {
    setIsSaving(true);
    setMessage(null);
    const outcome = await props.onSave({ vibeProxy: { apiKey: "" } });
    setIsSaving(false);
    if (outcome._tag === "Failure") {
      setMessage("Could not remove the API key.");
      return;
    }
    setApiKey("");
    setMessage("Key removed");
  };

  return (
    <View className="gap-4 p-4">
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base text-foreground">Enabled</Text>
          <Text className="text-xs text-foreground-muted">
            Read subscription limits from Vibe-Proxy.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Enable Vibe-Proxy usage"
          disabled={isSaving}
          ios_backgroundColor={inactiveTrack}
          onValueChange={setEnabled}
          trackColor={{ false: inactiveTrack, true: activeTrack }}
          value={enabled}
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-xs font-t3-medium text-foreground-muted">Base URL</Text>
        <TextInput
          accessibilityLabel="Vibe-Proxy API base URL"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          keyboardType="url"
          onChangeText={setBaseUrl}
          placeholder="https://vibe-proxy.example.com"
          value={baseUrl}
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-xs font-t3-medium text-foreground-muted">Management API key</Text>
        <TextInput
          accessibilityLabel="Vibe-Proxy API key"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          onChangeText={setApiKey}
          placeholder={props.settings.apiKeyRedacted ? "Stored, enter to replace" : "API key"}
          secureTextEntry
          value={apiKey}
        />
      </View>
      <View className="flex-row items-center justify-end gap-2">
        {message ? <Text className="mr-auto text-xs text-foreground-muted">{message}</Text> : null}
        {props.settings.apiKeyRedacted ? (
          <Pressable
            accessibilityRole="button"
            disabled={isSaving}
            onPress={() => void removeKey()}
            className="min-h-[42px] justify-center rounded-[14px] border border-input-border px-3 active:opacity-60"
          >
            <Text className="text-xs font-t3-medium text-danger-foreground">Remove key</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={isSaving}
          onPress={() => void save()}
          className={
            isSaving
              ? "min-h-[42px] justify-center rounded-[14px] bg-primary px-4 opacity-50"
              : "min-h-[42px] justify-center rounded-[14px] bg-primary px-4 active:opacity-70"
          }
        >
          <Text className="text-xs font-t3-medium text-primary-foreground">
            {isSaving ? "Saving..." : "Save"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function AccountsSection(props: {
  readonly settings: VibeProxySettings;
  readonly usage: VibeProxyUsageView;
}) {
  const stage = resolveVibeProxyUsageStage({
    settings: props.settings,
    result: props.usage.result,
    isRefreshing: props.usage.isRefreshing,
    transportError: props.usage.error,
  });
  const groups = useMemo(
    () => (stage.kind === "accounts" ? groupVibeProxyAccounts(stage.accounts) : []),
    [stage],
  );
  const snapshotAge =
    stage.kind === "accounts" ? formatSnapshotAge(stage.fetchedAt, Date.now()) : null;

  return (
    <SettingsSection title="Accounts" card>
      <View className="flex-row items-center justify-between gap-4 p-4">
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
          {snapshotAge ?? "Subscription quotas and request health"}
        </Text>
        <Pressable
          accessibilityLabel="Refresh Vibe-Proxy limits"
          accessibilityRole="button"
          disabled={props.usage.isRefreshing}
          onPress={props.usage.refresh}
          className={
            props.usage.isRefreshing
              ? "rounded-full bg-subtle px-3 py-2 opacity-50"
              : "rounded-full bg-subtle px-3 py-2 active:opacity-60"
          }
        >
          <Text className="text-xs font-t3-medium text-foreground">
            {props.usage.isRefreshing ? "Refreshing..." : "Refresh"}
          </Text>
        </Pressable>
      </View>

      {stage.kind === "disabled" ? (
        <StateNotice>Turn on Vibe-Proxy to see account quotas.</StateNotice>
      ) : null}
      {stage.kind === "unconfigured" ? (
        <StateNotice>{describeMissingConfiguration(stage.missing)}</StateNotice>
      ) : null}
      {stage.kind === "loading" ? <StateNotice>Loading account limits...</StateNotice> : null}
      {stage.kind === "empty" ? (
        <StateNotice warning={stage.problem !== null}>
          {stage.problem ?? "Vibe-Proxy reported no accounts."}
        </StateNotice>
      ) : null}
      {stage.kind === "accounts" ? (
        <View className={stage.stale ? "opacity-60" : undefined}>
          {stage.problem ? (
            <StateNotice warning>
              {stage.problem} Showing the last values Vibe-Proxy reported.
            </StateNotice>
          ) : null}
          {groups.length === 0 ? (
            <StateNotice>Vibe-Proxy reported no accounts.</StateNotice>
          ) : (
            groups.map((group) => (
              <View key={group.key} className="border-t border-border-subtle">
                <View className="flex-row items-center gap-2 px-4 py-3">
                  <ProviderMark provider={group.provider} />
                  <Text className="text-sm font-t3-medium text-foreground">{group.label}</Text>
                  <Text className="text-xs text-foreground-tertiary">{group.accounts.length}</Text>
                </View>
                {group.accounts.map((account, index) => (
                  <AccountRow key={account.id} account={account} divided={index > 0} />
                ))}
              </View>
            ))
          )}
        </View>
      ) : null}
    </SettingsSection>
  );
}

function ProviderMark(props: { readonly provider: string }) {
  const kind = vibeProxyProviderKind(props.provider);
  const provider = kind === "claude" ? "claudeAgent" : kind;
  if (provider === "codex" || provider === "claudeAgent" || provider === "grok") {
    return <ProviderIcon provider={provider} size={17} />;
  }
  return (
    <View className="size-5 items-center justify-center rounded-md bg-subtle-strong">
      <Text className="text-[8px] font-t3-bold text-foreground-muted">
        {vibeProxyProviderInitials(props.provider)}
      </Text>
    </View>
  );
}

function AccountRow(props: { readonly account: VibeProxyUsageAccount; readonly divided: boolean }) {
  const status = vibeProxyAccountStatus(props.account);
  const health = vibeProxyRequestHealth(props.account);
  const activity = vibeProxyRecentActivity(props.account);
  const quota = vibeProxyQuotaSummary(props.account);
  const subtitle = vibeProxyAccountSubtitle(props.account);
  const plan = props.account.planType?.trim() || props.account.accountType?.trim() || null;

  return (
    <View
      className={
        props.divided ? "gap-3 border-t border-border-subtle px-4 py-4" : "gap-3 px-4 py-4"
      }
    >
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <View className={`size-1.5 rounded-full ${TONE_DOT_CLASS[status.tone]}`} />
          <Text
            className="min-w-0 flex-1 text-base font-t3-medium text-foreground"
            numberOfLines={1}
          >
            {vibeProxyAccountName(props.account)}
          </Text>
          {props.account.selected ? (
            <Text className="shrink-0 text-xs font-t3-medium text-success">In use</Text>
          ) : null}
          {plan ? <Text className="text-xs text-foreground-muted">{plan}</Text> : null}
        </View>
        {subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <Text className="text-xs text-foreground-muted">
          <Text className={TONE_TEXT_CLASS[status.tone]}>{status.label}</Text>
          {`  ·  ${formatSuccessRate(health.successRate)}`}
          {health.total > 0 ? ` of ${health.total.toLocaleString()}` : ""}
          {health.failed > 0 ? `  ·  ${health.failed.toLocaleString()} failed` : ""}
        </Text>
        {status.detail ? (
          <Text className="text-xs text-foreground-tertiary">{status.detail}</Text>
        ) : null}
        {activity.buckets.length > 0 ? (
          <Text className="text-xs text-foreground-tertiary">
            Recent: {activity.success.toLocaleString()} ok, {activity.failed.toLocaleString()}{" "}
            failed
          </Text>
        ) : null}
      </View>

      {quota.kind === "windows" ? (
        <View className="gap-3">
          {quota.windows.map((window) => (
            <QuotaWindow key={window.id} window={window} />
          ))}
        </View>
      ) : (
        <Text className="text-xs text-foreground-muted">{quota.message}</Text>
      )}
    </View>
  );
}

function QuotaWindow(props: { readonly window: VibeProxyQuotaWindowView }) {
  const { window } = props;
  const reset = formatQuotaReset(window.resetAt, Date.now());
  const width = `${Math.round((window.remainingFraction ?? 0) * 1000) / 10}%` as `${number}%`;
  return (
    <View
      accessible
      accessibilityLabel={`${window.label} remaining`}
      accessibilityValue={
        window.remainingPercent === null
          ? { text: "Unknown" }
          : { min: 0, max: 100, now: Math.round(window.remainingPercent) }
      }
      className="gap-1"
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-xs font-t3-medium text-foreground" numberOfLines={1}>
          {window.label}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {window.remainingPercent === null
            ? "Unknown"
            : formatQuotaPercent(window.remainingPercent)}
        </Text>
      </View>
      <View className="h-1.5 overflow-hidden rounded-full bg-subtle-strong">
        <View
          className={`h-full rounded-full ${QUOTA_FILL_CLASS[window.state]}`}
          style={{ width }}
        />
      </View>
      {reset || window.routing ? (
        <Text className="text-xs text-foreground-tertiary">
          {[reset, window.routing ? "Routing" : null].filter(Boolean).join("  ·  ")}
        </Text>
      ) : null}
    </View>
  );
}

function StateNotice(props: { readonly warning?: boolean; readonly children: React.ReactNode }) {
  return (
    <Text
      className={
        props.warning
          ? "border-t border-border-subtle px-4 py-4 text-sm text-warning"
          : "border-t border-border-subtle px-4 py-4 text-sm text-foreground-muted"
      }
    >
      {props.children}
    </Text>
  );
}
