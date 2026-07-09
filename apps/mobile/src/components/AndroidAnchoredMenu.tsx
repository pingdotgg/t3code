import type { MenuAction, MenuComponentProps } from "@react-native-menu/menu";
import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { BackHandler, Pressable, ScrollView, useColorScheme, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";

import { appBlurTargetRef } from "../lib/appBlurTarget";
import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { type AppSymbolName, SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { OverlayPortal } from "./OverlayPortal";

const MENU_WIDTH = 250;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 6;

// Anchor position is snapshotted in window coordinates when the menu opens;
// the overlay root measures itself the same way, and the menu is placed from
// the delta. Both snapshots are taken at open time so later reflows (keyboard
// show/hide, screen transitions) can't flip an opens-up menu to opens-down
// mid-presentation.
type AnchorSnapshot = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type OverlayFrame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type AndroidAnchoredMenuProps = {
  readonly actions: readonly MenuAction[];
  readonly title?: string;
  readonly onPressAction?: MenuComponentProps["onPressAction"];
  /** Applied to the anchor wrapper — call sites flex these to fill toolbars. */
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
  /**
   * Plain children open the menu on tap (the wrapper owns the press). A
   * render function keeps the children interactive and hands them `open` to
   * call from their own gesture — e.g. a row that selects on tap and opens
   * this menu on long-press.
   */
  readonly children: ReactNode | ((open: () => void) => ReactNode);
};

/**
 * Token-styled anchored dropdown for Android, drop-in for the subset of the
 * MenuView contract the app uses (actions with state/subtitle/image/
 * attributes, one level of subactions). The native AppCompat PopupMenu caps
 * out on theming — stock animation, item metrics, and submenu chrome — so
 * ControlPillMenu renders this instead on Android while iOS keeps the native
 * UIMenu. Styling follows the themed native popup (12dp radius, plain rows,
 * trailing check glyph); submenus drill in under a muted parent-title header.
 */
export function AndroidAnchoredMenu(props: AndroidAnchoredMenuProps) {
  const [anchor, setAnchor] = useState<AnchorSnapshot | null>(null);
  const [path, setPath] = useState<readonly MenuAction[]>([]);
  // Height of the modal's root view, in the modal's own coordinate space.
  // Menus that flip above their anchor are pinned by their BOTTOM edge
  // (bottom = rootHeight - anchorTop), so drill-in height changes grow
  // upward without any re-measurement — positioning them via `top` from the
  // menu's measured height made every submenu transition settle over two
  // frames and jitter.
  const [rootHeight, setRootHeight] = useState<number | null>(null);
  // Window frame of the overlay root, measured on layout. Anchor coordinates
  // are converted into this frame, so the menu lands correctly no matter
  // where the portal host sits (status bar, keyboard resize, etc.).
  const [overlay, setOverlay] = useState<OverlayFrame | null>(null);
  const anchorRef = useRef<View>(null);
  const overlayRef = useRef<View>(null);

  const isDarkMode = useColorScheme() === "dark";
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const rippleColor = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-icon");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const dangerColor = useThemeColor("--color-danger-foreground");

  const close = useCallback(() => {
    setAnchor(null);
    setPath([]);
    setOverlay(null);
    setRootHeight(null);
  }, []);

  const open = useCallback(() => {
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
    });
  }, []);

  const measureOverlay = useCallback(() => {
    overlayRef.current?.measureInWindow((x, y, width, height) => {
      setOverlay({ x, y, width, height });
      setRootHeight(height);
    });
  }, []);

  // The dropdown renders in-window (no Modal takes focus), so the hardware
  // back gesture needs explicit handling while it is open.
  useEffect(() => {
    if (anchor === null) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [anchor, close]);

  const parent = path.length > 0 ? path[path.length - 1] : null;
  const levelActions = (parent?.subactions ?? props.actions).filter(
    (action) => !(action.attributes?.hidden ?? false),
  );

  // Anchor in overlay-local coordinates (both measured in window space).
  const local =
    anchor === null || overlay === null
      ? null
      : {
          x: anchor.x - overlay.x,
          y: anchor.y - overlay.y,
          width: anchor.width,
          height: anchor.height,
        };
  const preferredLeft =
    local === null || overlay === null
      ? 0
      : local.x + local.width / 2 <= overlay.width / 2
        ? local.x
        : local.x + local.width - MENU_WIDTH;
  const left =
    overlay === null
      ? 0
      : Math.min(
          Math.max(preferredLeft, SCREEN_MARGIN),
          overlay.width - MENU_WIDTH - SCREEN_MARGIN,
        );
  // The keyboard stays up while the menu is open (in-window overlay, no
  // focus change), so the space it covers is not usable — without this the
  // composer-pill menus "open down" into the IME and can't be tapped.
  const usableBottom =
    overlay === null ? 0 : overlay.height - (keyboardVisible ? keyboardHeight : 0);
  const spaceBelow =
    local === null || overlay === null
      ? 0
      : usableBottom - (local.y + local.height) - ANCHOR_GAP - SCREEN_MARGIN;
  const spaceAbove = local === null ? 0 : local.y - ANCHOR_GAP - SCREEN_MARGIN;
  const opensDown = spaceBelow >= 280 || spaceBelow >= spaceAbove;
  const maxHeight = Math.min(opensDown ? spaceBelow : spaceAbove, 480);
  // The menu needs the overlay frame before it can be placed; it stays
  // unmounted for that first frame so the fade-in plays at the final position.
  const placeable = local !== null && rootHeight !== null;

  const onPressItem = useCallback(
    (action: MenuAction) => {
      if ((action.subactions?.length ?? 0) > 0) {
        setPath((current) => [...current, action]);
        return;
      }
      close();
      if (action.id !== undefined) {
        props.onPressAction?.({
          nativeEvent: { event: action.id },
        } as Parameters<NonNullable<MenuComponentProps["onPressAction"]>>[0]);
      }
    },
    [close, props.onPressAction],
  );

  return (
    <>
      {typeof props.children === "function" ? (
        <View ref={anchorRef} collapsable={false} className={props.className} style={props.style}>
          {props.children(open)}
        </View>
      ) : (
        <Pressable
          ref={anchorRef}
          accessibilityRole="button"
          className={props.className}
          collapsable={false}
          style={props.style}
          onPress={open}
        >
          <View pointerEvents="none">{props.children}</View>
        </Pressable>
      )}
      {anchor === null ? null : (
        <OverlayPortal>
          <View
            ref={overlayRef}
            collapsable={false}
            className="absolute inset-0"
            onLayout={measureOverlay}
          >
            <Pressable accessible={false} className="absolute inset-0" onPress={close} />
            {!placeable || local === null ? null : (
              <Animated.View
                entering={FadeIn.duration(120)}
                className="absolute w-[250px] overflow-hidden rounded-[12px] border border-border shadow-2xl"
                style={{
                  left,
                  maxHeight,
                  ...(opensDown
                    ? { top: local.y + local.height + ANCHOR_GAP }
                    : { bottom: (rootHeight ?? 0) - local.y + ANCHOR_GAP }),
                }}
              >
                {/* Frosted backdrop: blur of the app content behind the menu,
                  washed with the translucent card tone so rows keep contrast. */}
                <BlurView
                  blurMethod="dimezisBlurView"
                  blurTarget={appBlurTargetRef}
                  intensity={40}
                  tint={isDarkMode ? "dark" : "light"}
                  className="absolute inset-0"
                />
                <View className="absolute inset-0 bg-card-translucent" />
                {/* keyboardShouldPersistTaps: the menu often opens over an
                  active editor; the first item tap must act, not just
                  dismiss the keyboard. */}
                <ScrollView
                  bounces={false}
                  keyboardShouldPersistTaps="always"
                  showsVerticalScrollIndicator={false}
                >
                  {parent !== null ? (
                    // Muted parent title as the submenu header; tapping it
                    // steps back, but it reads as a label, not a button.
                    <Pressable
                      className="px-3.5 pb-1 pt-2.5"
                      onPress={() => setPath((current) => current.slice(0, -1))}
                    >
                      <Text className="text-xs font-t3-bold text-foreground-muted">
                        {parent.title}
                      </Text>
                    </Pressable>
                  ) : props.title ? (
                    <>
                      <View className="px-3.5 py-2">
                        <Text className="text-center text-xs text-foreground-muted">
                          {props.title}
                        </Text>
                      </View>
                      <View className="h-px bg-border" />
                    </>
                  ) : null}
                  {levelActions.map((action, index) => {
                    const destructive = action.attributes?.destructive ?? false;
                    const disabled = action.attributes?.disabled ?? false;
                    const hasSubmenu = (action.subactions?.length ?? 0) > 0;
                    return (
                      <Pressable
                        key={action.id ?? `${index}-${action.title}`}
                        android_ripple={{ color: rippleColor }}
                        disabled={disabled}
                        className={cn(
                          "min-h-11 flex-row items-center gap-2.5 px-3.5 py-2.5",
                          disabled && "opacity-45",
                        )}
                        onPress={() => onPressItem(action)}
                      >
                        <View className="flex-1 gap-0.5">
                          <Text
                            className={cn(
                              // Same face as the pill labels that open these menus.
                              "text-sm font-t3-bold",
                              destructive && "text-danger-foreground",
                            )}
                          >
                            {action.title}
                          </Text>
                          {action.subtitle ? (
                            <Text className="text-xs leading-snug text-foreground-muted">
                              {action.subtitle}
                            </Text>
                          ) : null}
                        </View>
                        {hasSubmenu ? (
                          <SymbolView
                            name="chevron.right"
                            size={13}
                            tintColor={iconSubtleColor}
                            type="monochrome"
                          />
                        ) : action.state === "on" ? (
                          <SymbolView
                            name="checkmark"
                            size={15}
                            tintColor={iconColor}
                            type="monochrome"
                          />
                        ) : action.image ? (
                          <SymbolView
                            name={action.image as AppSymbolName}
                            size={15}
                            tintColor={destructive ? dangerColor : iconColor}
                            type="monochrome"
                          />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </Animated.View>
            )}
          </View>
        </OverlayPortal>
      )}
    </>
  );
}
