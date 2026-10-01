import {
  deviceToolVersionLabels,
  deviceToolUpdateOwnership,
  deviceToolUpdatePolicy,
} from "@t3tools/client-runtime/state/device";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ActivityIndicator, Alert, AppState, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../components/AppText";
import { ScreenHeader, type ScreenHeaderMenuItem } from "../../components/ScreenHeader";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { deviceEnvironment, refreshDeviceHubAccess, useDeviceHubAccess } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { DeviceStreamWebView, type DeviceStreamRef } from "./DeviceStreamWebView";
import {
  selectedThreadDevicePreview,
  threadDevicePreviews,
  type ThreadDevicePreview,
} from "./threadDevicePreviews";

const DevicePreviewStack = createNativeStackNavigator<{ DevicePreview: undefined }>();

type DevicePreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/** The nested native stack supplies the navigation bar inside the modal. */
export function DevicePreviewRouteScreen({ route }: DevicePreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <DevicePreviewStack.Navigator
        screenOptions={{
          headerShown: Platform.OS === "ios",
          headerBackVisible: false,
          headerShadowVisible: false,
          headerTransparent: false,
          headerTitleStyle: { fontSize: 17, fontWeight: "600" },
        }}
      >
        <DevicePreviewStack.Screen name="DevicePreview">
          {() => (
            <DevicePreviewScreen
              environmentId={EnvironmentId.make(route.params.environmentId)}
              threadId={ThreadId.make(route.params.threadId)}
              onClose={onClose}
            />
          )}
        </DevicePreviewStack.Screen>
      </DevicePreviewStack.Navigator>
    </View>
  );
}

