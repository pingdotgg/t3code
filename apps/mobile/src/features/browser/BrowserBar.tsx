import { useState, type ReactNode } from "react";
import { LayoutAnimation, Pressable, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { deriveSharedTopBand } from "../../lib/reserved-regions";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";

/**
 * The one-row chrome above a browser page: close, back, address with reload, then `trailing`.
 * `compact`, while the page scrolls down, leaves only the host, which expands the bar on a tap.
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
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const band = deriveSharedTopBand(useNativeColumnLayoutMetrics());
  if (props.compact && draft === null) {
    return (
      <TopArea band={band}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Address ${props.url}. Show the browser controls`}
          onPress={props.onExpand}
          className="h-7 items-center justify-center px-6"
        >
          <AppText numberOfLines={1} className="text-xs text-foreground">
            {hostOf(props.url)}
          </AppText>
        </Pressable>
      </TopArea>
    );
  }
  return (
    <TopArea band={band}>
      <View
        className={
          band ? "flex-row items-center gap-1 px-2" : "flex-row items-center gap-1 px-2 pt-1 pb-1.5"
        }
      >
        <ControlPill icon="xmark" accessibilityLabel="Close browser" onPress={props.onClose} />
        {props.canGoBack ? (
          <ControlPill icon="chevron.left" accessibilityLabel="Back" onPress={props.onBack} />
        ) : null}
        {/* On a tablet the address stays a readable width, centered between the buttons. */}
        <View className="min-w-0 flex-1 items-center">
          <View className="h-10 w-full max-w-2xl flex-row items-center rounded-full bg-input pl-4">
            <TextInput
              accessibilityLabel="Address"
              editable={props.editable}
              // Unfocused, the field shows only host and path; editing starts from the full URL.
              value={draft ?? displayAddress(props.url)}
              onFocus={() => setDraft(props.url)}
              onChangeText={setDraft}
              onBlur={() => setDraft(null)}
              onSubmitEditing={() => {
                const value = draft ?? props.url;
                setDraft(null);
                props.onSubmit(value);
              }}
              placeholder="Enter a URL"
              placeholderTextColorClassName="accent-placeholder"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              selectTextOnFocus
              lineBreakModeIOS="middle"
              numberOfLines={1}
              className="h-10 min-w-0 flex-1 font-sans text-sm text-foreground"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reload page"
              disabled={!props.editable}
              onPress={props.onReload}
              className="size-10 items-center justify-center"
            >
              <SymbolView
                name="arrow.clockwise"
                size={16}
                tintColorClassName={props.editable ? "accent-icon" : "accent-icon-subtle"}
              />
            </Pressable>
          </View>
        </View>
        {props.trailing}
      </View>
    </TopArea>
  );
}

/**
 * Below the top safe area, or, where the system status covers only one end of it, beside the
 * status in that band. The screen around the bar insets its sides.
 */
function TopArea(props: {
  readonly band: ReturnType<typeof deriveSharedTopBand>;
  readonly children: ReactNode;
}) {
  if (!props.band) return <SafeAreaView edges={["top"]}>{props.children}</SafeAreaView>;
  return (
    <View
      style={{
        height: props.band.height,
        paddingLeft: props.band.left,
        paddingRight: props.band.right,
        justifyContent: "center",
      }}
    >
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

function displayAddress(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  } catch {
    return value;
  }
}
