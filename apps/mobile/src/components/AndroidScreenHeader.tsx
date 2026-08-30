import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { ControlPillMenu } from "./ControlPill";
import { cn } from "../lib/cn";
import { MobileNavigationHistoryButtons } from "../features/navigation/MobileNavigationHistoryButtons";

export interface AndroidHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}

export function AndroidHeaderIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      className={cn(
        "size-11 items-center justify-center rounded-full bg-subtle",
        props.disabled && "opacity-55",
      )}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColorClassName={props.disabled ? "accent-icon-subtle" : "accent-foreground"}
        type="monochrome"
      />
    </Pressable>
  );
}

export function AndroidScreenHeader(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AndroidHeaderAction>;
  readonly trailing?: ReactNode;
  readonly onBack?: () => void;
  readonly backDisabled?: boolean;
  readonly embedded?: boolean;
  readonly showNavigationHistory?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const navigationHistoryVisible = !props.embedded && props.showNavigationHistory !== false;
  const actions = props.actions ?? [];
  const collapseActions = navigationHistoryVisible && actions.length > 2;
  const visibleActions = collapseActions ? actions.slice(0, 1) : actions;
  const overflowActions = collapseActions ? actions.slice(1) : [];
  const overflowMenuActions: MenuAction[] = overflowActions.map((action) => ({
    id: action.accessibilityLabel,
    title: action.accessibilityLabel,
    ...(typeof action.icon === "string" ? { image: action.icon } : {}),
    ...(action.disabled ? { attributes: { disabled: true } } : {}),
  }));

  return (
    <View
      className="border-b border-header-border bg-header px-3 pb-2.5"
      style={{
        paddingTop: props.embedded ? 8 : Math.max(insets.top, 12),
      }}
    >
      <View className="min-h-12 flex-row items-center gap-2">
        {props.onBack ? (
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            disabled={props.backDisabled}
            hitSlop={8}
            onPress={props.onBack}
            className={cn(
              "-mr-2 size-11 items-center justify-center",
              props.backDisabled && "opacity-55",
            )}
          >
            <SymbolView
              name="chevron.left"
              size={24}
              tintColorClassName={"accent-foreground"}
              type="monochrome"
            />
          </Pressable>
        ) : null}

        <View className={cn("min-w-0 flex-1", !props.onBack && "pl-1")}>
          <Text numberOfLines={1} className="text-lg font-t3-bold text-foreground">
            {props.title}
          </Text>
          {props.subtitle ? (
            <Text
              numberOfLines={1}
              className="mt-px text-[13px] font-t3-medium text-foreground-muted"
            >
              {props.subtitle}
            </Text>
          ) : null}
        </View>

        {visibleActions.map((action) => (
          <AndroidHeaderIconButton
            key={action.accessibilityLabel}
            accessibilityLabel={action.accessibilityLabel}
            disabled={action.disabled}
            icon={action.icon}
            onPress={action.onPress}
          />
        ))}
        {overflowMenuActions.length > 0 ? (
          <ControlPillMenu
            actions={overflowMenuActions}
            isAnchoredToRight
            onPressAction={({ nativeEvent }) => {
              overflowActions
                .find((action) => action.accessibilityLabel === nativeEvent.event)
                ?.onPress();
            }}
          >
            <AndroidHeaderIconButton accessibilityLabel="More actions" icon="ellipsis" />
          </ControlPillMenu>
        ) : null}
        {navigationHistoryVisible ? <MobileNavigationHistoryButtons grouped /> : null}
        {props.trailing}
      </View>
    </View>
  );
}

export function AndroidSheetHeader(
  props: Omit<Parameters<typeof AndroidScreenHeader>[0], "embedded">,
) {
  return <AndroidScreenHeader {...props} embedded />;
}
