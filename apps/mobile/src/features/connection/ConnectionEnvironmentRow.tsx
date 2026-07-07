import { SymbolView } from "expo-symbols";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

function connectionStatusLabel(environment: ConnectedEnvironmentSummary): string | null {
  return connectionStatusText({
    phase: environment.connectionState,
    error: environment.connectionError,
    traceId: environment.connectionErrorTraceId,
  });
}

export function ConnectionEnvironmentRow(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onReconnect: (environmentId: EnvironmentId) => void;
  readonly onRemove: (environmentId: EnvironmentId) => void;
  readonly onUpdate: (
    environmentId: EnvironmentId,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}) {
  const [label, setLabel] = useState(props.environment.environmentLabel);
  const [url, setUrl] = useState(props.environment.displayUrl);

  const mutedColor = useThemeColor("--color-icon-subtle");
  const placeholderColor = useThemeColor("--color-placeholder");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const statusLabel = connectionStatusLabel(props.environment);
  const statusTraceId = props.environment.connectionErrorTraceId;
  const hasConnectionFailure = props.environment.connectionError !== null;
  const isRetrying =
    props.environment.connectionState === "connecting" ||
    props.environment.connectionState === "reconnecting";
  const handleSave = useCallback(async () => {
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
  }, [label, url, props]);

  return (
    <Animated.View layout={LinearTransition.duration(250)} className="bg-card">
      <Pressable
        className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-70"
        onPress={props.onToggle}
      >
        <ConnectionStatusDot
          state={props.environment.connectionState}
          pulse={isRetrying}
          size={8}
        />

        <View className="flex-1 gap-0.5">
          <Text className="text-base font-t3-bold leading-snug text-foreground" numberOfLines={1}>
            {props.environment.environmentLabel}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.environment.displayUrl}
          </Text>
          {statusLabel ? (
            <Text
              className={cn(
                "text-xs",
                hasConnectionFailure ? "text-rose-500 dark:text-rose-400" : "text-foreground-muted",
              )}
              numberOfLines={props.expanded ? undefined : 1}
              selectable={props.expanded}
            >
              {statusLabel}
              {statusTraceId ? (
                <>
                  {" Trace ID: "}
                  <Text
                    accessibilityHint="Copies the trace ID"
                    accessibilityRole="button"
                    className="underline"
                    onLongPress={(event) => {
                      event.stopPropagation();
                      copyTextWithHaptic(statusTraceId, { target: "connection-trace-id" });
                    }}
                    onPress={(event) => {
                      event.stopPropagation();
                    }}
                    style={{ textDecorationStyle: "dotted" }}
                  >
                    {statusTraceId}
                  </Text>
                </>
              ) : null}
            </Text>
          ) : null}
        </View>

        <SymbolView
          name="chevron.down"
          size={12}
          tintColor={mutedColor}
          type="monochrome"
          style={{
            transform: [{ rotate: props.expanded ? "180deg" : "0deg" }],
          }}
        />
      </Pressable>

      {props.expanded ? (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          className="gap-3 px-4 pb-4"
        >
          {props.environment.isRelayManaged ? (
            <Text className="text-sm text-foreground-muted">
              Managed by T3 Cloud. Tunnel details update automatically.
            </Text>
          ) : (
            <>
              <View className="gap-1.5">
                <Text
                  className="text-2xs font-t3-bold uppercase text-foreground-muted"
                  style={{ letterSpacing: 0.8 }}
                >
                  Label
                </Text>
                <TextInput
                  autoCapitalize="words"
                  autoCorrect={false}
                  placeholder="My MacBook"
                  placeholderTextColor={placeholderColor}
                  value={label}
                  onChangeText={setLabel}
                  className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground"
                />
              </View>

              <View className="gap-1.5">
                <Text
                  className="text-2xs font-t3-bold uppercase text-foreground-muted"
                  style={{ letterSpacing: 0.8 }}
                >
                  URL
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="192.168.1.100:8080"
                  placeholderTextColor={placeholderColor}
                  value={url}
                  onChangeText={setUrl}
                  className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground"
                />
              </View>
            </>
          )}

          <View className="flex-row justify-end gap-2">
            {props.environment.isRelayManaged ? null : (
              <Pressable
                className="min-h-[42px] flex-1 flex-row items-center justify-center gap-1.5 rounded-[14px] bg-primary px-3.5 py-2.5 active:opacity-70"
                onPress={handleSave}
              >
                <SymbolView name="checkmark" size={13} tintColor={primaryFg} type="monochrome" />
                <Text
                  className="text-xs font-t3-bold uppercase text-primary-foreground"
                  style={{ letterSpacing: 0.8 }}
                >
                  Save
                </Text>
              </Pressable>
            )}

            <Pressable
              className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-input-border bg-input active:opacity-70"
              onPress={() => props.onReconnect(props.environment.environmentId)}
            >
              <SymbolView
                name="arrow.clockwise"
                size={14}
                tintColor={mutedColor}
                type="monochrome"
              />
            </Pressable>

            <Pressable
              className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-danger-border bg-danger active:opacity-70"
              onPress={() => props.onRemove(props.environment.environmentId)}
            >
              <SymbolView name="trash" size={14} tintColor={dangerFg} type="monochrome" />
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
