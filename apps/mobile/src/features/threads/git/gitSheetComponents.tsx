import { SymbolView } from "../../../components/ui/AppSymbol";
import type { ComponentProps } from "react";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";

export function SheetActionButton(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly onPress: () => void;
}) {
  if (Platform.OS === "android")
    return (
      <View className="flex-1">
        <Button
          label={props.label}
          icon={props.icon}
          tone={props.tone}
          disabled={props.disabled}
          onPress={props.onPress}
          fullWidth
        />
      </View>
    );
  const tone = props.tone ?? "secondary";
  const textColorClassName =
    tone === "primary"
      ? "accent-primary-foreground"
      : tone === "danger"
        ? "accent-danger-foreground"
        : "accent-secondary-foreground";

  return (
    <Pressable
      className={cn(
        "min-h-[48px] flex-1 items-center justify-center rounded-[18px] px-3 py-3 disabled:opacity-[0.45]",
        tone === "primary" ? "bg-primary" : tone === "danger" ? "bg-danger" : "bg-secondary",
        tone !== "primary" &&
          (tone === "danger" ? "border border-danger-border" : "border border-secondary-border"),
      )}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View className="max-w-full flex-row items-center justify-center gap-1.5">
        <SymbolView
          name={props.icon}
          size={16}
          tintColorClassName={textColorClassName}
          type="monochrome"
        />
        <Text
          className={cn(
            "shrink text-center text-xs font-t3-bold tracking-[0.9px] uppercase",
            tone === "primary"
              ? "text-primary-foreground"
              : tone === "danger"
                ? "text-danger-foreground"
                : "text-secondary-foreground",
          )}
        >
          {props.label}
        </Text>
      </View>
    </Pressable>
  );
}

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
