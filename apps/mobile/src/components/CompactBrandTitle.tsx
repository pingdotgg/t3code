import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../native/NativeWorkspaceColumns";
import Constants from "expo-constants";
import { appName } from "@t3tools/shared/appName";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { ConnMark } from "./ConnMark";
import { T3Wordmark } from "./T3Wordmark";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveBrandName, resolveMobileStageLabel } from "../lib/mobileBranding";
import { useAndroidControlSizing } from "./ui/useAndroidControlSizing";

const BRAND_MAX_FONT_SCALE = 1.4;
const WORDMARK_SUFFIX = "Code";

export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad && !NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? IPAD_HOME_TITLE_OFFSET : 0;
}

export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
    readonly accessibilityLabel?: string;
    /** Fills the row and hides the stage badge when the full title does not fit. */
    readonly fit?: boolean;
  } = {},
) {
  const gt = useGT();
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  // A renamed build (the nckrtl fork ships as Conn) shows its own mark and name.
  const brandName = resolveBrandName(Constants.expoConfig?.extra?.brandName);
  // Callers label the screen as "{appName}, <tab>" through the catalog.
  const accessibilityLabel =
    props.accessibilityLabel ?? gt("{appName}, Threads", { appName: appName() });
  const titleOffset = brandTitleOffset();
  const { scale } = useAndroidControlSizing();
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  // Measured only while the badge shows, so hiding it does not make it look like it fits.
  const [fullWidth, setFullWidth] = useState<number | null>(null);
  const showStage =
    !props.fit || availableWidth === null || fullWidth === null || fullWidth <= availableWidth;

  const title = (
    <View
      onLayout={
        props.fit && showStage ? (event) => setFullWidth(event.nativeEvent.layout.width) : undefined
      }
      aria-level={1}
      accessibilityLabel={accessibilityLabel}
      accessible
      role="heading"
      className="flex-row items-center gap-1.5"
      style={[
        { marginLeft: titleOffset },
        Platform.OS === "android" && { gap: 5.25 * scale },
        props.fit && { flexShrink: 0 },
      ]}
    >
      {brandName ? (
        <ConnMark colorClassName="accent-icon" size={Math.round(18 * scale)} />
      ) : (
        <T3Wordmark colorClassName="accent-icon" height={Math.round(15 * scale)} />
      )}
      <Text
        allowFontScaling={props.allowFontScaling}
        maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}
        className={
          brandName ? "font-t3-bold text-foreground" : "font-t3-medium text-foreground-muted"
        }
        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}
      >
        {brandName ?? WORDMARK_SUFFIX}
      </Text>
      {showStage ? (
        <View
          className="rounded-full bg-subtle px-1.5 py-0.5"
          style={
            Platform.OS === "android"
              ? { paddingHorizontal: 5.25 * scale, paddingVertical: 1.75 * scale }
              : undefined
          }
        >
          <Text
            allowFontScaling={props.allowFontScaling}
            maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}
            className="font-t3-bold text-foreground-muted uppercase"
            style={{ fontSize: 9 * scale, letterSpacing: 0.9 * scale }}
          >
            {stageLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return props.fit ? (
    <View
      className="min-w-0 flex-1 flex-row items-center"
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      {title}
    </View>
  ) : (
    title
  );
}
