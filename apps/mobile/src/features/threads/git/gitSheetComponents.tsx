import { SymbolView } from "../../../components/AppSymbol";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";
import { useThemeColor } from "../../../lib/useThemeColor";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

/* ─── Shared sheet components ──────────────────────────────────────── */

export function SheetActionButton(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly onPress: () => void;
}) {
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const secondaryFg = useThemeColor("--color-secondary-foreground");

  const tone = props.tone ?? "secondary";
  const textColor = tone === "primary" ? primaryFg : tone === "danger" ? dangerFg : secondaryFg;

  return (
    <Pressable
      className={cn(
        "min-h-[48px] flex-1 flex-row items-center justify-center gap-2 rounded-[18px] px-4 py-3 disabled:opacity-[0.45]",
        tone === "primary"
          ? "bg-primary"
          : tone === "danger"
            ? "border border-danger-border bg-danger"
            : "border border-secondary-border bg-secondary",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={16} tintColor={textColor} type="monochrome" />
      <Text
        className={cn(
          "text-xs font-t3-bold tracking-[0.9px] uppercase",
          tone === "primary"
            ? "text-primary-foreground"
            : tone === "danger"
              ? "text-danger-foreground"
              : "text-secondary-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function MetaCard(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="rounded-[18px] border border-border bg-card px-4 py-3">
      <Text className="text-foreground-muted text-2xs font-t3-bold tracking-[0.9px] uppercase">
        {props.label}
      </Text>
      <Text selectable className="text-foreground text-sm font-medium" numberOfLines={1}>
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
      className="flex-row items-center gap-3 px-1 py-3 disabled:opacity-[0.45]"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View className="bg-subtle h-9 w-9 items-center justify-center rounded-full">
        <SymbolView name={props.icon} size={16} tintColor={iconColor} type="monochrome" />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-foreground text-base font-t3-bold">{props.title}</Text>
        {props.subtitle ? (
          <Text className="text-foreground-muted text-xs leading-snug">{props.subtitle}</Text>
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
