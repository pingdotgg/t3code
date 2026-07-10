import { useAuth } from "@clerk/expo";
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
  Switch,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { availableCloudEnvironmentPresentation } from "../cloud/cloudEnvironmentPresentation";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { type RelayEnvironmentView, useConnectionController } from "./useConnectionController";

/**
 * "T3 Connect" section: every environment published to the signed-in account,
 * with connect switches, availability status, refresh, and loading/error
 * states. Shared between the Settings environments screen and the T3 Connect
 * onboarding sheet.
 */
export function CloudEnvironmentRows(props: {
  readonly connectedCloudEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly onReconnectEnvironment: (environmentId: EnvironmentId) => void;
  /**
   * Hide the "T3 Connect" section title + refresh button for hosts that
   * provide their own chrome (the onboarding sheet's native header and
   * pull-to-refresh).
   */
  readonly showHeader?: boolean;
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

  const showHeader = props.showHeader ?? true;

  if (!isSignedIn) return null;

  return (
    <View collapsable={false} className={cn("gap-3", showHeader && "mt-5")}>
      {showHeader ? (
        <View className="flex-row items-center justify-between px-1">
          <Text className="text-sm font-t3-bold uppercase text-foreground-muted">T3 Connect</Text>
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
              <SymbolView
                name="arrow.clockwise"
                size={14}
                tintColor={iconColor}
                type="monochrome"
              />
            )}
          </Pressable>
        </View>
      ) : null}

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
      ) : controller.relayDiscovery.error ? null : (
        <View collapsable={false} className="rounded-[24px] bg-card p-5">
          <Text className="text-sm leading-normal text-foreground-muted">
            No additional linked cloud environments.
          </Text>
        </View>
      )}

      {/* Rendered alongside any connected rows — a failed discovery must not
          hide behind an otherwise-healthy list. */}
      {controller.relayDiscovery.error && !controller.relayDiscovery.isRefreshing ? (
        <View collapsable={false} className="gap-3 rounded-[24px] bg-card p-5">
          <Text className="text-base font-t3-bold text-foreground">
            Could not load T3 Connect environments
          </Text>
          <Text className="text-sm text-foreground-muted">{controller.relayDiscovery.error}</Text>
          {controller.relayDiscovery.errorTraceId ? (
            <CopyTraceIdButton traceId={controller.relayDiscovery.errorTraceId} />
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void controller.refreshRelayEnvironments();
            }}
            className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
          >
            <Text className="text-xs font-t3-bold text-foreground">Try again</Text>
          </Pressable>
        </View>
      ) : null}
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
            onTextLayout={onMeasuredErrorTextLayout}
            className={cn("absolute inset-x-0 -z-[1] text-xs opacity-0", statusClassName)}
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
                  className={cn("text-xs underline decoration-dotted", statusClassName)}
                  onLongPress={(event) => {
                    event.stopPropagation();
                    copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" });
                  }}
                  onPress={(event) => {
                    event.stopPropagation();
                  }}
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
