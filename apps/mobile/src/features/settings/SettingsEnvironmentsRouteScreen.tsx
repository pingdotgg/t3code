import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
  SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
  SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS,
} from "../showcase/showcaseEnvironmentRows";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

export function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentSections = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });
  const localEnvironments = SHOWCASE_ENABLED
    ? applyShowcaseLocalEnvironmentDisplayUrls(environmentSections.localEnvironments)
    : environmentSections.localEnvironments;
  const connectedCloudEnvironments = SHOWCASE_ENABLED
    ? SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS
    : environmentSections.connectedCloudEnvironments;
  const hasLocalEnvironments = localEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const headerIconColor = useUniwindTheme()["--color-icon"];

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);
  const handleUpdateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => {
      if (!SHOWCASE_ENABLED) return onUpdateEnvironment(environmentId, updates);
      const actualEnvironment = environmentSections.localEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      const presentedEnvironment = localEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      return onUpdateEnvironment(environmentId, {
        ...updates,
        displayUrl:
          actualEnvironment && presentedEnvironment
            ? resolveShowcaseEnvironmentUpdateDisplayUrl({
                actualDisplayUrl: actualEnvironment.displayUrl,
                presentedDisplayUrl: presentedEnvironment.displayUrl,
                submittedDisplayUrl: updates.displayUrl,
              })
            : updates.displayUrl,
      });
    },
    [environmentSections.localEnvironments, localEnvironments, onUpdateEnvironment],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title="Environments"
            onBack={() => navigation.goBack()}
            actions={[
              {
                accessibilityLabel: "Add environment",
                icon: "plus",
                onPress: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironmentNew" },
                  }),
              },
            ]}
          />
        </>
      ) : (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            icon="plus"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsEnvironmentNew" },
              })
            }
            separateBackground
            tintColor={headerIconColor}
          />
        </NativeHeaderToolbar>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {hasLocalEnvironments ? (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {localEnvironments.map((environment, index) => (
              <View
                key={environment.environmentId}
                collapsable={false}
                className={cn(index !== 0 && "border-t border-border")}
              >
                <ConnectionEnvironmentRow
                  environment={environment}
                  expanded={expandedId === environment.environmentId}
                  onToggle={() => handleToggle(environment.environmentId)}
                  onReconnect={onReconnectEnvironment}
                  onRemove={onRemoveEnvironmentPress}
                  onUpdate={handleUpdateEnvironment}
                />
              </View>
            ))}
          </View>
        ) : (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            <View className="h-12 w-12 items-center justify-center rounded-[16px] bg-subtle">
              <SymbolView
                name="point.3.connected.trianglepath.dotted"
                size={20}
                tintColorClassName={"accent-icon-muted"}
                type="monochrome"
              />
            </View>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              No environments connected yet.{"\n"}Tap{" "}
              <Text className="font-t3-bold text-foreground">+</Text> to add one.
            </Text>
          </View>
        )}

        {/* Always mounted: already-connected relay environments must stay
            visible (and removable) even when cloud config is missing or the
            user is signed out — the component gates discovery itself. */}
        <CloudEnvironmentRows
          connectedCloudEnvironments={connectedCloudEnvironments}
          onReconnectEnvironment={onReconnectEnvironment}
          {...(SHOWCASE_ENABLED
            ? {
                showcaseAvailableEnvironments: SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
                showcaseSignedIn: true,
              }
            : {})}
        />
        {[...localEnvironments, ...connectedCloudEnvironments].map((environment) => (
          <EnvironmentTranscriptionRow
            key={`transcription-${environment.environmentId}`}
            environmentId={environment.environmentId}
            environmentLabel={environment.environmentLabel}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function EnvironmentTranscriptionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const services = useAtomValue(
    serverEnvironment.transcriptionServicesValueAtom(props.environmentId),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  if (services.length === 0) return null;

  const localAvailable = getLocalVoiceTranscriber() !== null;
  const savedSource = AsyncResult.isSuccess(preferences)
    ? preferences.value.voiceTranscriptionSources?.[props.environmentId]
    : undefined;
  const selectedSource = savedSource ?? (localAvailable ? "local" : services[0]?.id);
  const selectedLabel =
    selectedSource === "local"
      ? "On this device"
      : (services.find((service) => service.id === selectedSource)?.label ?? "Unavailable");
  const actions = [
    ...(localAvailable
      ? [
          {
            id: "local",
            title: "On this device",
            state: selectedSource === "local" ? ("on" as const) : ("off" as const),
          },
        ]
      : []),
    ...services.map((service) => ({
      id: service.id,
      title: service.label,
      state: selectedSource === service.id ? ("on" as const) : ("off" as const),
    })),
  ];

  return (
    <ControlPillMenu
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const current = AsyncResult.isSuccess(preferences)
          ? (preferences.value.voiceTranscriptionSources ?? {})
          : {};
        savePreferences({
          voiceTranscriptionSources: {
            ...current,
            [props.environmentId]: nativeEvent.event,
          },
        });
      }}
    >
      <Pressable
        accessibilityLabel={`${props.environmentLabel} voice transcription: ${selectedLabel}`}
        accessibilityRole="button"
        className="mt-3 flex-row items-center justify-between rounded-[24px] bg-card px-4 py-3"
      >
        <View className="flex-row items-center gap-3">
          <SymbolView
            name="waveform"
            size={18}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
          <View>
            <Text className="text-sm text-foreground">Voice transcription</Text>
            <Text className="text-xs text-foreground-muted">{props.environmentLabel}</Text>
          </View>
        </View>
        <Text className="text-sm text-foreground-muted">{selectedLabel}</Text>
      </Pressable>
    </ControlPillMenu>
  );
}
