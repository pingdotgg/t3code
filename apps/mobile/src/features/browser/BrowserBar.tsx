import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { useState, type ReactNode } from "react";
import { LayoutAnimation, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { deriveSharedTopBand } from "../../lib/reserved-regions";
import { isDarkThemeColor, themeColorWithAlpha } from "../../lib/mobileTheme";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Safari's bar: frosted and tinted by the page (`pageColor`), with round controls and a centered
 * host. `compact`, while the page scrolls down, leaves a small host pill that expands it again.
 */
export function BrowserBar(props: {
  readonly url: string;
  readonly editable: boolean;
  readonly canGoBack: boolean;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onReload: () => void;
  readonly onSubmit: (value: string) => void;
  readonly trailing?: ReactNode;
  readonly compact?: boolean;
  readonly onExpand?: () => void;
  /** The page's theme or background color; the app's sheet color until the page reports one. */
  readonly pageColor?: string | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const band = deriveSharedTopBand(useNativeColumnLayoutMetrics());
  const { themeVariables } = useAppearancePreferences();
  const surface = props.pageColor || themeVariables["--color-sheet-solid"];
  const ink: Ink = isDarkThemeColor(surface) ? "light" : "dark";
  const inkColor = ink === "light" ? "#ffffff" : "#000000";

  if (props.compact && draft === null) {
    return (
      // Not the band: a compact bar is only as tall as its pill, under whatever top inset remains.
      <TopArea band={null} surface={surface} ink={ink} hairline>
        <View className="items-center pb-1.5 pt-0.5">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Address ${props.url}. Show the browser controls`}
            onPress={props.onExpand}
          >
            <Glass ink={ink} className="h-7 justify-center rounded-full px-3.5">
              <AppText numberOfLines={1} className="text-xs" style={{ color: inkColor }}>
                {hostOf(props.url)}
              </AppText>
            </Glass>
          </Pressable>
        </View>
      </TopArea>
    );
  }
  return (
    <TopArea band={band} surface={surface} ink={ink}>
      <View
        className={
          band ? "flex-row items-center gap-1.5 px-2" : "flex-row items-center gap-2 px-3 pb-2 pt-1"
        }
      >
        <RoundButton icon="xmark" label="Close browser" ink={ink} onPress={props.onClose} />
        {props.canGoBack ? (
          <RoundButton icon="chevron.left" label="Back" ink={ink} onPress={props.onBack} />
        ) : null}
        {/* On a tablet the address stays a readable width, centered between the buttons. */}
        <View className="min-w-0 flex-1 items-center">
          <Glass ink={ink} className="h-11 w-full max-w-2xl flex-row items-center rounded-full">
            <TextInput
              accessibilityLabel="Address"
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
              placeholder="Enter a URL"
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
              accessibilityLabel="Reload page"
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
      </View>
    </TopArea>
  );
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

/**
 * Below the top safe area, or, where the system status covers only one end of it, beside the
 * status in that band. Its frosted backdrop, tinted by the page, also fills the status area.
 */
function TopArea(props: {
  readonly band: ReturnType<typeof deriveSharedTopBand>;
  readonly surface: string;
  readonly ink: Ink;
  readonly hairline?: boolean;
  readonly children: ReactNode;
}) {
  const backdrop = (
    <>
      {Platform.OS === "ios" ? (
        <BlurView
          pointerEvents="none"
          intensity={60}
          tint={props.ink === "light" ? "dark" : "light"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: themeColorWithAlpha(props.surface, Platform.OS === "ios" ? 0.82 : 1),
            borderBottomWidth: props.hairline ? StyleSheet.hairlineWidth : 0,
            borderColor: props.ink === "light" ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)",
          },
        ]}
      />
    </>
  );
  if (!props.band) {
    return (
      <SafeAreaView edges={["top"]}>
        {backdrop}
        {props.children}
      </SafeAreaView>
    );
  }
  return (
    <View
      style={{
        height: props.band.height,
        paddingLeft: props.band.left,
        paddingRight: props.band.right,
        justifyContent: "center",
      }}
    >
      {backdrop}
      {props.children}
    </View>
  );
}

/** Safari's bar: compact while the page scrolls down, whole again when it scrolls back up. */
export function useBarFollowsScroll() {
  const [compact, setCompact] = useState(false);
  const show = (next: boolean) => {
    if (next === compact) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCompact(next);
  };
  return {
    compact,
    follow: (direction: "up" | "down") => show(direction === "down"),
    expand: () => show(false),
  };
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
