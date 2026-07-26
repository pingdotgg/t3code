import { memo, useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { extractTerminalBufferLinks, terminalLinkLabel } from "./terminalBufferLinks";
import type { TerminalTheme } from "./terminalTheme";

interface TerminalLinkBarProps {
  readonly buffer: string;
  readonly theme?: Pick<TerminalTheme, "border" | "foreground" | "mutedForeground">;
}

const DEFAULT_THEME = {
  border: "rgba(255, 255, 255, 0.1)",
  foreground: "#e5e5e5",
  mutedForeground: "#a3a3a3",
};

/**
 * Tappable chips for URLs printed in the terminal. The Ghostty surface draws
 * text on the GPU without link hit-testing, so this is how terminal URLs
 * (e.g. the `claude` OAuth login URL) are opened on mobile. Tap opens the
 * full reassembled URL; long-press copies it.
 */
export const TerminalLinkBar = memo(function TerminalLinkBar(props: TerminalLinkBarProps) {
  const links = useMemo(() => extractTerminalBufferLinks(props.buffer), [props.buffer]);
  const theme = props.theme ?? DEFAULT_THEME;

  if (links.length === 0) {
    return null;
  }

  return (
    <View className="border-b" style={{ borderBottomColor: theme.border }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="flex-row items-center gap-2 px-3 py-2"
        keyboardShouldPersistTaps="handled"
      >
        {links.map((url) => (
          <Pressable
            key={url}
            accessibilityRole="link"
            accessibilityLabel={`Open ${url}`}
            accessibilityHint="Long press to copy the link"
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: theme.border,
              paddingHorizontal: 12,
              paddingVertical: 6,
              opacity: pressed ? 0.6 : 1,
            })}
            onPress={() => void tryOpenExternalUrl(url, "terminal-link")}
            onLongPress={() => copyTextWithHaptic(url, { target: "terminal link" })}
          >
            <SymbolView name="link" size={11} tintColor={theme.mutedForeground} type="monochrome" />
            <Text className="text-2xs" numberOfLines={1} style={{ color: theme.foreground }}>
              {terminalLinkLabel(url)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
});
