import { Pressable, View } from "react-native";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { Menu } from "./Menu";
import type { SplitButtonProps } from "./SplitButton.types";

export function SplitButton(props: SplitButtonProps) {
  const active = !props.disabled;
  const menuEnabled = props.actions.some((action) => !action.attributes?.disabled);
  return (
    <View
      className={`flex-row overflow-hidden rounded-xl border-continuous ${active ? "bg-prominent-action" : "bg-subtle-strong"}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel ?? props.label}
        accessibilityState={{ disabled: Boolean(props.disabled), busy: Boolean(props.loading) }}
        disabled={props.disabled}
        onPress={props.onPress}
        className="min-h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 px-3 py-2 active:opacity-70"
      >
        {props.loading ? (
          <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : props.icon ? (
          <SymbolView
            name={props.icon}
            size={16}
            tintColorClassName={active ? "accent-prominent-action-foreground" : "accent-icon-muted"}
          />
        ) : null}
        <AppText
          className={`shrink text-center text-sm font-t3-semibold ${active ? "text-prominent-action-foreground" : "text-foreground-muted"}`}
        >
          {props.label}
        </AppText>
      </Pressable>
      {props.actions.length > 0 ? (
        <View pointerEvents={menuEnabled ? "auto" : "none"}>
          <Menu
            title={props.menuTitle}
            actions={props.actions}
            onPressAction={({ nativeEvent }) => props.onPressAction(nativeEvent.event)}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={props.menuTitle}
              accessibilityState={{ disabled: !menuEnabled }}
              disabled={!menuEnabled}
              className="min-h-11 w-11 items-center justify-center border-l border-border-subtle"
            >
              <SymbolView
                name="chevron.down"
                size={13}
                tintColorClassName={
                  active ? "accent-prominent-action-foreground" : "accent-icon-muted"
                }
              />
            </Pressable>
          </Menu>
        </View>
      ) : null}
    </View>
  );
}
