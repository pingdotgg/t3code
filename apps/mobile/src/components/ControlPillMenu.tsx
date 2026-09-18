import { MenuView } from "@react-native-menu/menu";
import {
  cloneElement,
  isValidElement,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactElement,
} from "react";
import type { ColorValue, PressableProps } from "react-native";
import { withUniwind } from "uniwind";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { withMenuActionIconColors } from "../lib/menu-action-colors";
import type { ControlPillMenuProps } from "./ControlPillMenu.types";

const ThemedMenuView = withUniwind(
  function NativeMenuView({
    iconColor,
    destructiveIconColor,
    ...props
  }: ComponentProps<typeof MenuView> & {
    readonly iconColor?: ColorValue;
    readonly destructiveIconColor?: ColorValue;
  }) {
    const actions = useMemo(
      () =>
        withMenuActionIconColors(props.actions, {
          icon: iconColor,
          destructiveIcon: destructiveIconColor,
        }),
      [props.actions, iconColor, destructiveIconColor],
    );
    return <MenuView {...props} actions={actions} />;
  },
  {
    iconColor: { fromClassName: "iconColorClassName", styleProperty: "accentColor" },
    destructiveIconColor: {
      fromClassName: "destructiveIconColorClassName",
      styleProperty: "accentColor",
    },
  },
);

export function ControlPillMenu(props: ControlPillMenuProps) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const menuPress = useRef({ isPreparing: false, isOpen: false, suppressPress: false });
  const pendingPress = useRef<(() => void) | null>(null);

  const { className: _className, ...menuProps } = props;
  let children = menuProps.children;
  if (props.shouldOpenOnLongPress && isValidElement(children)) {
    const child = children as ReactElement<Pick<PressableProps, "onTouchStart" | "onPress">>;
    children = cloneElement(child, {
      onTouchStart: (event) => {
        // Reset for a new touch, not onPressIn, which also fires when a
        // finger moves out of the row and back during the same gesture.
        menuPress.current.isPreparing = false;
        menuPress.current.suppressPress = menuPress.current.isOpen;
        pendingPress.current = null;
        child.props.onTouchStart?.(event);
      },
      onPress: (event) => {
        // Accessibility clicks have no touch identifier and must not inherit
        // cancellation from a previous physical gesture.
        const isTouch = typeof event.nativeEvent.identifier === "number";
        if (isTouch ? menuPress.current.suppressPress : menuPress.current.isOpen) {
          return;
        }
        if (isTouch && menuPress.current.isPreparing) {
          // A release can arrive between native menu preparation and display.
          // Let UIKit's display/cancel callback decide this press's outcome.
          event.persist();
          pendingPress.current = () => child.props.onPress?.(event);
          return;
        }
        child.props.onPress?.(event);
      },
    });
    menuProps.onMenuInteractionStart = () => {
      menuPress.current.isPreparing = true;
      props.onMenuInteractionStart?.();
    };
    menuProps.onOpenMenu = () => {
      menuPress.current.isPreparing = false;
      menuPress.current.isOpen = true;
      menuPress.current.suppressPress = true;
      pendingPress.current = null;
      props.onOpenMenu?.();
    };
    menuProps.onCloseMenu = () => {
      menuPress.current.isPreparing = false;
      menuPress.current.isOpen = false;
      // Keep this gesture cancelled even if dismissal precedes finger-up.
      // A separate JS long-press timer would also swallow holds that never
      // open the native menu.
      const press = pendingPress.current;
      pendingPress.current = null;
      props.onCloseMenu?.();
      if (!menuPress.current.suppressPress) {
        press?.();
      }
    };
  }
  return (
    <ThemedMenuView
      {...menuProps}
      iconColorClassName="accent-icon"
      destructiveIconColorClassName="accent-danger-foreground"
      themeVariant={isDarkMode ? "dark" : "light"}
    >
      {children}
    </ThemedMenuView>
  );
}
