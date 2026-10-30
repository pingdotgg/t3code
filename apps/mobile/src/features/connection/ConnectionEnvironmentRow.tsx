import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { T, useGT, useMessages } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { ConnectionTraceId } from "./ConnectionTraceId";
import { SymbolView } from "../../components/ui/AppSymbol";
import { hasSavedBearerRoute, hostFreezeNotice } from "@t3tools/client-runtime/connection";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { m as resolveMessage } from "../../i18n/messages";

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
import {
  PAUSED_SWITCH_OPACITY,
  environmentStatusText,
  offStatusText,
} from "./environmentStatusText";
import type { MessageResolver } from "../../i18n/messages";

function connectionStatusLabel(
  environment: ConnectedEnvironmentSummary,
  resolve: MessageResolver,
): string | null {
  if (!environment.isEnabled && environment.connectionState !== "unsupported") {
    return offStatusText(environment, resolve);
  }
  return environmentStatusText(
    {
      phase: environment.connectionState,
      error: environment.connectionError,
      ...(environment.i18nConnectionError === undefined
        ? {}
        : { i18nError: environment.i18nConnectionError }),
      traceId: environment.connectionErrorTraceId,
    },
    resolve,
  );
}

export function ConnectionEnvironmentRow(props: {
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
}) {
  const gt = useGT();
  const m = useMessages();
  const [label, setLabel] = useState(props.environment.environmentLabel);
  const [url, setUrl] = useState(props.environment.displayUrl);
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
  const switchedOn = (enabled || props.environment.isPausedByFocus) && !unsupported;
  const statusLabel = connectionStatusLabel(props.environment, m);
  const statusTraceId = enabled ? props.environment.connectionErrorTraceId : null;
  const hasConnectionFailure = enabled && props.environment.connectionError !== null;
  const freeze = enabled
    ? hostFreezeNotice(props.environment.environmentLabel, serverConfig?.lastEventLoopStall, m)
    : null;
  const isRetrying =
    enabled &&
    (props.environment.connectionState === "connecting" ||
      props.environment.connectionState === "reconnecting");
  const handleSave = async () => {
    const result = await props.onUpdate(props.environment.environmentId, {
      label: label.trim(),
      displayUrl: url.trim(),
    });
    if (AsyncResult.isSuccess(result)) {
      props.onToggle();
      return;
    }
    const error = Cause.squash(result.cause);
    Dialog.alert(
      gt("Could not update environment"),
      error instanceof Error
        ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
        : gt("The environment could not be updated."),
    );
  };

  const toggleLabel = props.opensDetails
    ? gt("Manage {environment}", { environment: props.environment.environmentLabel })
    : props.expanded
      ? gt("Collapse details for {environment}", {
          environment: props.environment.environmentLabel,
        })
      : gt("Expand details for {environment}", {
          environment: props.environment.environmentLabel,
        });

  return (
    <Animated.View layout={LinearTransition.duration(250)} className="bg-grouped-card">
      <View className="flex-row items-center gap-3 px-4 py-3.5">
        <Pressable
          className="min-w-0 flex-1 gap-0.5 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
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
          {!props.environment.isRelayManaged && props.environment.displayUrl.trim() ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {props.environment.displayUrl}
            </Text>
          ) : null}
          {diagnosis ? (
            <>
              <Text className="text-xs text-danger-foreground">{diagnosis.headline}</Text>
              {connectionState.attempt > 0 ? (
                <Text className="text-xs text-foreground-muted">
                  {gt("Retrying · attempt {attempt}", { attempt: connectionState.attempt })}
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
          accessibilityLabel={gt("Enable {environment}", {
            environment: props.environment.environmentLabel,
          })}
          style={{
            alignSelf: "center",
            opacity: props.environment.isPausedByFocus ? PAUSED_SWITCH_OPACITY : 1,
          }}
          disabled={unsupported && !canRetry}
          onValueChange={(next) => props.onSetEnabled(props.environment.environmentId, next)}
          value={switchedOn}
        />
        <Pressable
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
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
          {props.environment.isRelayManaged ? (
            <Text className="text-sm text-foreground-muted">
              {gt("Managed by {product}. Tunnel details update automatically.", {
                product: "T3 Connect",
              })}
            </Text>
          ) : (
            <>
              <ConnectionFormField
                label={gt("Label", { $context: "noun, environment name field" })}
                autoCapitalize="words"
                autoCorrect={false}
                placeholder={gt("My MacBook")}
                value={label}
                onChangeText={setLabel}
              />

              <ConnectionFormField
                label="URL"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="192.168.1.100:8080"
                value={url}
                onChangeText={setUrl}
              />
            </>
          )}

          {Platform.OS === "android" ? (
            <View className="flex-row items-center justify-end gap-2">
              {props.environment.isRelayManaged ? null : (
                <View className="flex-1">
                  <Button
                    label={gt("Save")}
                    tone="primary"
                    fullWidth
                    onPress={() => {
                      void handleSave();
                    }}
                  />
                </View>
              )}
              <IconButton
                accessibilityLabel={gt("Reconnect environment")}
                icon="arrow.clockwise"
                variant="tonal"
                disabled={!enabled}
                onPress={() => props.onReconnect(props.environment.environmentId)}
              />
              <IconButton
                accessibilityLabel={gt("Remove environment")}
                icon="trash"
                variant="danger"
                onPress={() => props.onRemove(props.environment.environmentId)}
              />
            </View>
          ) : (
            <View className="flex-row justify-end gap-2">
              {props.environment.isRelayManaged ? null : (
                <Pressable
                  className="min-h-[42px] flex-1 flex-row items-center justify-center gap-1.5 rounded-[14px] bg-primary px-3.5 py-2.5 active:opacity-70"
                  onPress={handleSave}
                >
                  <SymbolView
                    name="checkmark"
                    size={13}
                    tintColorClassName="accent-primary-foreground"
                    type="monochrome"
                  />
                  <Text className="text-xs font-t3-bold tracking-[0.8px] uppercase text-primary-foreground">
                    <T>Save</T>
                  </Text>
                </Pressable>
              )}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Reconnect environment")}
                accessibilityState={{ disabled: !enabled }}
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
                accessibilityRole="button"
                accessibilityLabel={gt("Remove environment")}
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
      ) : null}
    </Animated.View>
  );
}
