import { ConnectionTraceId } from "./ConnectionTraceId";
import { SymbolView } from "../../components/AppSymbol";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
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
import { Platform, Alert, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { serverEnvironment } from "../../state/server";
import { ConnectionFormField } from "./ConnectionFormField";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { environmentCatalog } from "../../connection/catalog";

function connectionStatusLabel(environment: ConnectedEnvironmentSummary): string | null {
  if (!environment.isEnabled && environment.connectionState !== "unsupported") {
    return "Off";
  }
  return connectionStatusText({
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
  const enabled = props.environment.isEnabled && !unsupported;
  const statusLabel = connectionStatusLabel(props.environment);
  const statusTraceId = enabled ? props.environment.connectionErrorTraceId : null;
  // Unsupported is a compatibility note, not a failure, so it stays muted.
  const hasConnectionFailure = enabled && props.environment.connectionError !== null;
  const isRetrying =
    enabled &&
    (props.environment.connectionState === "connecting" ||
      props.environment.connectionState === "reconnecting");

  return (
    <Animated.View layout={LinearTransition.duration(250)} className="bg-grouped-card">
      <Pressable
        className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={
          props.opensDetails ? `Manage ${props.environment.environmentLabel}` : undefined
        }
        onPress={props.onToggle}
      >
        <View className="flex-1 gap-0.5">
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
          {statusLabel ? (
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
        </View>

        <ThemedSwitch
          style={{ alignSelf: "center" }}
          disabled={unsupported}
          onValueChange={(next) => props.onSetEnabled(props.environment.environmentId, next)}
          value={enabled}
        />
        <SymbolView
          name={props.opensDetails ? "chevron.right" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
          style={{
            transform: [{ rotate: props.expanded ? "180deg" : "0deg" }],
          }}
        />
      </Pressable>

      {props.expanded ? (
        <ConnectionEnvironmentEditor
          key={isHostName ? "host" : "local"}
          {...props}
          isHostName={isHostName}
          enabled={enabled}
          serverConfig={serverConfig}
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
  },
) {
  const { isHostName, enabled, serverConfig } = props;
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
    try {
      const result = await props.onUpdate(props.environment.environmentId, {
        label: label.trim(),
        displayUrl: url.trim(),
      });
      if (AsyncResult.isSuccess(result)) {
        props.onToggle();
        return;
      }
      const error = Cause.squash(result.cause);
      Alert.alert(
        "Could not update environment",
        error instanceof Error ? error.message : "The environment could not be updated.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      className="gap-3 px-4 pb-4"
    >
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
            <MaterialButton
              label="Save"
              tone="primary"
              fullWidth
              disabled={!canSave}
              onPress={() => {
                void handleSave();
              }}
            />
          </View>
          <MaterialIconButton
            accessibilityLabel="Reconnect environment"
            icon="arrow.clockwise"
            variant="tonal"
            disabled={!enabled}
            onPress={() => props.onReconnect(props.environment.environmentId)}
          />
          <MaterialIconButton
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
