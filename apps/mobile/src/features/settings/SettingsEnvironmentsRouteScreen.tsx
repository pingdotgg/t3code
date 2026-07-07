import { useAuth } from "@clerk/expo";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "expo-symbols";
import {
  connectionStatusText,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import {
  type RelayEnvironmentView,
  useConnectionController,
} from "../connection/useConnectionController";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { availableCloudEnvironmentPresentation } from "../cloud/cloudEnvironmentPresentation";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";

export function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { localEnvironments, connectedCloudEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });
  const hasLocalEnvironments = localEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const accentColor = useThemeColor("--color-icon-muted");
  const headerIconColor = useThemeColor("--color-icon");

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          icon="plus"
          onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })}
          separateBackground
          tintColor={headerIconColor}
        />
      </NativeHeaderToolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        {hasLocalEnvironments ? (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {localEnvironments.map((environment, index) => (
              <View
                key={environment.environmentId}
                collapsable={false}
                style={{
                  borderTopWidth: index === 0 ? 0 : 1,
                }}
                className={cn(index !== 0 && "border-border")}
              >
                <ConnectionEnvironmentRow
                  environment={environment}
                  expanded={expandedId === environment.environmentId}
                  onToggle={() => handleToggle(environment.environmentId)}
                  onReconnect={onReconnectEnvironment}
                  onRemove={onRemoveEnvironmentPress}
                  onUpdate={onUpdateEnvironment}
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
                tintColor={accentColor}
                type="monochrome"
              />
            </View>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              No environments connected yet.{"\n"}Tap{" "}
              <Text className="font-t3-bold text-foreground">+</Text> to add one.
            </Text>
          </View>
        )}

        {hasCloudPublicConfig() ? (
          <ConfiguredCloudEnvironmentRows
            connectedCloudEnvironments={connectedCloudEnvironments}
            onReconnectEnvironment={onReconnectEnvironment}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function ConfiguredCloudEnvironmentRows(props: {
  readonly connectedCloudEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly onReconnectEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const { isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const controller = useConnectionController();
  const iconColor = useThemeColor("--color-icon");
  const availableCloudEnvironments = controller.availableRelayEnvironments;
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);
  const hasCloudRows =
    props.connectedCloudEnvironments.length > 0 || availableCloudEnvironments.length > 0;

  const handleConnectCloudEnvironment = useCallback(
    (entry: RelayEnvironmentView) => controller.connectRelayEnvironment(entry.environment),
    [controller],
  );

  const handleDisconnectCloudEnvironment = useCallback(
    (environmentId: EnvironmentId) => controller.removeEnvironment(environmentId),
    [controller],
  );

  const handleToggleCloudError = useCallback((environmentId: string) => {
    setExpandedErrorId((current) => (current === environmentId ? null : environmentId));
  }, []);

  if (!isSignedIn) return null;

  return (
    <View collapsable={false} className="mt-5 gap-3">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-sm font-t3-bold uppercase text-foreground-muted">T3 Cloud</Text>
        <Pressable
          accessibilityRole="button"
          disabled={controller.relayDiscovery.isRefreshing}
          onPress={() => {
            void controller.refreshRelayEnvironments();
          }}
          className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-50"
        >
          {controller.relayDiscovery.isRefreshing ? (
            <ActivityIndicator color={iconColor} size="small" />
          ) : (
            <SymbolView name="arrow.clockwise" size={14} tintColor={iconColor} type="monochrome" />
          )}
        </Pressable>
      </View>

      {hasCloudRows ? (
        <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
          {props.connectedCloudEnvironments.map((environment, index) => (
            <ConnectedCloudEnvironmentRow
              key={environment.environmentId}
              environment={environment}
              borderTop={index !== 0}
              onConnect={() => props.onReconnectEnvironment(environment.environmentId)}
              onDisconnect={() => handleDisconnectCloudEnvironment(environment.environmentId)}
              errorExpanded={expandedErrorId === environment.environmentId}
              onToggleError={() => handleToggleCloudError(environment.environmentId)}
            />
          ))}
          {availableCloudEnvironments.map((environment, index) => (
            <CloudEnvironmentRow
              key={environment.environment.environmentId}
              environment={environment}
              borderTop={props.connectedCloudEnvironments.length > 0 || index !== 0}
              onConnect={() => handleConnectCloudEnvironment(environment)}
              errorExpanded={expandedErrorId === environment.environment.environmentId}
              onToggleError={() => handleToggleCloudError(environment.environment.environmentId)}
            />
          ))}
        </View>
      ) : controller.relayDiscovery.isRefreshing ? (
        <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card p-6">
          <ActivityIndicator color={iconColor} />
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            Loading linked cloud environments.
          </Text>
        </View>
      ) : controller.relayDiscovery.error ? (
        <View collapsable={false} className="gap-3 rounded-[24px] bg-card p-5">
          <Text className="text-base font-t3-bold text-foreground">
            Could not load T3 Cloud environments
          </Text>
          <Text className="text-sm text-foreground-muted">{controller.relayDiscovery.error}</Text>
          {controller.relayDiscovery.errorTraceId ? (
            <CopyTraceIdButton traceId={controller.relayDiscovery.errorTraceId} />
          ) : null}
        </View>
      ) : (
        <View collapsable={false} className="rounded-[24px] bg-card p-5">
          <Text className="text-sm leading-normal text-foreground-muted">
            No additional linked cloud environments.
          </Text>
        </View>
      )}
    </View>
  );
}

function ConnectedCloudEnvironmentRow(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly borderTop: boolean;
  readonly errorExpanded: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onToggleError: () => void;
}) {
  return (
    <CloudEnvironmentRowShell
      borderTop={props.borderTop}
      connectionError={props.environment.connectionError}
      connectionErrorTraceId={props.environment.connectionErrorTraceId}
      connectionState={props.environment.connectionState}
      errorExpanded={props.errorExpanded}
      label={props.environment.environmentLabel}
      onValueChange={(enabled) => {
        if (enabled) {
          props.onConnect();
          return;
        }
        props.onDisconnect();
      }}
      onToggleError={props.onToggleError}
      value={props.environment.connectionState !== "available"}
    />
  );
}

function CloudEnvironmentRow(props: {
  readonly environment: RelayEnvironmentView;
  readonly borderTop: boolean;
  readonly errorExpanded: boolean;
  readonly onConnect: () => void;
  readonly onToggleError: () => void;
}) {
  const presentation = availableCloudEnvironmentPresentation({
    isStatusPending: props.environment.availability === "checking",
    status: props.environment.status,
    statusError: props.environment.error,
    statusErrorTraceId: props.environment.traceId,
  });

  return (
    <CloudEnvironmentRowShell
      borderTop={props.borderTop}
      connectionError={presentation.connectionError}
      connectionErrorTraceId={presentation.connectionErrorTraceId}
      connectionState={presentation.connectionState}
      errorExpanded={props.errorExpanded}
      label={props.environment.environment.label}
      onValueChange={(enabled) => {
        if (enabled) {
          props.onConnect();
        }
      }}
      onToggleError={props.onToggleError}
      statusText={presentation.statusText}
      value={false}
    />
  );
}

function CloudEnvironmentRowShell(props: {
  readonly borderTop: boolean;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly disabled?: boolean;
  readonly errorExpanded: boolean;
  readonly label: string;
  readonly onToggleError: () => void;
  readonly onValueChange: (enabled: boolean) => void;
  readonly statusText?: string;
  readonly value: boolean;
}) {
  const activeTrack = String(useThemeColor("--color-switch-active"));
  const track = String(useThemeColor("--color-secondary-border"));
  const chevron = useThemeColor("--color-chevron");
  const isRetrying =
    props.connectionState === "connecting" || props.connectionState === "reconnecting";
  const shouldPulse = isRetrying;
  const statusText =
    props.statusText ??
    connectionStatusText({
      phase: props.connectionState,
      error: props.connectionError,
      traceId: props.connectionErrorTraceId,
    });
  const statusClassName = props.connectionError
    ? "text-rose-500 dark:text-rose-400"
    : "text-foreground-muted";
  const [errorMeasurement, setErrorMeasurement] = useState<{
    readonly text: string;
    readonly lineCount: number;
  } | null>(null);
  const errorTraceId = props.connectionErrorTraceId;
  const measuredErrorText = errorTraceId ? `${statusText} Trace ID: ${errorTraceId}` : statusText;
  const errorLineCount =
    errorMeasurement?.text === measuredErrorText ? errorMeasurement.lineCount : 0;
  const errorCanExpand = props.connectionError !== null && errorLineCount > 1;
  const isErrorExpanded = errorCanExpand && props.errorExpanded;
  const StatusContainer = errorCanExpand ? Pressable : View;
  const onMeasuredErrorTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      if (!props.connectionError) {
        return;
      }
      const nextLineCount = event.nativeEvent.lines.length;
      setErrorMeasurement((currentMeasurement) =>
        currentMeasurement?.text === measuredErrorText &&
        currentMeasurement.lineCount === nextLineCount
          ? currentMeasurement
          : { text: measuredErrorText, lineCount: nextLineCount },
      );
    },
    [measuredErrorText, props.connectionError],
  );
  return (
    <View
      collapsable={false}
      className={cn(
        "flex-row items-center gap-3 bg-card px-4 py-3.5",
        props.borderTop && "border-t border-border",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="min-w-0 flex-row items-center gap-2">
          <ConnectionStatusDot state={props.connectionState} pulse={shouldPulse} size={7} />
          <Text
            className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground"
            numberOfLines={1}
          >
            {props.label}
          </Text>
        </View>
        {props.connectionError ? (
          <Text
            aria-hidden
            className={cn("absolute left-0 right-0 text-xs", statusClassName)}
            onTextLayout={onMeasuredErrorTextLayout}
            style={{ opacity: 0, zIndex: -1 }}
          >
            {measuredErrorText}
          </Text>
        ) : null}
        <StatusContainer
          {...(errorCanExpand
            ? { accessibilityRole: "button" as const, onPress: props.onToggleError }
            : {})}
          className="min-w-0 flex-row items-start gap-1"
        >
          <Text
            className={cn("min-w-0 flex-1 text-xs", statusClassName)}
            numberOfLines={isErrorExpanded ? undefined : 1}
          >
            {statusText}
            {errorTraceId ? (
              <>
                {" Trace ID: "}
                <Text
                  accessibilityHint="Copies the trace ID"
                  accessibilityRole="button"
                  className={cn("text-xs underline", statusClassName)}
                  onLongPress={(event) => {
                    event.stopPropagation();
                    copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" });
                  }}
                  onPress={(event) => {
                    event.stopPropagation();
                  }}
                  style={{ textDecorationStyle: "dotted" }}
                >
                  {errorTraceId}
                </Text>
              </>
            ) : null}
          </Text>
          {errorCanExpand ? (
            <SymbolView
              name="chevron.down"
              size={10}
              tintColor={chevron}
              type="monochrome"
              style={{
                marginTop: 3,
                transform: [{ rotate: isErrorExpanded ? "180deg" : "0deg" }],
              }}
            />
          ) : null}
        </StatusContainer>
      </View>
      <Switch
        disabled={props.disabled}
        ios_backgroundColor={track}
        onValueChange={props.onValueChange}
        trackColor={{ false: track, true: activeTrack }}
        value={props.value}
      />
    </View>
  );
}

function CopyTraceIdButton(props: { readonly traceId: string }) {
  const iconColor = useThemeColor("--color-icon");

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        copyTextWithHaptic(props.traceId, { target: "connection-trace-id" });
      }}
      className="self-start flex-row items-center gap-1.5 rounded-full bg-subtle px-3 py-2 active:opacity-70"
    >
      <SymbolView name="doc.on.doc" size={12} tintColor={iconColor} type="monochrome" />
      <Text className="text-xs font-t3-bold text-foreground">Copy trace ID</Text>
    </Pressable>
  );
}
