import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../components/ui/AppSymbol";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

/**
 * A code block as desktop draws it: one rounded surface, the language and the actions on a quiet
 * row above the code, no divider. The block slot already applies the outer margins.
 */
export function CodeBlockFrame(props: {
  readonly label: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  const { textStyle } = props;
  const { themeAppearance } = useAppearancePreferences();
  return (
    <View
      style={[
        styles.block,
        {
          backgroundColor: textStyle.codeBlockBackgroundColor,
          // As on desktop: only a light surface needs an edge to read against the page.
          borderColor: themeAppearance === "light" ? textStyle.dividerColor : "transparent",
        },
      ]}
    >
      <View style={styles.header}>
        <Text
          numberOfLines={1}
          style={[
            styles.label,
            {
              color: themeColorWithAlpha(textStyle.codeColor, 0.55),
              fontSize: textStyle.fontSize * 0.75,
            },
          ]}
        >
          {props.label}
        </Text>
        <View style={styles.actions}>{props.actions}</View>
      </View>
      {props.children}
    </View>
  );
}

/** True for a moment after `flash()`, to show a copied check. */
export function useCopiedFlash() {
  const [copied, setCopied] = useState(false);
  const flash = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return { copied, flash };
}

/** A quiet header icon; `active` draws it at full strength on a faint backing, as a toggle that is on. */
export function CodeBlockHeaderButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly active?: boolean;
  readonly onPress: () => void;
}) {
  const { codeColor } = props.textStyle;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={props.active === undefined ? undefined : { selected: props.active }}
      hitSlop={6}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: themeColorWithAlpha(codeColor, pressed ? 0.14 : props.active ? 0.1 : 0),
        },
      ]}
    >
      <SymbolView
        name={props.icon}
        size={15}
        tintColor={props.active ? codeColor : themeColorWithAlpha(codeColor, 0.55)}
        type="monochrome"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  header: {
    minHeight: 30,
    paddingLeft: 14,
    paddingRight: 6,
    paddingTop: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  label: { flexShrink: 1, fontWeight: "500" },
  actions: { flexDirection: "row", alignItems: "center", gap: 2 },
  button: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
});
