import { useState, type ReactNode } from "react";
import { I18nManager, Platform, type ViewStyle } from "react-native";
import Animated, {
  FadeIn,
  type LayoutAnimationFunction,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAdaptiveWorkspaceLayout } from "../features/layout/AdaptiveWorkspaceLayout";
import { useSidebarWorkspaceTabs } from "../features/layout/workspace/useSystemWorkspaceTabBar";
import { useAndroidFloatingTabs } from "../features/settings/appearance/AppearancePreferencesProvider";
import { compactEditorInsets } from "../features/threads/compactEditorInsets";
import {
  useDeviceType,
  useDuoBottomBarInset,
  useNativeLayoutMetrics,
} from "../native/native-layout-metrics";
import type { ScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { GlassSurface } from "./ui/GlassSurface";

const COLLAPSED_EDITOR_DEFAULT_INSET = 6;
// iOS puts line-height slack above glyphs. DM Sans's lowercase midline is
// descender (0.31em) + half x-height (0.504em) above the line bottom.
const LOWERCASE_MIDLINE_EM = 0.562;

function lowercaseMidline(text: ScaledTextRole): number {
  return text.lineHeight - LOWERCASE_MIDLINE_EM * text.fontSize;
}

function collapsedEditorInset(text: ScaledTextRole): number {
  const shift = lowercaseMidline(text) - lowercaseMidline(MOBILE_TYPOGRAPHY.body);
  return Math.max(0, Math.round(COLLAPSED_EDITOR_DEFAULT_INSET - shift));
}

const EXPANDED_EDITOR_INSET = 14;
// Room under the expanded editor for the toolbar row.
const EXPANDED_EDITOR_BOTTOM = 52;

export function useCompactComposerEditor(text: ScaledTextRole, value: string, animate: boolean) {
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [compactWidth, setCompactWidth] = useState(0);
  const contentHeight = contentSize.height;
  const rowWidth = useSharedValue(0);
  const editorX = useSharedValue(0);
  const editorWidth = useSharedValue(0);
  const inset =
    Platform.OS === "android" ? COLLAPSED_EDITOR_DEFAULT_INSET : collapsedEditorInset(text);
  const minimum = Math.max(INLINE_EDITOR_HEIGHT, Math.ceil(text.lineHeight) + 2 * inset);
  const height = Math.max(
    minimum,
    Math.min(text.lineHeight * 4 + 2 * inset, contentHeight + 2 * inset),
  );
  // A line that fits the expanded editor may still overflow its compact slot.
  // Compare its measured width too so widening cannot trigger a collapse loop.
  const isExpanded =
    value.length > 0 &&
    (contentHeight > text.lineHeight * 1.5 ||
      (compactWidth > 0 && contentSize.width > compactWidth));
  const compactRowHeight = Math.max(Platform.OS === "android" ? 48 : 44, minimum);
  const compactBottom = (compactRowHeight - minimum) / 2;
  const isRTL = I18nManager.isRTL;
  const expandedRowHeight = height + EXPANDED_EDITOR_BOTTOM;
  const expansion = useDerivedValue(() => {
    const target = isExpanded ? 1 : 0;
    return animate
      ? withTiming(target, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : target;
  });
  const editorStyle = useAnimatedStyle(() => {
    const compactInsets = compactEditorInsets({
      slotX: editorX.value,
      slotWidth: editorWidth.value,
      rowWidth: rowWidth.value,
      isRTL,
    });
    const progress = expansion.value;
    // Hanging from the row top lets the text ride the growing edge and ignore the stale
    // height measured while it still wrapped in the compact slot. Layout props only:
    // Reanimated applies transforms frames ahead of layout, which tore the text from its frame.
    return {
      position: "absolute",
      overflow: "hidden",
      // The compact slot is unknown until its first layout, so the editor would draw over the + button.
      opacity: isExpanded || editorWidth.value > 0 ? 1 : 0,
      height,
      top: compactBottom * (1 - progress),
      left: compactInsets.left + (EXPANDED_EDITOR_INSET - compactInsets.left) * progress,
      // Snapping the far edge keeps the line from rewrapping while the near edge moves.
      right: isExpanded ? EXPANDED_EDITOR_INSET : compactInsets.right,
    };
  });
  const containerStyle = useAnimatedStyle(() => ({
    height: compactRowHeight + (expandedRowHeight - compactRowHeight) * expansion.value,
  }));
  return {
    isExpanded,
    containerStyle,
    // The expanded toolbar takes the row the text is leaving; reveal it once the text has lifted.
    // An entering animation hides it from its first frame, which a shared-value opacity cannot.
    toolbarControlsEntering:
      animate && isExpanded
        ? FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS / 2)
            .duration(COMPOSER_TRANSITION_DURATION_MS / 2)
            .reduceMotion(ReduceMotion.System)
        : undefined,
    editorStyle,
    onRowLayout: (event: { nativeEvent: { layout: { width: number } } }) => {
      rowWidth.set(event.nativeEvent.layout.width);
    },
    onEditorLayout: (event: { nativeEvent: { layout: { x: number; width: number } } }) => {
      // The expanded toolbar gives this slot to the model control. Keep the
      // compact geometry for the return transition, rather than recording zero.
      if (!isExpanded) {
        editorX.set(event.nativeEvent.layout.x);
        editorWidth.set(event.nativeEvent.layout.width);
        setCompactWidth(Math.max(0, event.nativeEvent.layout.width - 8));
      }
    },
    editorProps: {
      singleLineCentered: !isExpanded,
      scrollEnabled: Platform.OS === "android" || contentHeight >= text.lineHeight * 4,
      contentInsetVertical: inset,
      onContentSizeChange: (size: { width: number; height: number }) => {
        setContentSize(size);
      },
      style: { flex: 1 },
    },
  };
}

export const COMPOSER_TRANSITION_DURATION_MS = 220;
// Side panes animate dock width; nested horizontal transitions would make the surface trail the toolbar.
const composerHeightTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
const COMPOSER_LAYOUT_TRANSITION = Platform.OS === "android" ? undefined : composerHeightTransition;
// Share of the one-row composer the draft keeps; a long model name truncates first.
export const INLINE_EDITOR_MIN_WIDTH = "40%";
const INLINE_EDITOR_HEIGHT = Platform.OS === "android" ? 48 : 36;

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  readonly animateLayout?: boolean;
  readonly tone?: "warning";
}) {
  const colors = useUniwindTheme();
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  const animatedBorderRadius = useDerivedValue(() =>
    shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius,
  );
  const borderCurve = props.style.borderCurve;
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
    ...(borderCurve ? { borderCurve } : {}),
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Animate every native frame or glass and content jump to final height inside the clip.
  return (
    <Animated.View
      className={
        Platform.OS === "android" ? undefined : "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      }
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
        },
      ]}
    >
      <AnimatedGlassSurface
        chrome="none"
        fallbackColor={colors["--color-composer-surface"]}
        fallbackClassName="border border-composer-border"
        glassEffectStyle="regular"
        pointerEvents="none"
        tintColor="transparent"
        layout={layoutTransition}
        style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        className={props.tone === "warning" ? "bg-warning" : undefined}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

