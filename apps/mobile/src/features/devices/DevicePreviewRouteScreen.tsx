import {
  deviceToolVersionLabels,
  deviceToolUpdateOwnership,
  deviceToolUpdatePolicy,
} from "@t3tools/client-runtime/state/device";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Pressable,
  StatusBar,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { GlassSurface } from "../../components/GlassSurface";
import {
  androidHeaderMenuActions,
  findHeaderMenuAction,
} from "../../components/headerMenu.android";
import type { ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";
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
import { createShakeDetector } from "./shakeDetector";

const OVERLAY_ENTERING = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const OVERLAY_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

type DevicePreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/** Full-screen viewer; controls live in an overlay toggled by the handle or a shake. */
export function DevicePreviewRouteScreen({ route }: DevicePreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  const { environmentId, threadId } = route.params;
  // A hand-typed deep link can carry a blank ID, which the branded IDs reject.
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  useEffect(() => {
    if (isBlankLink) onClose();
  }, [isBlankLink, onClose]);
  if (isBlankLink) return null;
  return (
    <DevicePreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      onClose={onClose}
    />
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
  const [controlsVisible, setControlsVisible] = useState(true);
  const retryHost = useAtomCommand(deviceEnvironment.list);
  const shutdown = useAtomCommand(deviceEnvironment.shutdown, { reportFailure: false });
  const streamRef = useRef<DeviceStreamRef>(null);
  const state = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  const previews = useMemo(
    () => threadDevicePreviews(state.data, threadId),
    [state.data, threadId],
  );
  const preview = selectedThreadDevicePreview(previews, selectedKey);
  const onInputConnected = useCallback(async (connected: boolean) => {
    setInputConnected(connected);
    // Controls greet the user while connecting, then get out of the stream's way.
    if (connected) setControlsVisible(false);
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (focused && state.data !== null && previews.length === 0) onClose();
  }, [focused, state.data, previews.length, onClose]);
  useEffect(() => {
    if (!focused || !foreground) return;
    const shaken = createShakeDetector();
    Accelerometer.setUpdateInterval(50);
    const subscription = Accelerometer.addListener((sample) => {
      if (!shaken({ ...sample, timestamp: sample.timestamp * 1000 })) return;
      void Haptics.selectionAsync();
      setControlsVisible((visible) => !visible);
    });
    return () => subscription.remove();
  }, [focused, foreground]);
  // Android back reveals the controls first, so leaving takes a deliberate second press.
  useEffect(() => {
    if (controlsVisible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setControlsVisible(true);
      return true;
    });
    return () => subscription.remove();
  }, [controlsVisible]);

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
  const pressHome = () => streamRef.current?.home();
  const menuItems: ScreenHeaderMenuItem[] = [
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
  ];
  return (
    <View className="flex-1" style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}>
      <StatusBar hidden animated />
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
      {controlsVisible ? (
        <Animated.View
          entering={OVERLAY_ENTERING}
          exiting={OVERLAY_EXITING}
          pointerEvents="box-none"
          className="absolute inset-0"
        >
          {inputConnected ? (
            <Pressable
              accessibilityLabel="Hide device controls"
              className="absolute inset-0 bg-black/30"
              onPress={() => setControlsVisible(false)}
            />
          ) : null}
          <View className="px-3" style={{ paddingTop: Math.max(insets.top, 12) }}>
            <GlassSurface className="flex-row items-center gap-1 p-1">
              <ControlPill
                accessibilityLabel="Close device preview"
                icon="xmark"
                onPress={onClose}
              />
              <AppText numberOfLines={1} className="flex-1 text-center font-t3-medium text-base">
                {preview?.name ?? "Devices"}
              </AppText>
              <ControlPill
                accessibilityLabel="Home"
                icon="house"
                disabled={!inputConnected}
                onPress={pressHome}
              />
              <DeviceOptionsMenu items={menuItems} />
            </GlassSurface>
          </View>
        </Animated.View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show device controls"
          accessibilityHint="Shaking the phone also shows them"
          hitSlop={12}
          className="absolute h-6 w-16 items-center justify-center self-center"
          style={{ top: Math.max(insets.top - 18, 4) }}
          onPress={() => setControlsVisible(true)}
        >
          <View className="h-1.5 w-10 rounded-full bg-white/40" />
        </Pressable>
      )}
    </View>
  );
}

function DeviceOptionsMenu({ items }: { readonly items: ReadonlyArray<ScreenHeaderMenuItem> }) {
  return (
    <ControlPillMenu
      actions={androidHeaderMenuActions(items)}
      isAnchoredToRight
      title="Device options"
      onPressAction={({ nativeEvent }) => {
        const action = findHeaderMenuAction(items, nativeEvent.event);
        if (action && !action.disabled) action.onPress();
      }}
    >
      <Pressable
        accessibilityLabel="Device options"
        accessibilityRole="button"
        className="size-11 items-center justify-center rounded-full bg-subtle"
      >
        <SymbolView name="ellipsis" size={18} tintColorClassName="accent-icon" />
      </Pressable>
    </ControlPillMenu>
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
