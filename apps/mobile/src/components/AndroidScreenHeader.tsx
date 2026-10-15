import { useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import type { AppSymbolName } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { cn } from "../lib/cn";
import { MaterialIconButton } from "./MaterialIconButton";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";
import { splitAndroidHeaderActions } from "./headerMenu.android";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { useMaterialToolbarLayout } from "./useMaterialToolbarLayout";

export interface AndroidHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly selected?: boolean;
  readonly destructive?: boolean;
  readonly overflowOnly?: boolean;
}

export function AndroidHeaderIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
}) {
  return <MaterialIconButton {...props} tintColorClassName="accent-header-foreground" />;
}

export function AndroidScreenHeader(props: {
  readonly title: string;
  readonly titleContent?: ReactNode;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AndroidHeaderAction>;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onBack?: () => void;
  readonly embedded?: boolean;
  readonly hideBottomBorder?: boolean;
  /** One row: the subtitle follows the title, for screens short on height. */
  readonly compact?: boolean;
  /** Hides the toolbar row, keeping only the status bar inset, e.g. while reading history. */
  readonly collapsed?: boolean;
}) {
  const titleTypography = useScaledTextRole("title");
  const subtitleTypography = useScaledTextRole("label");
  const { height: materialToolbarHeight, ...headerPadding } = useMaterialToolbarLayout(
    props.embedded,
    props.compact,
  );
  const [headerWidth, setHeaderWidth] = useState(0);
  const { visibleActions, overflowActions } = splitAndroidHeaderActions(
    props.actions ?? [],
    headerWidth >= 600,
  );

  return (
    <Animated.View
      layout={HEADER_COLLAPSE_TRANSITION}
      onLayout={(event) => setHeaderWidth(event.nativeEvent.layout.width)}
      className="border-b border-header-border bg-header px-2"
      style={{
        ...headerPadding,
        ...(props.collapsed ? { paddingBottom: 0 } : null),
        borderBottomWidth: props.hideBottomBorder ? 0 : undefined,
      }}
    >
      {props.collapsed ? null : (
        <Animated.View
          entering={HEADER_ROW_ENTERING}
          exiting={HEADER_ROW_EXITING}
          style={{ minHeight: materialToolbarHeight }}
          className="flex-row items-center gap-1"
        >
          {props.onBack ? (
            <MaterialIconButton
              accessibilityLabel="Navigate up"
              icon="arrow.left"
              tintColorClassName="accent-header-foreground"
              onPress={props.onBack}
            />
          ) : null}

          {props.leading}

          <View
            className={cn(
              "min-w-0 flex-1",
              !props.onBack && "pl-1",
              props.compact && "flex-row items-baseline gap-2",
            )}
          >
            {props.titleContent ?? (
              <Text
                numberOfLines={1}
                style={titleTypography}
                className={cn("text-header-foreground", props.compact && "shrink")}
              >
                {props.title}
              </Text>
            )}
            {props.subtitle ? (
              <Text
                numberOfLines={1}
                style={subtitleTypography}
                className={cn(
                  "text-[13px] font-t3-medium text-foreground-muted",
                  props.compact ? "shrink-[2]" : "mt-px",
                )}
              >
                {props.subtitle}
              </Text>
            ) : null}
          </View>

          {visibleActions.map((action) =>
            action.loading ? (
              <View
                key={action.accessibilityLabel}
                accessibilityLabel={action.accessibilityLabel}
                className="size-12 items-center justify-center"
              >
                <ActivityIndicator colorClassName="accent-header-foreground" />
              </View>
            ) : (
              <AndroidHeaderIconButton
                key={action.accessibilityLabel}
                accessibilityLabel={action.accessibilityLabel}
                disabled={action.disabled}
                selected={action.selected}
                icon={action.icon}
                onPress={action.onPress}
              />
            ),
          )}
          {overflowActions.length > 0 ? (
            <AndroidAnchoredMenu
              actions={overflowActions.map((action, index) => ({
                id: String(index),
                title: action.accessibilityLabel,
                attributes: {
                  disabled: Boolean(action.disabled),
                  destructive: action.destructive,
                  state: action.selected ? "on" : undefined,
                },
              }))}
              onPressAction={({ nativeEvent }) =>
                overflowActions[Number(nativeEvent.event)]?.onPress()
              }
            >
              {(open) => (
                <MaterialIconButton
                  accessibilityLabel="More actions"
                  icon="ellipsis"
                  tintColorClassName="accent-header-foreground"
                  onPress={open}
                />
              )}
            </AndroidAnchoredMenu>
          ) : null}
          {props.trailing}
        </Animated.View>
      )}
    </Animated.View>
  );
}

const HEADER_COLLAPSE_TRANSITION = LinearTransition.duration(180);
const HEADER_ROW_ENTERING = FadeIn.duration(160);
const HEADER_ROW_EXITING = FadeOut.duration(100);

export function AndroidSheetHeader(
  props: Omit<Parameters<typeof AndroidScreenHeader>[0], "embedded">,
) {
  return <AndroidScreenHeader {...props} embedded />;
}
