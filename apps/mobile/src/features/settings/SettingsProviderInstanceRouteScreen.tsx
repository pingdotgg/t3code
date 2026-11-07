import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  EnvironmentId,
  isManagedSettingPath,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerProvider,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { ProviderSettingsFields } from "./ProviderSettingsFields";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsProviderInstanceRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}>) {
  const { environmentId, instanceId } = route.params;
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environment = selectedTargets.find((target) => target.environmentId === environmentId);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const provider = (providersByEnvironment.get(environmentId) ?? []).find(
    (entry) => entry.instanceId === instanceId,
  );

  if (!environment || !provider) {
    return (
      <SettingsScreen title="Provider">
        <View className="flex-1 items-center justify-center px-5">
          <Text className="text-foreground-muted">This provider is no longer available.</Text>
        </View>
      </SettingsScreen>
    );
  }

  return (
    <ProviderInstanceEditor environment={environment} provider={provider} instanceId={instanceId} />
  );
}

function ProviderInstanceEditor(props: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
  readonly instanceId: ProviderInstanceId;
}) {
  const { environment, provider, instanceId } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const permitted = useEnvironmentsWithScope([environment], AuthProvidersManageScope).has(
    environment.environmentId,
  );
  const instance = environment.serverConfig.settings.providerInstances[instanceId];
  const definition = getProviderClient(provider.driver);
  const managed =
    environment.serverConfig.managedPolicy &&
    isManagedSettingPath(environment.serverConfig.managedPolicy, `providerInstances.${instanceId}`);
  const { run, pending, error } = useProviderInstanceMutation(environment);
  const [nameDraft, setNameDraft] = useState(provider.displayName ?? "");
  const canRemove = permitted && !managed;

  async function upsert(next: ProviderInstanceConfig) {
    const ok = await run({
      operation: "upsert",
      instanceId,
      instance: next,
    });
    return ok;
  }

  function patchInstance(patch: Partial<ProviderInstanceConfig>) {
    if (!instance || managed || !permitted) return;
    void upsert({ ...instance, ...patch });
  }

  function remove() {
    Dialog.alert(
      "Remove provider?",
      `Threads that use ${provider.displayName ?? provider.driver} on ${environment.label} keep their history, but this instance is deleted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void run({ operation: "remove", instanceId }).then((ok) => {
              if (ok) navigation.goBack();
            });
          },
        },
      ],
    );
  }

  return (
    <SettingsScreen
      title={provider.displayName ?? definition?.label ?? provider.driver}
      actions={
        canRemove
          ? [
              {
                accessibilityLabel: "Remove provider",
                icon: "trash",
                destructive: true,
                disabled: pending,
                onPress: remove,
              },
            ]
          : undefined
      }
    >
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!permitted ? (
          <Text className="text-foreground-muted">
            This session can view {environment.label}&apos;s providers but can&apos;t change their
            settings.
          </Text>
        ) : null}
        {error ? <Text className="text-destructive">{error}</Text> : null}
        <SettingsSection title="Instance">
          <SettingsSwitchRow
            label="Enabled"
            value={provider.enabled}
            disabled={!permitted || managed || pending || !instance}
            onValueChange={(enabled) => patchInstance({ enabled })}
          />
          <View className="gap-1 border-b border-border-subtle px-4 py-3">
            <Text className="text-base text-foreground">Display name</Text>
            <TextInput
              accessibilityLabel="Display name"
              className="mt-1 rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder={definition?.label ?? provider.driver}
              autoCapitalize="words"
              editable={permitted && !managed && !pending}
              value={nameDraft}
              onChangeText={setNameDraft}
              onEndEditing={() => {
                const displayName = nameDraft.trim();
                patchInstance(displayName ? { displayName } : { displayName: undefined });
              }}
            />
          </View>
        </SettingsSection>
        {definition ? (
          <ProviderSettingsFields
            definition={definition}
            value={instance?.config}
            disabled={!permitted || managed || pending}
            onChange={(config) => patchInstance({ config })}
          />
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function useProviderInstanceMutation(environment: SettingsTarget) {
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(providerInstanceMutation: ProviderInstanceMutation) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await mutate({
      environmentId: environment.environmentId,
      input: { patch: {}, providerInstanceMutation },
    });
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save provider settings.");
    }
    return false;
  }
  return { run, pending, error };
}
