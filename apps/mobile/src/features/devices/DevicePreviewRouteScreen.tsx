import { translate } from "@t3tools/i18n";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { EnvironmentId, ThreadId, type DeviceToolVersions } from "@t3tools/contracts";
import { useTranslation } from "@t3tools/i18n/react";
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

function localizedDeviceToolVersionLabels(tools: DeviceToolVersions | undefined) {
  if (!tools)
    return [
      translate(
        "common:mobileDevicePreview.versionsNotChecked",
        "Device tool versions have not been checked.",
      ),
    ];
  return (
    [
      ["deviceHub", tools.hub],
      ["agentTools", tools.agent],
    ] as const
  ).map(([nameKey, tool]) => {
    const name = translate(
      `common:mobileDevicePreview.${nameKey}`,
      nameKey === "deviceHub" ? "Device hub" : "Agent tools",
    );
    const installed = tool.installedVersions.length
      ? tool.installedVersions.join(", ")
      : translate("common:mobileDevicePreview.noneInstalled", "none");
    const running = tool.runningVersion
      ? translate("common:mobileDevicePreview.runningVersion", "; running {{version}}", {
          version: tool.runningVersion,
        })
      : "";
    return translate(
      "common:mobileDevicePreview.versionDetails",
      "{{name}}: installed {{installed}}; required {{required}}{{running}}.",
      { name, installed, required: tool.requiredVersion, running },
    );
  });
}

function localizedDeviceToolUpdatePolicy(tools: DeviceToolVersions | undefined) {
  if (!tools)
    return translate(
      "common:mobileDevicePreview.versionPolicyUnknown",
      "Versions have not been checked. Reconnect the host and check versions.",
    );
  const outdated = [tools.hub, tools.agent].some(
    (tool) =>
      tool.installedVersions.length > 0 && !tool.installedVersions.includes(tool.requiredVersion),
  );
  return outdated
    ? translate(
        "common:mobileDevicePreview.updatePending",
        "Update pending. Required tools will install automatically when next used. The host needs network access; an older install is not used as a fallback.",
      )
    : translate(
        "common:mobileDevicePreview.autoInstallPolicy",
        "Required tools are installed automatically when needed. Checking versions does not install or start anything.",
      );
}

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
  const { t } = useTranslation();
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
      if (result._tag === "Failure")
        Alert.alert(
          translate("common:mobileDevicePreview.shutdownFailed", "Could not shut down device"),
          String(Cause.squash(result.cause)),
        );
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
        title: translate("common:mobileDevicePreview.retryHost", "Retry {{host}}", {
          host: host.label,
        }),
        icon: "arrow.clockwise" as const,
        onPress: () => {
          void retryHost({ environmentId, input: { retryHostId: host.id } });
        },
      })) ?? []),
    ...(state.data?.supportsToolInspection
      ? [
          {
            id: "check-device-tools",
            title: translate(
              "common:mobileDevicePreview.checkToolVersions",
              "Check device tool versions",
            ),
            icon: "arrow.clockwise" as const,
            onPress: () => {
              void retryHost({ environmentId, input: { inspectOnly: true } });
            },
          },
        ]
      : []),
    {
      id: "device-tools",
      title: translate("common:mobileDevicePreview.toolVersions", "Device tool versions"),
      icon: "info.circle",
      onPress: () =>
        Alert.alert(
          translate("common:mobileDevicePreview.toolVersions", "Device tool versions"),
          translate(
            "common:mobileDevicePreview.ownership",
            "This environment's T3 server chooses device tool versions for itself and its SSH hosts. Update that server to receive newer tool versions; updating only your browser or mobile app does not update a remote server.",
          ) +
            "\n\n" +
            localizedDeviceToolUpdatePolicy(
              state.data?.hosts.find((host) => host.id === preview?.session.hostId)?.tools,
            ) +
            "\n\n" +
            localizedDeviceToolVersionLabels(
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
      title: translate("common:mobileDevicePreview.reloadStream", "Reload stream"),
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
            title: translate("common:back", "Back"),
            icon: "arrow.left",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.back(),
          },
        ]
      : []),
    {
      id: "app-switcher",
      title: translate("common:mobileDevicePreview.appSwitcher", "App switcher"),
      icon: "square.on.square",
      disabled: !inputConnected,
      onPress: () => streamRef.current?.appSwitcher(),
    },
    ...(preview?.session.platform === "ios"
      ? [
          {
            id: "rotate",
            title: translate("common:mobileDevicePreview.rotateDevice", "Rotate device"),
            icon: "arrow.clockwise" as const,
            disabled: !inputConnected,
            onPress: () => streamRef.current?.rotate(),
          },
        ]
      : []),
    {
      id: "shutdown",
      title: shuttingDown
        ? translate("common:mobileDevicePreview.shuttingDown", "Shutting down…")
        : translate("common:mobileDevicePreview.shutDown", "Shut down device"),
      icon: "power",
      disabled: !preview || shuttingDown,
      onPress: () => void shutDownDevice(),
    },
  ];
  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <ScreenHeader
        title={preview?.name ?? translate("common:mobileDevicePreview.devices", "Devices")}
        sidebar={false}
        onBack={onClose}
        options={{ headerBackVisible: false }}
        actions={[
          {
            accessibilityLabel: translate("common:mobileHome", "Home"),
            icon: "house",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.home(),
          },
        ]}
        menus={[
          {
            title: translate("common:mobileDevicePreview.options", "Device options"),
            icon: "ellipsis",
            items: [
              ...(previews.length > 1
                ? [
                    {
                      id: "devices",
                      title: translate("common:mobileDevicePreview.devices", "Devices"),
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
            accessibilityLabel={translate(
              "common:mobileCloseDevicePreview",
              "Close device preview",
            )}
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
                <AppText className="text-secondary-foreground">{t("retry")}</AppText>
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
  const { t } = useTranslation();
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
            <AppText className="text-secondary-foreground">{t("retry")}</AppText>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">{t("connectingToDevice")}</AppText>
        </>
      )}
    </View>
  );
}
