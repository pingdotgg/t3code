import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { useNavigation } from "@react-navigation/native";
import { use, useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGT } from "gt-react-native";
import { withUniwind } from "uniwind";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { deriveSharedTopBand } from "../../lib/reserved-regions";
import { isDarkThemeColor, themeColorWithAlpha } from "../../lib/mobileTheme";
import { useBarInset } from "../../components/ui/useBarInset";
import { WorkspaceColumnMetricsContext } from "../../native/v5-workspace-context";
import { isDuoDevice } from "../../lib/device-type";
import { useDeviceType, useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

type BrowserBarProps = {
  readonly url: string;
  readonly editable: boolean;
  readonly canGoBack: boolean;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onReload: () => void;
  readonly onSubmit: (value: string) => void;
  /** In the inspector pane, opens the page full screen. */
  readonly onMaximize?: () => void;
  readonly trailing?: ReactNode;
  /** The page's theme or background color; the app's sheet color until the page reports one. */
  readonly pageColor?: string | null;
};

/**
 * Every browser surface: full screen or in the inspector pane, a page on this device or a
 * stream. The bar shrinks while the page scrolls down, like Safari's, and on the Duo the full
 * screen bar takes the status bar with it. A page that can scroll under the bar gets it laid
 * over itself on iOS, inset by `topInset`; a stream keeps the bar above it.
 */
export function BrowserChrome(props: {
  readonly bar: BrowserBarProps;
  readonly scrollsUnderBar: boolean;
  readonly inPane?: boolean;
  /** Keeps the whole bar showing, such as over an error. */
  readonly holdExpanded?: boolean;
  readonly children: (page: {
    readonly topInset: number;
    readonly onScrollDirection: (direction: "up" | "down") => void;
  }) => ReactNode;
}) {
  const [scrolledDown, setScrolledDown] = useState(false);
  const compact = scrolledDown && !props.holdExpanded;
  const overlay = Platform.OS === "ios" && props.scrollsUnderBar;
  const duo = isDuoDevice(useDeviceType());
  const hidesStatusBar = !props.inPane && duo;
  const navigation = useNavigation();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the status bar is a native screen option
  useEffect(() => {
    if (!hidesStatusBar) return;
    navigation.setOptions({ statusBarHidden: compact, statusBarAnimation: "fade" });
  }, [navigation, hidesStatusBar, compact]);
  // The page stays inset by the whole bar, so the bar shrinking never moves it, like Safari's.
  const fullBarHeight = useBrowserBarLayout(props.inPane === true).height;
  const [barHeight, setBarHeight] = useState(fullBarHeight);
  if (!compact && fullBarHeight !== barHeight) setBarHeight(fullBarHeight);

  const bar = (
    <BrowserBar
      {...props.bar}
      compact={compact}
      onExpand={() => setScrolledDown(false)}
      compactHidesStatusBar={hidesStatusBar}
      inPane={props.inPane === true}
    />
  );
  const page = props.children({
    topInset: overlay ? barHeight : 0,
    onScrollDirection: (direction) => setScrolledDown(direction === "down"),
  });
  if (!overlay) {
    return (
      <>
        {bar}
        <View className="flex-1">{page}</View>
      </>
    );
  }
  return (
    <View className="flex-1">
      {page}
      <View className="absolute inset-x-0 top-0">{bar}</View>
    </View>
  );
}

/**
 * Safari's bar: frosted and tinted by the page (`pageColor`), with round controls and a centered
 * host. `compact`, while the page scrolls down, shrinks it to a small host pill that expands it.
 */
function BrowserBar(
  props: BrowserBarProps & {
    readonly compact: boolean;
    readonly onExpand: () => void;
    /** The screen hides the status bar while compact, so the pill can sit at the very top. */
    readonly compactHidesStatusBar: boolean;
    readonly inPane: boolean;
  },
) {
  const gt = useGT();
  const [draft, setDraft] = useState<string | null>(null);
  const layout = useBrowserBarLayout(props.inPane);
  const reduceMotion = useReducedMotion();
  const { themeVariables } = useAppearancePreferences();
  const surface = props.pageColor || themeVariables["--color-sheet-solid"];
  const ink: Ink = isDarkThemeColor(surface) ? "light" : "dark";
  const inkColor = ink === "light" ? "#ffffff" : "#000000";
  const compact = props.compact && draft === null;
  const expandedHeight = layout.height;
  const pillTop = props.compactHidesStatusBar ? 0 : layout.statusTop;
  const compactHeight = pillTop + PILL_ROW_HEIGHT;
  // One bar whose height follows the scroll, so nothing under it jumps between two layouts.
  const progress = useDerivedValue(() =>
    withTiming(compact ? 1 : 0, { duration: reduceMotion ? 0 : 280 }),
  );
  const barStyle = useAnimatedStyle(() => ({
    height: interpolate(progress.value, [0, 1], [expandedHeight, compactHeight]),
  }));
  const controlsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5], [1, 0], "clamp"),
    transform: [{ scale: interpolate(progress.value, [0, 1], [1, 0.92]) }],
  }));
  const pillStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.4, 1], [0, 1], "clamp"),
  }));
  const hairlineStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <Animated.View style={[{ overflow: "hidden" }, barStyle]}>
      {Platform.OS === "ios" ? (
        <BlurView
          pointerEvents="none"
          intensity={60}
          tint={ink === "light" ? "dark" : "light"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: themeColorWithAlpha(surface, Platform.OS === "ios" ? 0.82 : 1) },
        ]}
      />
      <Animated.View
        pointerEvents={compact ? "none" : "auto"}
        style={[
          {
            position: "absolute",
            top: layout.rowTop,
            left: layout.left,
            right: layout.right,
            height: layout.rowHeight,
            justifyContent: "center",
          },
          controlsStyle,
        ]}
      >
        <View
          className={
            layout.narrow
              ? "flex-row items-center gap-1.5 px-2"
              : "flex-row items-center gap-2 px-3"
          }
        >
          <RoundButton icon="xmark" label={gt("Close browser")} ink={ink} onPress={props.onClose} />
          {props.canGoBack ? (
            <RoundButton
              icon="chevron.left"
              label={gt("Back", { $context: "browser history" })}
              ink={ink}
              onPress={props.onBack}
            />
          ) : null}
          {/* On a tablet the address stays a readable width, centered between the buttons. */}
          <View className="min-w-0 flex-1 items-center">
            <Glass ink={ink} className="h-11 w-full max-w-2xl flex-row items-center rounded-full">
              <TextInput
                accessibilityLabel={gt("Address", { $context: "browser address bar" })}
                editable={props.editable}
                // Unfocused, the field shows only the host, like Safari; editing starts from the URL.
                value={draft ?? hostOf(props.url)}
                onFocus={() => setDraft(props.url)}
                onChangeText={setDraft}
                onBlur={() => setDraft(null)}
                onSubmitEditing={() => {
                  const value = draft ?? props.url;
                  setDraft(null);
                  props.onSubmit(value);
                }}
                placeholder={gt("Enter a URL")}
                placeholderTextColor={themeColorWithAlpha(inkColor, 0.45)}
                selectionColor={themeVariables["--color-primary"]}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                selectTextOnFocus
                lineBreakModeIOS="middle"
                numberOfLines={1}
                textAlign={draft === null ? "center" : "left"}
                className="h-11 min-w-0 flex-1 pl-3 font-sans text-[15px]"
                style={{ color: inkColor }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Reload page")}
                disabled={!props.editable}
                onPress={props.onReload}
                className="h-11 w-9 items-center justify-center"
              >
                <SymbolView
                  name="arrow.clockwise"
                  size={16}
                  tintColor={themeColorWithAlpha(inkColor, props.editable ? 0.85 : 0.35)}
                />
              </Pressable>
            </Glass>
          </View>
          {props.trailing}
          {props.onMaximize ? (
            <RoundButton
              icon="arrow.up.left.and.arrow.down.right"
              label={gt("Maximize page")}
              ink={ink}
              onPress={props.onMaximize}
            />
          ) : null}
        </View>
      </Animated.View>
      <Animated.View
        pointerEvents={compact ? "auto" : "none"}
        style={[
          { position: "absolute", top: pillTop, left: 0, right: 0, height: PILL_ROW_HEIGHT },
          pillStyle,
        ]}
        className="items-center justify-center"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Address {url}. Show the browser controls", { url: props.url })}
          onPress={props.onExpand}
        >
          <Glass ink={ink} className="h-7 justify-center rounded-full px-3.5">
            <AppText numberOfLines={1} className="text-xs" style={{ color: inkColor }}>
              {hostOf(props.url)}
            </AppText>
          </Glass>
        </Pressable>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: ink === "light" ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)",
          },
          hairlineStyle,
        ]}
      />
    </Animated.View>
  );
}

