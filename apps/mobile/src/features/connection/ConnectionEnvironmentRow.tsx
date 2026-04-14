import { SymbolView } from "expo-symbols";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

export function ConnectionEnvironmentRow(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onReconnect: (environmentId: string) => void;
  readonly onRemove: (environmentId: string) => void;
  readonly onUpdate: (
    environmentId: string,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => void;
}) {
  const [label, setLabel] = useState(props.environment.environmentLabel);
  const [url, setUrl] = useState(props.environment.displayUrl);

  const mutedColor = useThemeColor("--color-icon-subtle");
  const placeholderColor = useThemeColor("--color-placeholder");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");

  const handleSave = useCallback(() => {
    props.onUpdate(props.environment.environmentId, {
      label: label.trim(),
      displayUrl: url.trim(),
    });
    props.onToggle();
  }, [label, url, props]);

  return (
    <Animated.View layout={LinearTransition.duration(250)} className="bg-card">
      <Pressable
        className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-70"
        onPress={props.onToggle}
      >
        <ConnectionStatusDot state={props.environment.connectionState} pulse={false} size={8} />

        <View className="flex-1 gap-0.5">
          <Text
            className="text-[16px] font-t3-bold leading-[21px] text-foreground"
            numberOfLines={1}
          >
            {props.environment.environmentLabel}
          </Text>
          <Text className="text-[12px] leading-[16px] text-foreground-muted" numberOfLines={1}>
            {props.environment.displayUrl}
          </Text>
          {props.environment.connectionError ? (
            <Text
              className="text-[12px] leading-[16px] text-rose-500 dark:text-rose-400"
              numberOfLines={2}
            >
              {props.environment.connectionError}
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
          <View className="gap-1.5">
            <Text
              className="text-[11px] font-t3-bold uppercase text-foreground-muted"
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
              className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-[15px] text-foreground"
            />
          </View>

          <View className="gap-1.5">
            <Text
              className="text-[11px] font-t3-bold uppercase text-foreground-muted"
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
              className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-[15px] text-foreground"
            />
          </View>

          <View className="flex-row gap-2">
            <Pressable
              className="min-h-[42px] flex-1 flex-row items-center justify-center gap-1.5 rounded-[14px] bg-primary px-3.5 py-2.5 active:opacity-70"
              onPress={handleSave}
            >
              <SymbolView name="checkmark" size={13} tintColor={primaryFg} type="monochrome" />
              <Text
                className="text-[12px] font-t3-bold uppercase text-primary-foreground"
                style={{ letterSpacing: 0.8 }}
              >
                Save
              </Text>
            </Pressable>

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