/** Space below the composer pill, inside the bottom inset it is given. */
export const COMPOSER_BOTTOM_GUTTER = 6;

/** Control size and pill shape: larger beside a sidebar tab picker and on iPad. */
export function useComposerChrome() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const floatingSidebarComposer = useAndroidFloatingTabs() && layout.usesSplitView;
  const sidebarWorkspaceTabs = useSidebarWorkspaceTabs();
  const deviceType = useDeviceType();
  const usesLargeControls = sidebarWorkspaceTabs === "picker" || deviceType === "pad";
  return {
    usesLargeControls,
    controlSize: usesLargeControls ? ("large" as const) : ("regular" as const),
    borderRadius: usesLargeControls ? 31 : 27,
    paddingVertical: usesLargeControls ? 9 : floatingSidebarComposer ? 6 : 2,
  };
}

/**
 * The inset below a composer pinned to the bottom of a page. Fixed while the keyboard animates:
 * changing it at keyboardDidHide makes the composer land low, then jump back above the safe area.
 */
export function useComposerBottomInset() {
  const insets = useSafeAreaInsets();
  const windowMetrics = useNativeLayoutMetrics();
  const { layout } = useAdaptiveWorkspaceLayout();
  const bottomBarInset = useDuoBottomBarInset();
  const hasSidebarTabBar = useSidebarWorkspaceTabs() === "picker";
  // A pushed screen temporarily inherits the outgoing tab bar's safe area.
  // Use the window edge so hiding that bar cannot move the composer mid-push.
  const bottomSafeArea =
    Platform.OS === "ios" ? (windowMetrics?.safeArea.bottom ?? insets.bottom) : insets.bottom;
  // The pill already adds its own gutter; iPad and Duo align its edge with the native bar.
  const alignedBottomInset =
    bottomBarInset ??
    (Platform.OS === "ios" && Platform.isPad
      ? Math.max(bottomSafeArea, 12) - (layout.usesSplitView ? 5 : 0)
      : undefined);
  // The Duo's floating sidebar pill ends three points below the composer's usual gutter.
  return Math.max(
    0,
    (alignedBottomInset !== undefined
      ? alignedBottomInset - COMPOSER_BOTTOM_GUTTER
      : Math.max(bottomSafeArea, 12)) - (hasSidebarTabBar ? 3 : 0),
  );
}

/** The editor's text style: the composer's scaled role in the theme's foreground color. */
export function useComposerTextStyle(text: ScaledTextRole) {
  return { ...text, color: useUniwindTheme()["--color-foreground"] };
}
