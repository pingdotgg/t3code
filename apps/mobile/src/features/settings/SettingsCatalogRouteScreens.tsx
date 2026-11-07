import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  SecretProviderId,
  SecretProviderKind,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentsWithScope } from "../../state/session";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useSettingsWriter } from "./useSettingsWriter";
import {
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

function SettingsCatalogPage(props: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  const environmentMenu = useSettingsEnvironmentMenu();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={props.title} menus={[environmentMenu]}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}

function useServerSettingsPage() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  // These pages edit environment defaults, not project overrides.
  const targets = resolveMobileSettingsTargets(selectedTargets, null);
  const writeSettings = useSettingsWriter();
  const [pending, setPending] = useState(false);

  async function write(patch: ServerSettingsPatch) {
    if (pending) return;
    const writes = planMobileScopedSettingsPatch(targets, false, patch);
    if (writes.length === 0) return;
    setPending(true);
    await writeSettings(targets, writes);
    setPending(false);
  }

  return {
    selectedTargets,
    targets,
    pending,
    write,
    canWrite:
      targets.length > 0 &&
      targets.every((target) => writable.has(target.environment.environmentId)),
    uniform: <Key extends keyof ServerSettings>(key: Key) => uniformMobileSetting(targets, key),
  };
}

export function SettingsDiffsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const hideTestFiles = preferences?.pullRequestHideTestFiles === true;
  const mergeMethod = preferences?.pullRequestMergeMethod ?? "squash";

  return (
    <SettingsCatalogPage title="Diffs & pull requests">
      <SettingsSection title="Pull requests">
        <SettingsSwitchRow
          label="Hide test files"
          subtitle="Omit common test paths from the pull request file list."
          value={hideTestFiles}
          onValueChange={(value) => updatePreferences({ pullRequestHideTestFiles: value })}
        />
        <View className="gap-1 px-4 py-3">
          <Text className="text-base text-foreground">Preferred merge method</Text>
          <Text className="text-sm text-foreground-muted">
            Used when this device offers a merge action.
          </Text>
          <View className="mt-2 gap-1">
            {(
              [
                ["squash", "Squash"],
                ["merge", "Merge commit"],
                ["rebase", "Rebase"],
              ] as const
            ).map(([value, label]) => (
              <SettingsChoiceRow
                key={value}
                label={label}
                selected={mergeMethod === value}
                onPress={() => updatePreferences({ pullRequestMergeMethod: value })}
              />
            ))}
          </View>
        </View>
      </SettingsSection>
      <Text className="px-1 text-sm text-foreground-muted">
        Diff layout and colors stay on this device. Web and desktop keep their own client
        preferences.
      </Text>
    </SettingsCatalogPage>
  );
}

export function SettingsBrowserRouteScreen() {
  const page = useServerSettingsPage();
  return (
    <SettingsCatalogPage title="Browser">
      <SettingsSection title="Agent access">
        <SettingsSwitchRow
          label="Allow agent browser"
          subtitle="Let agents open and control a browser on the environment."
          value={page.uniform("enableAgentBrowserAccess")}
          disabled={!page.canWrite || page.pending}
          onValueChange={(enabled) => void page.write({ enableAgentBrowserAccess: enabled })}
        />
      </SettingsSection>
      <Text className="px-1 text-sm text-foreground-muted">
        Browser profiles, viewport, and recording preferences are stored on the desktop or web
        client that owns the preview session.
      </Text>
    </SettingsCatalogPage>
  );
}

export function SettingsDevicesRouteScreen() {
  const page = useServerSettingsPage();
  const hub = page.uniform("enableDeviceSupport");
  return (
    <SettingsCatalogPage title="Devices">
      <SettingsSection title="Device hub">
        <SettingsSwitchRow
          label="Enable device support"
          subtitle="Let this environment talk to simulators, emulators, and device hosts."
          value={hub}
          disabled={!page.canWrite || page.pending}
          onValueChange={(enabled) => void page.write({ enableDeviceSupport: enabled })}
        />
        <SettingsSwitchRow
          label="Allow agent device access"
          subtitle="Let agents drive devices through the Device panel tools."
          value={page.uniform("enableAgentDeviceAccess")}
          disabled={!page.canWrite || page.pending || hub === false}
          onValueChange={(enabled) => void page.write({ enableAgentDeviceAccess: enabled })}
        />
      </SettingsSection>
      <Text className="px-1 text-sm text-foreground-muted">
        SSH, EAS, and Simlock device hosts are still configured on web or desktop. Turning support
        on here is enough for environments that already have hosts.
      </Text>
    </SettingsCatalogPage>
  );
}

