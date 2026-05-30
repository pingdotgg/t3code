import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";
import { useThemeColor } from "../../../lib/useThemeColor";
import { AppText as Text } from "../../../components/AppText";

/* ─── Shared sheet components ──────────────────────────────────────── */

export function SheetActionButton(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly onPress: () => void;
}) {
  const primaryBg = useThemeColor("--color-primary");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerBg = useThemeColor("--color-danger");
  const dangerBorder = useThemeColor("--color-danger-border");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const secondaryBg = useThemeColor("--color-secondary");
  const secondaryBorder = useThemeColor("--color-secondary-border");
  const secondaryFg = useThemeColor("--color-secondary-foreground");

  const tone = props.tone ?? "secondary";
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
            borderColor: dangerBorder,
            textColor: dangerFg,
          }
        : {
            backgroundColor: secondaryBg,
            borderColor: secondaryBorder,
            textColor: secondaryFg,
          };

  return (
    <Pressable
      className="min-h-[48px] flex-1 flex-row items-center justify-center gap-2 rounded-[18px] px-4 py-3"
      disabled={props.disabled}
      style={{
        backgroundColor: colors.backgroundColor,
        borderWidth: tone === "primary" ? 0 : 1,
        borderColor: colors.borderColor,
        opacity: props.disabled ? 0.45 : 1,
      }}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={16} tintColor={colors.textColor} type="monochrome" />
      <Text
        className="text-[12px] font-t3-bold uppercase"
        style={{ color: colors.textColor, letterSpacing: 0.9 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function MetaCard(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="rounded-[18px] border border-border bg-card px-4 py-3">
      <Text
        className="text-foreground-muted text-[11px] font-t3-bold uppercase"
        style={{ letterSpacing: 0.9 }}
      >
        {props.label}
      </Text>
      <Text selectable className="text-foreground text-[13px] font-medium" numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  );
}

export function SheetListRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly title: string;
  readonly subtitle?: string | null;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");

  return (
    <Pressable
      className="flex-row items-center gap-3 px-1 py-3"
      disabled={props.disabled}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
      onPress={props.onPress}
    >
      <View className="bg-subtle h-9 w-9 items-center justify-center rounded-full">
        <SymbolView name={props.icon} size={16} tintColor={iconColor} type="monochrome" />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-foreground text-[16px] font-t3-bold">{props.title}</Text>
        {props.subtitle ? (
          <Text className="text-foreground-muted text-[12px] leading-[17px]">{props.subtitle}</Text>
        ) : null}
      </View>
      <SymbolView name="chevron.right" size={13} tintColor={iconSubtleColor} type="monochrome" />
    </Pressable>
  );
}

/* ─── Shared utilities ──────────────────────────────────────────────── */

export function menuItemIconName(
  icon: "commit" | "push" | "pr",
): ComponentProps<typeof SymbolView>["name"] {
  if (icon === "commit") return "checkmark.circle";
  if (icon === "push") return "arrow.up.circle";
  return "arrow.up.right.circle";
}

export function statusSummary(
  gitStatus: {
    readonly isRepo?: boolean;
    readonly hasWorkingTreeChanges?: boolean;
    readonly workingTree?: { readonly files: readonly { readonly path: string }[] };
    readonly aheadCount?: number;
    readonly behindCount?: number;
    readonly pr?: { readonly state?: string; readonly number?: number } | null;
  } | null,
): string {
  if (!gitStatus) {
    return "Loading branch status\u2026";
  }

  if (!gitStatus.isRepo) {
    return "Not a git repository";
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    const fileCount = gitStatus.workingTree?.files.length ?? 0;
    parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed`);
  } else {
    parts.push("Clean");
  }
  if ((gitStatus.aheadCount ?? 0) > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  }
  if ((gitStatus.behindCount ?? 0) > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  }
  if (gitStatus.pr?.state === "open") {
    parts.push(`PR #${gitStatus.pr.number} open`);
  }

  return parts.join(" \u00b7 ");
}
