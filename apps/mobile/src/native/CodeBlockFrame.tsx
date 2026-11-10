import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../components/ui/AppSymbol";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

/**
 * The native code block's border and header, for a fence drawn in React once it closes.
 * The block slot already applies the code block's outer margins.
 */
export function CodeBlockFrame(props: {
  readonly label: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  const { textStyle } = props;
  return (
    <View
      style={[
        styles.block,
        {
          backgroundColor: textStyle.codeBlockBackgroundColor,
          borderColor: textStyle.dividerColor,
        },
      ]}
    >
      <View
        style={[
          styles.header,
          { borderBottomColor: themeColorWithAlpha(textStyle.codeColor, 0.2) },
        ]}
      >
        <Text
          style={[
            styles.label,
            {
              color: themeColorWithAlpha(textStyle.codeColor, 0.6),
              fontSize: textStyle.fontSize * 0.9 * 0.85,
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

/** A header icon; `active` draws it at full strength, as the native wrap toggle when on. */
export function CodeBlockHeaderButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly active?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={10}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={14}
        tintColor={
          props.active
            ? props.textStyle.codeColor
            : themeColorWithAlpha(props.textStyle.codeColor, 0.6)
        }
        type="monochrome"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  header: {
    height: 32,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { fontWeight: "500" },
  actions: { flexDirection: "row", alignItems: "center", gap: 14 },
});
