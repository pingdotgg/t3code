import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ConnectionTraceId } from "./ConnectionTraceId";
import { useAuth } from "@clerk/expo";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  hasSavedBearerRoute,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ExecutionEnvironmentDescriptor,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useState } from "react";
import { Pressable, type TextLayoutEvent, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { serverEnvironment } from "../../state/server";
import { environmentPresentations } from "../../state/presentation";
import { availableCloudEnvironmentPresentation } from "../cloud/cloudEnvironmentPresentation";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { useConnectionDiagnosis } from "./ConnectionDiagnosisDetails";
import { environmentStatusText } from "./environmentStatusText";
import { type RelayEnvironmentView, useConnectionController } from "./useConnectionController";

interface CloudEnvironmentRowsProps {
  readonly connectedCloudEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly onOpenEnvironment?: (environmentId: EnvironmentId) => void;
  readonly onSetEnvironmentEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  readonly onRemoveEnvironment: (environmentId: EnvironmentId) => void;
  readonly showcaseAvailableEnvironments?: ReadonlyArray<RelayEnvironmentView>;
  readonly showcaseSignedIn?: boolean;
  readonly showHeader?: boolean;
}

export function CloudEnvironmentRows(props: CloudEnvironmentRowsProps) {
  // Showcase captures run without a Clerk publishable key, so `ClerkProvider`
  // is never mounted and any `useAuth` call throws — the fixture states whether
  // the rows are signed in instead of asking Clerk.
  if (props.showcaseSignedIn !== undefined) {
    return props.showcaseSignedIn ? <CloudEnvironmentRowsContent {...props} /> : null;
  }
  // No cloud config means no `ClerkProvider` either, so `useAuth` would throw.
  if (!hasCloudPublicConfig()) {
    return <ConnectedOnlyCloudEnvironmentRows {...props} />;
  }
  return <SignedInCloudEnvironmentRows {...props} />;
}

function SignedInCloudEnvironmentRows(props: CloudEnvironmentRowsProps) {
  const { isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  if (!isSignedIn) return <ConnectedOnlyCloudEnvironmentRows {...props} />;
  return <CloudEnvironmentRowsContent {...props} />;
}

function ConnectedOnlyCloudEnvironmentRows(props: CloudEnvironmentRowsProps) {
  if (props.connectedCloudEnvironments.length === 0) return null;
  return <CloudEnvironmentRowsContent {...props} discoveryAvailable={false} />;
}

function CloudEnvironmentRowsContent(
  props: CloudEnvironmentRowsProps & { readonly discoveryAvailable?: boolean },
) {
  const controller = useConnectionController();
  const discoveryAvailable = props.discoveryAvailable ?? true;
  const availableCloudEnvironments = discoveryAvailable
    ? (props.showcaseAvailableEnvironments ?? controller.availableRelayEnvironments)
    : [];
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);
  const hasCloudRows =
    props.connectedCloudEnvironments.length > 0 || availableCloudEnvironments.length > 0;

  const handleConnectCloudEnvironment = useCallback(
    (entry: RelayEnvironmentView) => controller.connectRelayEnvironment(entry.environment),
    [controller],
  );

  const discoveredDescriptors = new Map(
    controller.relayEnvironments.flatMap((entry) =>
      entry.status?.descriptor === undefined
        ? []
        : [[entry.environment.environmentId, entry.status.descriptor] as const],
    ),
  );

  const handleToggleCloudError = useCallback((environmentId: string) => {
    setExpandedErrorId((current) => (current === environmentId ? null : environmentId));
  }, []);

  const showHeader = props.showHeader ?? true;

  return (
    <View collapsable={false} className={cn("gap-3", showHeader && "mt-5")}>
      {showHeader ? (
        <View className="px-1">
          <Text className="text-sm font-t3-bold uppercase text-foreground-muted">T3 Connect</Text>
        </View>
      ) : null}

      {hasCloudRows ? (
        <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
          {props.connectedCloudEnvironments.map((environment) => (
            <ConnectedCloudEnvironmentRow
              key={environment.environmentId}
              environment={environment}
              descriptor={discoveredDescriptors.get(environment.environmentId)}
              onSetEnabled={(enabled) =>
                props.onSetEnvironmentEnabled(environment.environmentId, enabled)
              }
              onRemove={() => props.onRemoveEnvironment(environment.environmentId)}
              onOpen={
                props.onOpenEnvironment
                  ? () => props.onOpenEnvironment?.(environment.environmentId)
                  : undefined
              }
              errorExpanded={expandedErrorId === environment.environmentId}
              onToggleError={() => handleToggleCloudError(environment.environmentId)}
            />
          ))}
          {availableCloudEnvironments.map((environment) => (
            <CloudEnvironmentRow
              key={environment.environment.environmentId}
              environment={environment}
              showChevron={props.onOpenEnvironment !== undefined}
              onConnect={() => handleConnectCloudEnvironment(environment)}
              errorExpanded={expandedErrorId === environment.environment.environmentId}
              onToggleError={() => handleToggleCloudError(environment.environment.environmentId)}
            />
          ))}
        </View>
      ) : controller.relayDiscovery.isRefreshing ? (
        <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-grouped-card p-6">
          <AppActivityIndicator colorClassName={"accent-icon"} />
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            Loading linked cloud environments.
          </Text>
        </View>
      ) : controller.relayDiscovery.error ? null : (
        <View collapsable={false} className="rounded-[24px] bg-grouped-card p-5">
          <Text className="text-sm leading-normal text-foreground-muted">
            No additional linked cloud environments.
          </Text>
        </View>
      )}

      {discoveryAvailable &&
      controller.relayDiscovery.error &&
      !controller.relayDiscovery.isRefreshing ? (
        <View collapsable={false} className="gap-3 rounded-[24px] bg-grouped-card p-5">
          <Text className="text-base font-t3-bold text-foreground">
            Could not load T3 Connect environments
          </Text>
          <Text className="text-sm text-foreground-muted">{controller.relayDiscovery.error}</Text>
          {controller.relayDiscovery.errorTraceId ? (
            <CopyTraceIdButton traceId={controller.relayDiscovery.errorTraceId} />
          ) : null}
          <Button
            label="Try again"
            tone="secondary"
            onPress={() => {
              void controller.refreshRelayEnvironments();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function ConnectedCloudEnvironmentRow(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly descriptor: ExecutionEnvironmentDescriptor | undefined;
  readonly errorExpanded: boolean;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onOpen?: (() => void) | undefined;
  readonly onToggleError: () => void;
}) {
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(props.environment.environmentId),
  );
  const unsupported = props.environment.connectionState === "unsupported";
  const presentation = useAtomValue(
    environmentPresentations.presentationAtom(props.environment.environmentId),
  );
  const canRetry = presentation !== null && hasSavedBearerRoute(presentation.entry);
  const enabled = props.environment.isEnabled && !unsupported;
  const { diagnosis } = useConnectionDiagnosis(props.environment.environmentId, presentation);
  const [lastDescriptor, setLastDescriptor] = useState(props.descriptor);
  if (props.descriptor !== undefined && props.descriptor !== lastDescriptor) {
    setLastDescriptor(props.descriptor);
  }
  return (
    <CloudEnvironmentRowShell
      opensDetails={props.onOpen !== undefined}
      onOpen={props.onOpen}
      onRemove={props.onRemove}
      connectionError={enabled || unsupported ? props.environment.connectionError : null}
      connectionErrorTraceId={enabled ? props.environment.connectionErrorTraceId : null}
      connectionState={enabled || unsupported ? props.environment.connectionState : "available"}
      errorExpanded={props.errorExpanded}
      label={props.environment.environmentLabel}
      machine={resolveEnvironmentMachineKind(
        serverConfig ?? (lastDescriptor === undefined ? null : { environment: lastDescriptor }),
      )}
      onValueChange={props.onSetEnabled}
      onToggleError={props.onToggleError}
      disabled={unsupported && !canRetry}
      {...(enabled || unsupported
        ? diagnosis
          ? { statusText: diagnosis.headline }
          : {}
        : { statusText: "Off" })}
      value={enabled}
    />
  );
}

function CloudEnvironmentRow(props: {
  readonly environment: RelayEnvironmentView;
  readonly showChevron: boolean;
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
      showChevron={props.showChevron}
      connectionError={presentation.connectionError}
      connectionErrorTraceId={presentation.connectionErrorTraceId}
      connectionState={presentation.connectionState}
      errorExpanded={props.errorExpanded}
      label={props.environment.environment.label}
      machine={resolveEnvironmentMachineKind(
        props.environment.status?.descriptor === undefined
          ? null
          : { environment: props.environment.status.descriptor },
      )}
      onValueChange={(enabled) => {
        if (enabled) {
          props.onConnect();
        }
      }}
      onToggleError={props.onToggleError}
      disabled={presentation.connectionState === "unsupported"}
      statusText={presentation.statusText}
      value={false}
    />
  );
}

function CloudEnvironmentRowShell(props: {
  readonly showChevron?: boolean;
  readonly opensDetails?: boolean;
  readonly onOpen?: (() => void) | undefined;
  readonly onRemove?: (() => void) | undefined;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly disabled?: boolean;
  readonly errorExpanded: boolean;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly onToggleError: () => void;
  readonly onValueChange: (enabled: boolean) => void;
  readonly statusText?: string;
  readonly value: boolean;
}) {
  const isRetrying =
    props.connectionState === "connecting" || props.connectionState === "reconnecting";
  const shouldPulse = isRetrying;
  const statusText =
    props.statusText ??
    environmentStatusText({
      phase: props.connectionState,
      error: props.connectionError,
      traceId: props.connectionErrorTraceId,
    });
  const statusClassName =
    props.connectionError && props.connectionState !== "unsupported"
      ? "text-danger-foreground"
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
  const ContentContainer = props.onOpen || props.onRemove ? Pressable : View;
  const ChevronContainer = props.onOpen || props.onRemove ? Pressable : View;
  const onMeasuredErrorTextLayout = useCallback(
    (event: TextLayoutEvent) => {
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
    <View collapsable={false} className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5">
      <ContentContainer
        className="min-w-0 flex-1 gap-0.5"
        accessibilityHint={props.onRemove ? "Long press to remove from this device" : undefined}
        accessibilityRole={props.onOpen ? "button" : undefined}
        accessibilityLabel={
          props.onOpen
            ? `Manage ${props.label}`
            : props.onRemove
              ? `Remove ${props.label} from this device`
              : undefined
        }
        onPress={props.onOpen}
        onLongPress={props.onRemove}
      >
        <View className="min-w-0 flex-row items-center gap-2">
          <ConnectionStatusDot state={props.connectionState} pulse={shouldPulse} size={7} />
          <EnvironmentMachineSymbol
            kind={props.machine}
            size={14}
            tintColorClassName="accent-foreground-muted"
          />
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
              <ConnectionTraceId
                traceId={errorTraceId}
                tone={
                  props.connectionError && props.connectionState !== "unsupported"
                    ? "danger"
                    : "muted"
                }
                activation="longPress"
              />
            ) : null}
          </Text>
          {errorCanExpand ? (
            <SymbolView
              name="chevron.down"
              size={10}
              tintColorClassName={"accent-chevron"}
              type="monochrome"
              style={{
                marginTop: 3,
                transform: [{ rotate: isErrorExpanded ? "180deg" : "0deg" }],
              }}
            />
          ) : null}
        </StatusContainer>
      </ContentContainer>
      <ThemedSwitch
        accessibilityLabel={`Enable ${props.label}`}
        style={{ alignSelf: "center" }}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
        value={props.value}
      />
      {props.opensDetails || props.showChevron ? (
        <ChevronContainer
          accessibilityRole={props.onOpen ? "button" : undefined}
          accessibilityLabel={
            props.onOpen
              ? `Manage ${props.label}`
              : props.onRemove
                ? `Remove ${props.label} from this device`
                : undefined
          }
          accessibilityHint={props.onRemove ? "Long press to remove from this device" : undefined}
          onPress={props.onOpen}
          onLongPress={props.onRemove}
          style={{
            opacity: props.opensDetails ? 1 : 0.4,
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
        </ChevronContainer>
      ) : null}
    </View>
  );
}

function CopyTraceIdButton(props: { readonly traceId: string }) {
  return (
    <Button
      label="Copy trace ID"
      tone="secondary"
      onPress={() => {
        copyTextWithHaptic(props.traceId, { target: "connection-trace-id" });
      }}
      icon="doc.on.doc"
    />
  );
}
