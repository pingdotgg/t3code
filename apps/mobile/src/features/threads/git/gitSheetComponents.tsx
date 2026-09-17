import { SymbolView } from "../../../components/AppSymbol";
import type { ComponentProps } from "react";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/AppText";
import { MaterialButton } from "../../../components/MaterialButton";
import { cn } from "../../../lib/cn";

/* ─── Shared sheet components ──────────────────────────────────────── */

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
        <MaterialButton
          label={props.label}
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
        "min-h-[48px] flex-row items-center justify-center gap-2 px-4 py-3 disabled:opacity-[0.45]",
        "flex-1 rounded-[18px]",
        tone === "primary" ? "bg-primary" : tone === "danger" ? "bg-danger" : "bg-secondary",
        tone !== "primary" &&
          (tone === "danger" ? "border border-danger-border" : "border border-secondary-border"),
      )}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={16}
        tintColorClassName={textColorClassName}
        type="monochrome"
      />
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
    <View
      className={
        Platform.OS === "android"
          ? "rounded-[20px] bg-card px-4 py-3"
          : "rounded-[18px] border border-border bg-card px-4 py-3"
      }
    >
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
  return (
    <Pressable
      className={
        Platform.OS === "android"
          ? "min-h-16 flex-row items-center gap-4 px-4 py-3 active:bg-subtle disabled:opacity-[0.45]"
          : "flex-row items-center gap-3 px-1 py-3 disabled:opacity-[0.45]"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View
        className={
          Platform.OS === "android"
            ? "size-6 items-center justify-center"
            : "bg-subtle h-9 w-9 items-center justify-center rounded-full"
        }
      >
        <SymbolView
          name={props.icon}
          size={Platform.OS === "android" ? 24 : 16}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
      </View>
      <View className="flex-1 gap-0.5">
        <Text
          className={
            Platform.OS === "android"
              ? "text-foreground text-base font-t3-medium"
              : "text-foreground text-base font-t3-bold"
          }
        >
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-foreground-muted text-xs leading-snug">{props.subtitle}</Text>
        ) : null}
      </View>
      {Platform.OS !== "android" ? (
        <SymbolView
          name="chevron.right"
          size={13}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      ) : null}
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