function DevicePreviewScreen({
  environmentId,
  threadId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inputConnected, setInputConnected] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [shuttingDown, setShuttingDown] = useState(false);
  const retryHost = useAtomCommand(deviceEnvironment.list);
  const shutdown = useAtomCommand(deviceEnvironment.shutdown, { reportFailure: false });
  const streamRef = useRef<DeviceStreamRef>(null);
  const state = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  const previews = useMemo(
    () => threadDevicePreviews(state.data, threadId),
    [state.data, threadId],
  );
  const preview = selectedThreadDevicePreview(previews, selectedKey);
  const onInputConnected = useCallback(
    async (connected: boolean) => setInputConnected(connected),
    [],
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (focused && state.data !== null && previews.length === 0) onClose();
  }, [focused, state.data, previews.length, onClose]);

  const shutDownDevice = async () => {
    if (!preview || shuttingDown) return;
    setShuttingDown(true);
    try {
      const result = await shutdown({
        environmentId,
        input: {
          hostId: preview.session.hostId,
          deviceId: preview.session.deviceId,
          platform: preview.session.platform,
        },
      });
      if (result._tag === "Failure") {
        Alert.alert("Could not shut down device", String(Cause.squash(result.cause)));
      }
    } finally {
      setShuttingDown(false);
    }
  };

  const controls: ScreenHeaderMenuItem[] = [
    ...(state.data?.hosts
      .filter(
        (host) =>
          state.data?.supportsHostRetry && state.data.hostStatuses[host.id]?.status === "failed",
      )
      .map((host) => ({
        id: `retry-${host.id}`,
        title: `Retry ${host.label}`,
        icon: "arrow.clockwise" as const,
        onPress: () => {
          void retryHost({ environmentId, input: { retryHostId: host.id } });
        },
      })) ?? []),
    ...(state.data?.supportsToolInspection
      ? [
          {
            id: "check-device-tools",
            title: "Check device tool versions",
            icon: "arrow.clockwise" as const,
            onPress: () => {
              void retryHost({ environmentId, input: { inspectOnly: true } });
            },
          },
        ]
      : []),
    {
      id: "device-tools",
      title: "Device tool versions",
      icon: "info.circle",
      onPress: () =>
        Alert.alert(
          "Device tool versions",
          deviceToolUpdateOwnership +
            "\n\n" +
            deviceToolUpdatePolicy(
              state.data?.hosts.find((host) => host.id === preview?.session.hostId)?.tools,
            ) +
            "\n\n" +
            deviceToolVersionLabels(
              state.data?.hosts.find((host) => host.id === preview?.session.hostId)?.tools,
            ).join("\n") +
            "\n" +
            (state.data?.hosts.find((host) => host.id === preview?.session.hostId)
              ?.toolInspectionError ??
              state.data?.hostStatuses[preview?.session.hostId ?? ""]?.detail ??
              ""),
        ),
    },
    {
      id: "reload",
      title: "Reload stream",
      icon: "arrow.clockwise" as const,
      disabled: !preview || shuttingDown,
      onPress: () => {
        setInputConnected(false);
        setStreamAttempt((attempt) => attempt + 1);
      },
    },
    ...(preview?.session.platform === "android"
      ? [
          {
            id: "back",
            title: "Back",
            icon: "arrow.left",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.back(),
          },
        ]
      : []),
    {
      id: "app-switcher",
      title: "App switcher",
      icon: "square.on.square",
      disabled: !inputConnected,
      onPress: () => streamRef.current?.appSwitcher(),
    },
    ...(preview?.session.platform === "ios"
      ? [
          {
            id: "rotate",
            title: "Rotate device",
            icon: "arrow.clockwise" as const,
            disabled: !inputConnected,
            onPress: () => streamRef.current?.rotate(),
          },
        ]
      : []),
    {
      id: "shutdown",
      title: shuttingDown ? "Shutting down…" : "Shut down device",
      icon: "power",
      disabled: !preview || shuttingDown,
      onPress: () => void shutDownDevice(),
    },
  ];
  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <ScreenHeader
        title={preview?.name ?? "Devices"}
        sidebar={false}
        onBack={onClose}
        options={{ headerBackVisible: false }}
        actions={[
          {
            accessibilityLabel: "Home",
            icon: "house",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.home(),
          },
        ]}
        menus={[
          {
            title: "Device options",
            icon: "ellipsis",
            items: [
              ...(previews.length > 1
                ? [
                    {
                      id: "devices",
                      title: "Devices",
                      inline: true,
                      items: previews.map((device) => ({
                        id: device.key,
                        title: device.name,
                        subtitle: device.description,
                        selected: device.key === preview?.key,
                        onPress: () => setSelectedKey(device.key),
                      })),
                    },
                  ]
                : []),
              ...controls,
            ],
          },
        ]}
      />
      {Platform.OS === "ios" ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            icon="xmark"
            accessibilityLabel="Close device preview"
            onPress={onClose}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}
      {preview && focused && foreground ? (
        <OpenDevicePreview
          key={`${preview.key}:${streamAttempt}`}
          environmentId={environmentId}
          preview={preview}
          streamRef={streamRef}
          onInputConnected={onInputConnected}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-4 px-6">
          {state.error ? (
            <>
              <AppText selectable className="text-center text-sm text-foreground-muted">
                {state.error}
              </AppText>
              <Pressable
                accessibilityRole="button"
                className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
                onPress={state.refresh}
              >
                <AppText className="text-secondary-foreground">Retry</AppText>
              </Pressable>
            </>
          ) : focused && foreground ? (
            <ActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
    </View>
  );
}

function OpenDevicePreview({
  environmentId,
  preview,
  streamRef,
  onInputConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly preview: ThreadDevicePreview;
  readonly streamRef: RefObject<DeviceStreamRef | null>;
  readonly onInputConnected: (connected: boolean) => Promise<void>;
}) {
  const { session } = preview;
  const { themeVariables } = useAppearancePreferences();
  const { access, error, refresh } = useDeviceHubAccess(environmentId, session.hostId);
  const onUnauthorized = useCallback(
    async () => refreshDeviceHubAccess(environmentId),
    [environmentId],
  );
  useEffect(() => {
    refreshDeviceHubAccess(environmentId);
    return () => void onInputConnected(false);
  }, [environmentId, onInputConnected]);
  return access ? (
    <DeviceStreamWebView
      ref={streamRef}
      access={access}
      platform={session.platform}
      deviceId={session.deviceId}
      colors={{
        background: themeVariables["--color-sheet-solid"],
        foreground: themeVariables["--color-foreground"],
        muted: themeVariables["--color-foreground-muted"],
        buttonBackground: themeVariables["--color-secondary"],
        buttonForeground: themeVariables["--color-secondary-foreground"],
        buttonBorder: themeVariables["--color-secondary-border"],
      }}
      onUnauthorized={onUnauthorized}
      onInputConnected={onInputConnected}
    />
  ) : (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {error ? (
        <>
          <AppText selectable className="text-center text-sm text-foreground-muted">
            {error}
          </AppText>
          <Pressable
            accessibilityRole="button"
            className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
            onPress={refresh}
          >
            <AppText className="text-secondary-foreground">Retry</AppText>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">Connecting to device...</AppText>
        </>
      )}
    </View>
  );
}
