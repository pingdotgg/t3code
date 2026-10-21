import * as Dialog from "../../components/ui/Dialog";
import { ConnectionTraceId } from "./ConnectionTraceId";
import { SymbolView } from "../../components/ui/AppSymbol";
import { hasSavedBearerRoute, hostFreezeNotice } from "@t3tools/client-runtime/connection";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ServerConfig,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { serverEnvironment } from "../../state/server";
import { environmentPresentations } from "../../state/presentation";
import { ConnectionDiagnosisDetails, useConnectionDiagnosis } from "./ConnectionDiagnosisDetails";
import { ConnectionFormField } from "./ConnectionFormField";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { environmentStatusText } from "./environmentStatusText";
import { environmentCatalog } from "../../connection/catalog";

function connectionStatusLabel(environment: ConnectedEnvironmentSummary): string | null {
  if (!environment.isEnabled && environment.connectionState !== "unsupported") {
    return "Off";
  }
  return environmentStatusText({
    phase: environment.connectionState,
    error: environment.connectionError,
    traceId: environment.connectionErrorTraceId,
  });
}

interface ConnectionEnvironmentRowProps {
  readonly environment: ConnectedEnvironmentSummary;
  readonly expanded: boolean;
  readonly opensDetails?: boolean;
  readonly onToggle: () => void;
  readonly onReconnect: (environmentId: EnvironmentId) => void;
  readonly onRemove: (environmentId: EnvironmentId) => void;
  readonly onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  readonly onUpdate: (
    environmentId: EnvironmentId,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}

export function ConnectionEnvironmentRow(props: ConnectionEnvironmentRowProps) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const isHostName =
    catalog.entries.get(props.environment.environmentId)?.target._tag === "RelayConnectionTarget";
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(props.environment.environmentId),
  );
  const unsupported = props.environment.connectionState === "unsupported";
  const presentation = useAtomValue(
    environmentPresentations.presentationAtom(props.environment.environmentId),
  );
  const canRetry = presentation !== null && hasSavedBearerRoute(presentation.entry);
  const { diagnosis, state: connectionState } = useConnectionDiagnosis(
    props.environment.environmentId,
    presentation,
  );
  const enabled = props.environment.isEnabled && !unsupported;
  const statusLabel = connectionStatusLabel(props.environment);
  const statusTraceId = enabled ? props.environment.connectionErrorTraceId : null;
  const hasConnectionFailure = enabled && props.environment.connectionError !== null;
  const freeze = enabled
    ? hostFreezeNotice(props.environment.environmentLabel, serverConfig?.lastEventLoopStall)
    : null;
  const isRetrying =
    enabled &&
    (props.environment.connectionState === "connecting" ||
      props.environment.connectionState === "reconnecting");

  return (
    <Animated.View layout={LinearTransition.duration(250)} className="bg-grouped-card">
      <View className="flex-row items-center gap-3 px-4 py-3.5">
        <Pressable
          className="min-w-0 flex-1 gap-0.5 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={
            props.opensDetails
              ? `Manage ${props.environment.environmentLabel}`
              : `${props.expanded ? "Collapse" : "Expand"} details for ${props.environment.environmentLabel}`
          }
          onPress={props.onToggle}
        >
          <View className="flex-row items-center gap-1.5">
            <ConnectionStatusDot
              state={enabled || unsupported ? props.environment.connectionState : "available"}
              pulse={isRetrying}
              size={8}
            />
            <EnvironmentMachineSymbol
              kind={resolveEnvironmentMachineKind(serverConfig)}
              size={14}
              tintColorClassName="accent-foreground-muted"
            />
            <Text
              className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground"
              numberOfLines={1}
            >
              {props.environment.environmentLabel}
            </Text>
          </View>
          {!isHostName && props.environment.displayUrl.trim() ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {props.environment.displayUrl}
            </Text>
          ) : null}
          {diagnosis ? (
            <>
              <Text className="text-xs text-danger-foreground">{diagnosis.headline}</Text>
              {connectionState.attempt > 0 ? (
                <Text className="text-xs text-foreground-muted">
                  {`Retrying · attempt ${connectionState.attempt}`}
                </Text>
              ) : null}
            </>
          ) : statusLabel ? (
            <Text
              className={cn(
                "text-xs",
                hasConnectionFailure ? "text-danger-foreground" : "text-foreground-muted",
              )}
              numberOfLines={props.expanded ? undefined : 1}
              selectable={props.expanded}
            >
              {statusLabel}
              {statusTraceId ? (
                <ConnectionTraceId
                  traceId={statusTraceId}
                  tone={hasConnectionFailure ? "danger" : "muted"}
                  activation="longPress"
                />
              ) : null}
            </Text>
          ) : null}
          {freeze ? (
            <Text
              className="text-xs text-warning-foreground"
              numberOfLines={props.expanded ? undefined : 1}
            >
              {`${freeze.title}. ${freeze.description}`}
            </Text>
          ) : null}
        </Pressable>

        <ThemedSwitch
          accessibilityLabel={`Enable ${props.environment.environmentLabel}`}
          style={{ alignSelf: "center" }}
          disabled={unsupported && !canRetry}
          onValueChange={(next) => props.onSetEnabled(props.environment.environmentId, next)}
          value={enabled}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            props.opensDetails
              ? `Manage ${props.environment.environmentLabel}`
              : `${props.expanded ? "Collapse" : "Expand"} details for ${props.environment.environmentLabel}`
          }
          onPress={props.onToggle}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SymbolView
            name={props.opensDetails ? "chevron.right" : "chevron.down"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
            style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
          />
        </Pressable>
      </View>

      {props.expanded ? (
        <ConnectionEnvironmentEditor
          key={isHostName ? "host" : "local"}
          {...props}
          isHostName={isHostName}
          enabled={enabled}
          serverConfig={serverConfig}
          diagnosis={diagnosis}
        />
      ) : null}
    </Animated.View>
  );
}

