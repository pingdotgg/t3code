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
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { withMenuActionIconColors } from "../../lib/menu-action-colors";
import type { MenuProps } from "./Menu.types";

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

export function Menu(props: MenuProps) {
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
        // onPressIn can repeat within one gesture when a finger leaves and re-enters the row.
        menuPress.current.isPreparing = false;
        menuPress.current.suppressPress = menuPress.current.isOpen;
        pendingPress.current = null;
        child.props.onTouchStart?.(event);
      },
      onPress: (event) => {
        // Accessibility clicks lack touch identifiers and must ignore previous touch cancellation.
        const isTouch = typeof event.nativeEvent.identifier === "number";
        if (isTouch ? menuPress.current.suppressPress : menuPress.current.isOpen) {
          return;
        }
        if (isTouch && menuPress.current.isPreparing) {
          // A release can precede native display; let UIKit's display/cancel callback decide its outcome.
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
      // Keep cancellation through finger-up even if the menu dismisses first.
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
