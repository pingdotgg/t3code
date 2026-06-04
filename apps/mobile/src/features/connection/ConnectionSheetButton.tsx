import { SymbolView } from "expo-symbols";
import { Platform, Pressable } from "react-native";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

const CARD_SHADOW = Platform.select({
  ios: {
    shadowColor: "rgba(23,23,23,0.08)",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 16,
  },
  android: { elevation: 3 },
});

const CARD_SHADOW_DARK = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
  },
  android: { elevation: 4 },
});

export { CARD_SHADOW, CARD_SHADOW_DARK };

export function ConnectionSheetButton(props: {
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly compact?: boolean;
  readonly onPress: () => void;
}) {
  const tone = props.tone ?? "secondary";

  const primaryBg = useThemeColor("--color-primary");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerBg = useThemeColor("--color-danger");
  const dangerBorderColor = useThemeColor("--color-danger-border");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const secondaryBg = useThemeColor("--color-secondary");
  const secondaryFg = useThemeColor("--color-secondary-foreground");
  const borderColor = useThemeColor("--color-border");

  const colors =
    tone === "primary"
      ? {
          backgroundColor: primaryBg,
          borderColor: "transparent",
          textColor: primaryFg,
        }
      : tone === "danger"
        ? {
            backgroundColor: dangerBg,
            borderColor: dangerBorderColor,
            textColor: dangerFg,
          }
        : {
            backgroundColor: secondaryBg,
            borderColor: borderColor,
            textColor: secondaryFg,
          };

  const primaryShadow =
    tone === "primary"
      ? Platform.select({
          ios: {
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.14,
            shadowRadius: 6,
          },
          android: { elevation: 3 },
        })
      : undefined;

  return (
    <Pressable
      className={cn(
        props.compact
          ? "min-h-[42px] flex-row items-center justify-center gap-1.5 rounded-[14px] px-3.5 py-2.5"
          : "min-h-[48px] flex-row items-center justify-center gap-2 rounded-[16px] px-4 py-3",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        {
          backgroundColor: colors.backgroundColor,
          borderWidth: tone === "primary" ? 0 : 1,
          borderColor: colors.borderColor,
          opacity: props.disabled ? 0.5 : 1,
        },
        primaryShadow,
      ]}
    >
      <SymbolView
        name={props.icon}
        size={props.compact ? 13 : 14}
        tintColor={colors.textColor}
        type="monochrome"
      />
      <Text
        className="text-[12px] font-t3-bold uppercase"
        style={{ color: colors.textColor, letterSpacing: 0.8 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