/** Mounted only while expanded, so each opening starts from the latest saved values. */
function ConnectionEnvironmentEditor(
  props: ConnectionEnvironmentRowProps & {
    readonly isHostName: boolean;
    readonly enabled: boolean;
    readonly serverConfig: ServerConfig | null;
    readonly diagnosis: ReturnType<typeof useConnectionDiagnosis>["diagnosis"];
  },
) {
  const { isHostName, enabled, serverConfig, diagnosis } = props;
  const [draft, setDraft] = useState<{ readonly label?: string; readonly url?: string }>({});
  const [saving, setSaving] = useState(false);
  const label =
    draft.label ??
    (isHostName
      ? (serverConfig?.settings.environmentLabel ?? "")
      : props.environment.environmentLabel);
  const url = draft.url ?? props.environment.displayUrl;
  const canUpdateSettings = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environment.environmentId, {
      patch: { environmentLabel: label.trim() },
    }),
  );
  const canEditHost =
    props.environment.connectionState === "connected" &&
    serverConfig?.environment.capabilities.environmentLabel === true &&
    canUpdateSettings;
  const canSave = !saving && (!isHostName || canEditHost);
  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    const result = await props
      .onUpdate(props.environment.environmentId, {
        label: label.trim(),
        displayUrl: url.trim(),
      })
      .finally(() => setSaving(false));
    if (AsyncResult.isSuccess(result)) {
      props.onToggle();
      return;
    }
    const error = Cause.squash(result.cause);
    Dialog.alert(
      "Could not update environment",
      error instanceof Error ? error.message : "The environment could not be updated.",
    );
  }

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      className="gap-3 px-4 pb-4"
    >
      {diagnosis ? (
        <ConnectionDiagnosisDetails
          hostLabel={props.environment.environmentLabel}
          diagnosis={diagnosis}
        />
      ) : null}
      <ConnectionFormField
        label={isHostName ? "Host name" : "Label"}
        autoCapitalize="words"
        autoCorrect={false}
        placeholder="My MacBook"
        value={label}
        editable={!saving && (!isHostName || canEditHost)}
        onChangeText={(value) => {
          setDraft((previous) => ({ ...previous, label: value }));
        }}
      />

      {isHostName ? (
        <Text className="text-sm text-foreground-muted">
          {props.environment.connectionState !== "connected"
            ? "Connect to this environment to change its host name."
            : serverConfig?.environment.capabilities.environmentLabel !== true
              ? "Update the host server to change its name."
              : !canUpdateSettings
                ? "You need permission to update this environment’s settings."
                : "Shared with all connected clients. Leave empty to use the machine name."}
        </Text>
      ) : (
        <ConnectionFormField
          label="URL"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="192.168.1.100:8080"
          value={url}
          editable={!saving}
          onChangeText={(value) => {
            setDraft((previous) => ({ ...previous, url: value }));
          }}
        />
      )}

      {Platform.OS === "android" ? (
        <View className="flex-row items-center justify-end gap-2">
          <View className="flex-1">
            <Button
              label="Save"
              tone="primary"
              fullWidth
              disabled={!canSave}
              onPress={() => {
                void handleSave();
              }}
            />
          </View>
          <IconButton
            accessibilityLabel="Reconnect environment"
            icon="arrow.clockwise"
            variant="tonal"
            disabled={!enabled}
            onPress={() => props.onReconnect(props.environment.environmentId)}
          />
          <IconButton
            accessibilityLabel="Remove environment"
            icon="trash"
            variant="danger"
            onPress={() => props.onRemove(props.environment.environmentId)}
          />
        </View>
      ) : (
        <View className="flex-row justify-end gap-2">
          <Pressable
            className="min-h-[42px] flex-1 flex-row items-center justify-center gap-1.5 rounded-[14px] bg-primary px-3.5 py-2.5 active:opacity-70 disabled:opacity-40"
            disabled={!canSave}
            onPress={handleSave}
          >
            <SymbolView
              name="checkmark"
              size={13}
              tintColorClassName="accent-primary-foreground"
              type="monochrome"
            />
            <Text className="text-xs font-t3-bold tracking-[0.8px] uppercase text-primary-foreground">
              Save
            </Text>
          </Pressable>

          <Pressable
            className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-input-border bg-input active:opacity-70 disabled:opacity-40"
            disabled={!enabled}
            onPress={() => props.onReconnect(props.environment.environmentId)}
          >
            <SymbolView
              name="arrow.clockwise"
              size={14}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          </Pressable>

          <Pressable
            className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-danger-border bg-danger active:opacity-70"
            onPress={() => props.onRemove(props.environment.environmentId)}
          >
            <SymbolView
              name="trash"
              size={14}
              tintColorClassName="accent-danger-foreground"
              type="monochrome"
            />
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}
