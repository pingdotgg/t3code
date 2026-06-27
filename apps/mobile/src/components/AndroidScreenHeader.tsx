import type { ReactNode } from "react";
import { Pressable, Text as RNText, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { useThemeColor } from "../lib/useThemeColor";

export interface AndroidHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}

export function AndroidHeaderIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
}) {
  const foregroundColor = useThemeColor("--color-foreground");
  const subtleColor = useThemeColor("--color-subtle");
  const disabledColor = useThemeColor("--color-icon-subtle");

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      style={{
        alignItems: "center",
        backgroundColor: subtleColor,
        borderRadius: 22,
        height: 44,
        justifyContent: "center",
        opacity: props.disabled ? 0.55 : 1,
        width: 44,
      }}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColor={props.disabled ? disabledColor : foregroundColor}
        type="monochrome"
      />
    </Pressable>
  );
}

export function AndroidScreenHeader(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AndroidHeaderAction>;
  readonly trailing?: ReactNode;
  readonly onBack?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const backgroundColor = useThemeColor("--color-header");
  const borderColor = useThemeColor("--color-header-border");
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-foreground-muted");

  return (
    <View
      style={{
        backgroundColor,
        borderBottomColor: borderColor,
        borderBottomWidth: 1,
        paddingTop: Math.max(insets.top, 12),
        paddingBottom: 10,
        paddingHorizontal: 12,
      }}
    >
      <View
        style={{
          alignItems: "center",
          flexDirection: "row",
          gap: 8,
          minHeight: 48,
        }}
      >
        {props.onBack ? (
          <Pressable
            accessibilityLabel="Navigate up"
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onBack}
            style={{
              alignItems: "center",
              height: 44,
              justifyContent: "center",
              width: 44,
            }}
          >
            <SymbolView
              name="chevron.left"
              size={24}
              tintColor={foregroundColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}

        <View style={{ flex: 1, minWidth: 0, paddingLeft: props.onBack ? 0 : 4 }}>
          <RNText
            numberOfLines={1}
            style={{
              color: foregroundColor,
              fontFamily: "DMSans_700Bold",
              fontSize: MOBILE_TYPOGRAPHY.headline.fontSize,
            }}
          >
            {props.title}
          </RNText>
          {props.subtitle ? (
            <RNText
              numberOfLines={1}
              style={{
                color: mutedColor,
                fontFamily: "DMSans_500Medium",
                fontSize: MOBILE_TYPOGRAPHY.label.fontSize,
                marginTop: 1,
              }}
            >
              {props.subtitle}
            </RNText>
          ) : null}
        </View>

        {props.actions?.map((action) => (
          <AndroidHeaderIconButton
            key={action.accessibilityLabel}
            accessibilityLabel={action.accessibilityLabel}
            disabled={action.disabled}
            icon={action.icon}
            onPress={action.onPress}
          />
        ))}
        {props.trailing}
      </View>
    </View>
  );
}
