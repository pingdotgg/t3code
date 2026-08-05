import type {
  NativeStackHeaderItem,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "./AppText";
import { T3Wordmark } from "./T3Wordmark";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { useThemeColor } from "../lib/useThemeColor";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../native/native-glass";

// Native leading items inherit different UIKit margins than title views.
const IOS_NATIVE_LEADING_TITLE_OFFSET = -6;
const IPAD_NATIVE_LEADING_TITLE_OFFSET = 7;

/**
 * Compact brand lockup sized for native navigation bars.
 */
export function CompactBrandTitle(
  props: {
    readonly nativeLeadingItem?: boolean;
  } = {},
) {
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const titleOffset =
    Platform.OS !== "ios"
      ? 0
      : props.nativeLeadingItem
        ? Platform.isPad
          ? IPAD_NATIVE_LEADING_TITLE_OFFSET
          : IOS_NATIVE_LEADING_TITLE_OFFSET
        : Platform.isPad
          ? IPAD_HOME_TITLE_OFFSET
          : 0;

  return (
    <View
      aria-level={1}
      accessibilityLabel="T3 Code, Threads"
      accessible
      role="heading"
      style={{
        alignItems: "center",
        flexDirection: "row",
        gap: 4,
        marginLeft: titleOffset,
      }}
    >
      <T3Wordmark color={iconColor} height={15} />
      <Text
        style={{
          color: mutedColor,
          fontFamily: "DMSans-Medium",
          fontSize: 21,
          letterSpacing: -0.5,
        }}
      >
        Code
      </Text>
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle />;
}

export function renderCompactBrandHeaderItems(): NativeStackHeaderItem[] {
  return [
    {
      element: <CompactBrandTitle nativeLeadingItem />,
      hidesSharedBackground: true,
      type: "custom",
    },
  ];
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  if (Platform.OS === "ios" && NATIVE_LIQUID_GLASS_SUPPORTED) {
    return {
      headerTitle: "Threads",
      headerTitleStyle: { color: "transparent", fontSize: 18, fontWeight: "800" },
      title: "Threads",
      unstable_headerLeftItems: renderCompactBrandHeaderItems,
    };
  }

  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
  };
}
