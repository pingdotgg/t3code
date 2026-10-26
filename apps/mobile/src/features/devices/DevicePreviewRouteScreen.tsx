import { SheetCloseButton } from "../../components/ui/SheetHeader";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import {
  deviceToolVersionLabels,
  deviceToolUpdateOwnership,
  deviceToolUpdatePolicy,
} from "@t3tools/client-runtime/state/device";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import { Pressable, StatusBar, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { GlassSurface } from "../../components/ui/GlassSurface";
import {
  androidHeaderMenuActions,
  findHeaderMenuAction,
} from "../../components/ui/headerMenu.android";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useAppForeground } from "../../lib/appState";
import { useHardwareBack } from "../../lib/backHandler";
import { deriveBottomControlInsets } from "../../lib/reserved-regions";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
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
  readonly deviceKey?: string;
}>;

export function DevicePreviewRouteScreen({ route }: DevicePreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId, threadId } = route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  useEffect(() => {
    if (isBlankLink) onClose();
  }, [isBlankLink, onClose]);
  if (isBlankLink) return null;
  return (
    <DevicePreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      initialDeviceKey={route.params.deviceKey}
      onClose={onClose}
    />
  );
}

export function DevicePreviewScreen({
  environmentId,
  threadId,
  onClose,
  onMaximize,
  initialDeviceKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
  readonly onMaximize?: (deviceKey: string | null) => void;
  readonly initialDeviceKey?: string;
}) {
  const embedded = onMaximize !== undefined;
  const insets = useSafeAreaInsets();
  // NativeColumnContent already insets the sides, so only a book fold moves the reveal handle.
  const handleBounds = deriveBottomControlInsets(useNativeColumnLayoutMetrics());
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedKey, setSelectedKey] = useState<string | null>(initialDeviceKey ?? null);
  const [inputConnected, setInputConnected] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const retryHost = useAtomCommand(deviceEnvironment.list);
  const shutdown = useAtomCommand(deviceEnvironment.shutdown, { reportFailure: false });
  const streamRef = useRef<DeviceStreamRef>(null);
  const state = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  const previews = threadDevicePreviews(state.data, threadId);
  const preview = selectedThreadDevicePreview(previews, selectedKey);
  const onInputConnected = useCallback(
    async (connected: boolean) => {
      setInputConnected(connected);
      if (connected && !embedded) setControlsVisible(false);
    },
    [embedded],
  );
  useEffect(() => {
    if (focused && state.data !== null && previews.length === 0) onClose();
  }, [focused, state.data, previews.length, onClose]);
  useEffect(() => {
    if (!focused || !foreground || embedded) return;
    const shaken = createShakeDetector();
    Accelerometer.setUpdateInterval(50);
    const subscription = Accelerometer.addListener((sample) => {
      if (!shaken({ ...sample, timestamp: sample.timestamp * 1000 })) return;
      void Haptics.selectionAsync();
      setControlsVisible((visible) => !visible);
    });
    return () => subscription.remove();
  }, [focused, foreground, embedded]);
  useHardwareBack(!controlsVisible, () => {
    setControlsVisible(true);
    return true;
  });

  const shutDownDevice = async () => {
    if (!preview || shuttingDown) return;
    setShuttingDown(true);
    const result = await shutdown({
      environmentId,
      input: {
        hostId: preview.session.hostId,
        deviceId: preview.session.deviceId,
        platform: preview.session.platform,
      },
    }).finally(() => setShuttingDown(false));
    if (result._tag === "Failure") {
      Dialog.alert("Could not shut down device", String(Cause.squash(result.cause)));
    }
  };

  const controls: AppBarMenuItem[] = [
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
        Dialog.alert(
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
  const menuItems: AppBarMenuItem[] = [
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
      {!embedded ? <StatusBar hidden animated /> : null}
      {embedded ? (
        <View
          className="flex-row items-center gap-1 px-2 pb-2"
          style={{ paddingTop: Math.max(insets.top, 8) }}
        >
          <SheetCloseButton accessibilityLabel="Close device preview" onClose={onClose} />
          <AppText numberOfLines={1} className="min-w-0 flex-1 font-t3-medium text-sm">
            {preview?.name ?? "Devices"}
          </AppText>
          <ControlPill
            accessibilityLabel="Maximize device"
            icon="arrow.up.left.and.arrow.down.right"
            onPress={() => onMaximize(preview?.key ?? null)}
          />
        </View>
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
              <View className="items-center">
                <Button label="Retry" tone="secondary" onPress={state.refresh} />
              </View>
            </>
          ) : focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
      {embedded ? (
        <View
          className="flex-row items-center justify-center gap-2 px-3 py-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <ControlPill
            accessibilityLabel="Home"
            icon="house"
            disabled={!inputConnected}
            onPress={pressHome}
          />
          <DeviceOptionsMenu items={menuItems} />
        </View>
      ) : controlsVisible ? (
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
              <SheetCloseButton accessibilityLabel="Close device preview" onClose={onClose} />
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
          className="absolute h-11 w-16 items-center justify-center self-center"
          style={{
            top: Math.max(insets.top, 12),
            transform: [{ translateX: (handleBounds.left - handleBounds.right) / 2 }],
          }}
          onPress={() => setControlsVisible(true)}
        >
          <View className="h-1.5 w-10 rounded-full bg-white/40" />
        </Pressable>
      )}
    </View>
  );
}

function DeviceOptionsMenu({ items }: { readonly items: ReadonlyArray<AppBarMenuItem> }) {
  return (
    <Menu
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
    </Menu>
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
  const onUnauthorized = async () => refreshDeviceHubAccess(environmentId);
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
          <View className="items-center">
            <Button label="Retry" tone="secondary" onPress={refresh} />
          </View>
        </>
      ) : (
        <>
          <AppActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">Connecting to device...</AppText>
        </>
      )}
    </View>
  );
}
