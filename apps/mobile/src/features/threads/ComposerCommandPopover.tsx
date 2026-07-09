import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type { ComposerTriggerKind } from "@t3tools/shared/composerTrigger";
import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { memo } from "react";
import { Pressable, ScrollView, useColorScheme, View, type ViewStyle } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
export type ComposerCommandItem =
  | {
      readonly id: string;
      readonly type: "path";
      readonly path: string;
      readonly kind: "file" | "directory";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "slash-command";
      readonly command: string;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "provider-slash-command";
      readonly command: ServerProviderSlashCommand;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "skill";
      readonly skill: ServerProviderSkill;
      readonly label: string;
      readonly description: string;
    };

interface ComposerCommandPopoverProps {
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly triggerKind: ComposerTriggerKind | null;
  readonly isLoading: boolean;
  readonly onSelect: (item: ComposerCommandItem) => void;
}

function PopoverSurface(props: {
  readonly children: React.ReactNode;
  readonly isDarkMode: boolean;
  readonly style?: ViewStyle;
}) {
  const baseStyle: ViewStyle = {
    borderRadius: 16,
    overflow: "hidden",
    ...props.style,
  };

  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        effect="clear"
        interactive={false}
        tintColor={props.isDarkMode ? "rgba(30,30,32,0.95)" : "rgba(255,255,255,0.92)"}
        colorScheme={props.isDarkMode ? "dark" : "light"}
        style={baseStyle}
      >
        {props.children}
      </LiquidGlassView>
    );
  }

  return (
    <View
      style={[
        baseStyle,
        {
          backgroundColor: props.isDarkMode ? "rgba(44,44,46,0.96)" : "rgba(255,255,255,0.96)",
          borderWidth: 1,
          borderColor: props.isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
        },
      ]}
    >
      {props.children}
    </View>
  );
}

function itemIcon(item: ComposerCommandItem) {
  switch (item.type) {
    case "slash-command":
    case "provider-slash-command":
      return "terminal" as const;
    case "skill":
      return "cube" as const;
    case "path":
      return null;
  }
}

function groupLabel(triggerKind: ComposerTriggerKind | null): string | null {
  switch (triggerKind) {
    case "slash-command":
      return "Commands";
    case "skill":
      return "Skills";
    case "path":
      return "Files";
    default:
      return null;
  }
}

function emptyText(triggerKind: ComposerTriggerKind | null, isLoading: boolean): string {
  if (isLoading) {
    return triggerKind === "path" ? "Searching files…" : "Loading…";
  }
  switch (triggerKind) {
    case "path":
      return "No matching files or folders.";
    case "skill":
      return "No skills found.";
    case "slash-command":
      return "No matching commands.";
    default:
      return "No results.";
  }
}

const CommandRow = memo(function CommandRow(props: {
  readonly item: ComposerCommandItem;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  const iconName = itemIcon(props.item);
  const iconColor = "#a1a1aa";

  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 10,
        opacity: pressed ? 0.6 : 1,
        borderBottomWidth: props.isLast ? 0 : 0.5,
        borderBottomColor: "rgba(255,255,255,0.1)",
      })}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon path={props.item.path} kind={props.item.kind} size={16} />
      ) : iconName ? (
        <SymbolView name={iconName} size={14} tintColor={iconColor} type="monochrome" />
      ) : null}
      <Text className="shrink-0 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {props.item.label}
      </Text>
      {props.item.description ? (
        <Text className="min-w-0 flex-1 text-xs text-zinc-400" numberOfLines={1}>
          {props.item.description}
        </Text>
      ) : null}
    </Pressable>
  );
});

export const ComposerCommandPopover = memo(function ComposerCommandPopover(
  props: ComposerCommandPopoverProps,
) {
  const isDarkMode = useColorScheme() === "dark";
  const label = groupLabel(props.triggerKind);

  return (
    <PopoverSurface isDarkMode={isDarkMode}>
      {label ? (
        <View className="px-3.5 pt-2.5 pb-1">
          <Text className="text-3xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
            {label}
          </Text>
        </View>
      ) : null}
      {props.items.length > 0 ? (
        <ScrollView
          className="max-h-[180px]"
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          {props.items.map((item, index) => (
            <CommandRow
              key={item.id}
              item={item}
              onPress={() => props.onSelect(item)}
              isLast={index === props.items.length - 1}
            />
          ))}
        </ScrollView>
      ) : (
        <View className="px-3.5 py-2.5">
          <Text className="text-xs text-foreground-tertiary">
            {emptyText(props.triggerKind, props.isLoading)}
          </Text>
        </View>
      )}
    </PopoverSurface>
  );
});
