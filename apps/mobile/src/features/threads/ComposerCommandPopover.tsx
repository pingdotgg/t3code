import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type { ComposerTriggerKind } from "@t3tools/shared/composerTrigger";
import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { memo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  useColorScheme,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import {
  placeComposerCommandPopover,
  type ComposerAnchorRect,
} from "./composerCommandPopoverLayout";
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
  readonly anchorRect: ComposerAnchorRect | null;
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
      <Text
        className="text-base font-t3-medium text-foreground"
        numberOfLines={1}
        style={{ flexShrink: 0 }}
      >
        {props.item.label}
      </Text>
      {props.item.description ? (
        <Text
          className="text-xs"
          numberOfLines={1}
          style={{
            flex: 1,
            minWidth: 0,
            color: "#a1a1aa",
          }}
        >
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
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const label = groupLabel(props.triggerKind);

  const onSurfaceLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSurfaceSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  };
  const placement =
    props.anchorRect && surfaceSize.width > 0 && surfaceSize.height > 0
      ? placeComposerCommandPopover({
          anchor: props.anchorRect,
          menuWidth: props.anchorRect.width,
          menuHeight: surfaceSize.height,
          windowWidth,
          windowHeight,
          leftInset: insets.left,
          rightInset: insets.right,
          topInset: insets.top,
          bottomInset: insets.bottom,
        })
      : null;

  return (
    <Modal
      transparent
      visible={props.anchorRect !== null}
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => undefined}
    >
      <View style={{ flex: 1 }} pointerEvents="box-none">
        <View
          onLayout={onSurfaceLayout}
          pointerEvents={placement ? "auto" : "none"}
          style={[
            {
              position: "absolute",
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              width: placement?.width ?? props.anchorRect?.width ?? 0,
              opacity: placement ? 1 : 0,
            },
          ]}
        >
          <PopoverSurface isDarkMode={isDarkMode}>
            {label ? (
              <View style={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 }}>
                <Text
                  className="text-3xs font-t3-bold text-foreground-muted"
                  style={{ letterSpacing: 0.8, textTransform: "uppercase" }}
                >
                  {label}
                </Text>
              </View>
            ) : null}
            {props.items.length > 0 ? (
              <ScrollView
                style={{ maxHeight: 180 }}
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
              <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
                <Text className="text-xs text-foreground-tertiary">
                  {emptyText(props.triggerKind, props.isLoading)}
                </Text>
              </View>
            )}
          </PopoverSurface>
        </View>
      </View>
    </Modal>
  );
});
