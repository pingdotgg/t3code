import Constants from "expo-constants";
import type {
  NativeStackHeaderItem,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "./AppText";
import { T3Wordmark } from "./T3Wordmark";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../native/native-glass";

// Native leading items inherit different UIKit margins than title views.
const IOS_NATIVE_LEADING_TITLE_OFFSET = -6;
const IPAD_NATIVE_LEADING_TITLE_OFFSET = 7;

/**
 * Horizontal correction applied to content rendered in the brand title slot,
 * shared with the connection-status swap so both align identically.
 */
export function brandTitleOffset(nativeLeadingItem: boolean): number {
  if (Platform.OS !== "ios") return 0;
  if (nativeLeadingItem) {
    return Platform.isPad ? IPAD_NATIVE_LEADING_TITLE_OFFSET : IOS_NATIVE_LEADING_TITLE_OFFSET;
  }
  return Platform.isPad ? IPAD_HOME_TITLE_OFFSET : 0;
}

/**
 * Compact brand lockup sized for native navigation bars.
 */
export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
    readonly nativeLeadingItem?: boolean;
  } = {},
) {
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  const titleOffset = brandTitleOffset(props.nativeLeadingItem === true);

  return (
    <View
      aria-level={1}
      accessibilityLabel="T3 Code, Threads"
      accessible
      role="heading"
      className="flex-row items-center gap-1.5"
      style={{ marginLeft: titleOffset }}
    >
      <T3Wordmark colorClassName="accent-icon" height={15} />
      <Text
        allowFontScaling={props.allowFontScaling}
        className="font-t3-medium text-[21px] tracking-[-0.5px] text-foreground-muted"
      >
        Code
      </Text>
      <View className="rounded-full bg-subtle px-1.5 py-0.5">
        <Text
          allowFontScaling={props.allowFontScaling}
          className="font-t3-bold text-[9px] tracking-[0.9px] text-foreground-muted uppercase"
        >
          {stageLabel}
        </Text>
      </View>
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
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