const EXPANDED_ROW_HEIGHT = 56;
// UIKit's navigation bar in a workspace column, whose controls sit in its top 48pt.
const NAVIGATION_BAR_HEIGHT = 58;
const NAVIGATION_BAR_CONTROLS_HEIGHT = 48;
const PILL_ROW_HEIGHT = 40;

/**
 * Where the whole bar's controls go. Full screen: below the top safe area, or beside the status
 * where it covers only one end of that band. In the inspector pane: centered in the height of
 * the headers beside it. `height` is what a page under the bar insets its content by.
 */
function useBrowserBarLayout(inPane: boolean) {
  const band = deriveSharedTopBand(useNativeColumnLayoutMetrics());
  const safeTop = useSafeAreaInsets().top;
  // The pane draws no native bar of its own, so it lines up with the bars its neighbors draw.
  const columns = use(WorkspaceColumnMetricsContext);
  const barInset = useBarInset();
  const columnTops = [...(columns?.byColumn.values() ?? [])].map((metrics) => metrics.safeArea.top);
  const paneHeight = Math.max(barInset, ...columnTops);
  if (inPane) {
    return {
      rowTop: Math.max(0, paneHeight - NAVIGATION_BAR_HEIGHT),
      rowHeight: NAVIGATION_BAR_CONTROLS_HEIGHT,
      left: 0,
      right: 0,
      narrow: false,
      statusTop: 0,
      height: paneHeight,
    };
  }
  if (band) {
    return {
      rowTop: 0,
      rowHeight: band.height,
      left: band.left,
      right: band.right,
      narrow: true,
      statusTop: safeTop,
      height: band.height,
    };
  }
  return {
    rowTop: safeTop,
    rowHeight: EXPANDED_ROW_HEIGHT,
    left: 0,
    right: 0,
    narrow: false,
    statusTop: safeTop,
    height: safeTop + EXPANDED_ROW_HEIGHT,
  };
}

type Ink = "light" | "dark";

const StyledGlassView = withUniwind(GlassView, { style: { fromClassName: "className" } });

function RoundButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly ink: Ink;
  readonly onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress}>
      <Glass ink={props.ink} className="size-10 items-center justify-center rounded-full">
        <SymbolView
          name={props.icon}
          size={17}
          tintColor={props.ink === "light" ? "#ffffff" : "#000000"}
        />
      </Glass>
    </Pressable>
  );
}

/** Liquid glass where iOS has it, matched to the page's lightness rather than the app's. */
function Glass(props: {
  readonly ink: Ink;
  readonly className: string;
  readonly children: ReactNode;
}) {
  if (Platform.OS === "ios" && isGlassEffectAPIAvailable()) {
    return (
      <StyledGlassView
        glassEffectStyle="regular"
        colorScheme={props.ink === "light" ? "dark" : "light"}
        isInteractive
        className={props.className}
      >
        {props.children}
      </StyledGlassView>
    );
  }
  return (
    <View
      className={props.className}
      style={{
        backgroundColor: props.ink === "light" ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.06)",
      }}
    >
      {props.children}
    </View>
  );
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
