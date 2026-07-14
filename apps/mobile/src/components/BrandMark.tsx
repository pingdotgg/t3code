import { Platform, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "./AppText";

const PASSPORT_PEAK_PATH =
  "M 779.8 495.52 C 779.8 643.422 659.902 763.32 512 763.32 C 364.098 763.32 244.2 643.422 244.2 495.52 C 244.2 347.618 364.098 227.72 512 227.72 C 659.902 227.72 779.8 347.618 779.8 495.52 Z M 735.881 495.52 C 735.881 619.166 635.646 719.401 512 719.401 C 388.354 719.401 288.119 619.166 288.119 495.52 C 288.119 371.874 388.354 271.639 512 271.639 C 635.646 271.639 735.881 371.874 735.881 495.52 Z M 351.32 613.352 L 447.728 484.808 L 512 613.352 Z M 512 613.352 L 576.272 399.112 L 672.68 613.352 Z";

const BRAND_BACKGROUND = "#2F6BB0";
const BRAND_MARK = "#F2F7FB";

export function BrandMark(props: { readonly compact?: boolean; readonly stageLabel?: string }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const stageLabel = props.stageLabel ?? "Alpha";

  return (
    <View className="flex-row items-center gap-3">
      <View
        accessibilityLabel="SurgeCode"
        className="items-center justify-center"
        style={{
          backgroundColor: BRAND_BACKGROUND,
          borderRadius: compact ? 10 : 14,
          height: iconSize,
          width: iconSize,
        }}
      >
        <Svg height={iconSize} viewBox="0 0 1024 1024" width={iconSize}>
          <Path d={PASSPORT_PEAK_PATH} fill={BRAND_MARK} fillRule="evenodd" />
        </Svg>
      </View>
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="text-lg text-foreground"
            style={{
              fontFamily: Platform.select({ ios: "SF Pro Rounded", default: "DMSans_700Bold" }),
              fontWeight: "600",
              letterSpacing: -0.25,
            }}
          >
            SurgeCode
          </Text>
          <View className="rounded-full bg-subtle px-2 py-1">
            <Text
              className="text-3xs font-t3-bold uppercase text-foreground-muted"
              style={{ letterSpacing: 1.1 }}
            >
              {stageLabel}
            </Text>
          </View>
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}