export function SettingsAccessRouteScreen() {
  const navigation = useNavigation();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <SettingsCatalogPage title="Sharing & access">
      <SettingsSection title="Environments">
        {selectedTargets.length === 0 ? (
          <Text className="p-4 text-foreground-muted">Select a connected environment.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <SettingsActionRow
              key={environment.environmentId}
              label={environment.label}
              description="Routes, pairing, and client sessions"
              onPress={() =>
                navigation.navigate("SettingsEnvironmentDetail", {
                  environmentId: environment.environmentId,
                })
              }
            />
          ))
        )}
      </SettingsSection>
      <Text className="px-1 text-sm text-foreground-muted">
        Host network exposure, Tailscale, and WSL controls stay on the machine running the server.
      </Text>
    </SettingsCatalogPage>
  );
}

export function SettingsSecretsRouteScreen() {
  const page = useServerSettingsPage();
  const secretsEnabled = Constants.expoConfig?.extra?.secretsFeatureEnabled === true;
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const settingsWritable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const providersWritable = useEnvironmentsWithScope(selectedTargets, AuthProvidersManageScope);

  if (!secretsEnabled) {
    return (
      <SettingsCatalogPage title="Secrets">
        <Text className="text-foreground-muted">Secrets are not enabled in this build.</Text>
      </SettingsCatalogPage>
    );
  }

  if (page.targets.length !== 1) {
    return (
      <SettingsCatalogPage title="Secrets">
        <Text className="text-foreground-muted">
          Select a single environment to manage secret providers.
        </Text>
      </SettingsCatalogPage>
    );
  }

  const target = page.targets[0]!;
  const environmentId = target.environment.environmentId;
  // Add needs providers-manage; remove also clears settings fields that referenced the provider.
  const canAdd = providersWritable.has(environmentId);
  const canRemove = canAdd && settingsWritable.has(environmentId);

  return (
    <SettingsSecretsEditor
      key={environmentId}
      target={target}
      pending={page.pending}
      canAdd={canAdd}
      canRemove={canRemove}
      write={page.write}
    />
  );
}

function SettingsSecretsEditor(props: {
  readonly target: ScopedMobileSettingsTarget;
  readonly pending: boolean;
  readonly canAdd: boolean;
  readonly canRemove: boolean;
  readonly write: (patch: ServerSettingsPatch) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState("");
  const providers = props.target.environment.serverConfig.settings.secretProviders ?? {};
  const entries = Object.entries(providers);

  return (
    <SettingsCatalogPage title="Secrets">
      <SettingsSection title="Providers">
        {entries.length === 0 ? (
          <Text className="p-4 text-foreground-muted">No secret providers configured.</Text>
        ) : (
          entries.map(([id, provider]) => (
            <View key={id} className="gap-1 border-b border-border-subtle px-4 py-3">
              <Text className="text-base text-foreground">{provider.label}</Text>
              <Text className="text-sm text-foreground-muted">{provider.kind}</Text>
              {props.canRemove ? (
                <SettingsActionRow
                  label="Remove"
                  tone="danger"
                  loading={props.pending}
                  onPress={() => {
                    const providerId = SecretProviderId.make(id);
                    void props.write({ secretProviders: { [providerId]: null } });
                  }}
                />
              ) : null}
            </View>
          ))
        )}
      </SettingsSection>
      {props.canAdd ? (
        <SettingsSection title="Add 1Password">
          <View className="gap-2 p-4">
            <TextInput
              accessibilityLabel="Label"
              className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder="Label"
              value={label}
              onChangeText={setLabel}
            />
            <TextInput
              accessibilityLabel="1Password account id"
              className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder="Account id"
              autoCapitalize="none"
              autoCorrect={false}
              value={account}
              onChangeText={setAccount}
            />
            <Button
              label="Add provider"
              disabled={props.pending || label.trim().length === 0 || account.trim().length === 0}
              onPress={() => {
                const id = SecretProviderId.make(
                  `one_password_${label
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "_")}`.slice(0, 64),
                );
                if (Object.hasOwn(providers, id)) {
                  Dialog.alert(
                    "Provider already exists",
                    "Choose a different label. This name maps to an existing secret provider.",
                  );
                  return;
                }
                void props
                  .write({
                    secretProviders: {
                      [id]: {
                        kind: SecretProviderKind.make("one_password"),
                        label: label.trim(),
                        config: { account: account.trim() },
                      },
                    },
                  })
                  .then(() => {
                    setLabel("");
                    setAccount("");
                  });
              }}
            />
          </View>
        </SettingsSection>
      ) : null}
    </SettingsCatalogPage>
  );
}
