import type { MenuAction, MenuComponentProps } from "@react-native-menu/menu";
import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";

import { appBlurTargetRef } from "../lib/appBlurTarget";
import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { type AppSymbolName, SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";

const MENU_WIDTH = 250;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 6;

// The window metrics are snapshotted alongside the anchor when the menu
// opens: the keyboard often dismisses right after (the anchor pills sit on
// the composer), and a live useWindowDimensions would re-flow the menu
// mid-presentation — flipping it from opens-up to opens-down and making it
// flicker or jump.
type AnchorSnapshot = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
};

export type AndroidAnchoredMenuProps = {
  readonly actions: readonly MenuAction[];
  readonly title?: string;
  readonly onPressAction?: MenuComponentProps["onPressAction"];
  /** Applied to the anchor wrapper — call sites flex these to fill toolbars. */
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
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
  const anchorRef = useRef<View>(null);

  const isDarkMode = useColorScheme() === "dark";
  const rippleColor = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-icon");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const dangerColor = useThemeColor("--color-danger-foreground");

  const close = useCallback(() => {
    setAnchor(null);
    setPath([]);
  }, []);

  const open = useCallback(() => {
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      const window = Dimensions.get("window");
      // measureInWindow reports y excluding the status bar, but the
      // translucent modal's coordinate space starts at the true screen top —
      // without this the menu floats above its anchor by the inset height.
      setAnchor({
        x,
        y: y + (StatusBar.currentHeight ?? 0),
        width,
        height,
        windowWidth: window.width,
        windowHeight: window.height,
      });
    });
  }, []);

  const parent = path.length > 0 ? path[path.length - 1] : null;
  const levelActions = (parent?.subactions ?? props.actions).filter(
    (action) => !(action.attributes?.hidden ?? false),
  );

  const preferredLeft =
    anchor === null
      ? 0
      : anchor.x + anchor.width / 2 <= anchor.windowWidth / 2
        ? anchor.x
        : anchor.x + anchor.width - MENU_WIDTH;
  const left =
    anchor === null
      ? 0
      : Math.min(
          Math.max(preferredLeft, SCREEN_MARGIN),
          anchor.windowWidth - MENU_WIDTH - SCREEN_MARGIN,
        );
  const spaceBelow =
    anchor === null
      ? 0
      : anchor.windowHeight - (anchor.y + anchor.height) - ANCHOR_GAP - SCREEN_MARGIN;
  const spaceAbove = anchor === null ? 0 : anchor.y - ANCHOR_GAP - SCREEN_MARGIN;
  const opensDown = spaceBelow >= 280 || spaceBelow >= spaceAbove;
  const maxHeight = Math.min(opensDown ? spaceBelow : spaceAbove, 480);
  // Flipped-up menus need the root height before they can be placed; they
  // stay unmounted for that first frame so the fade-in plays at the final
  // position.
  const placeable = opensDown || rootHeight !== null;

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
      <Pressable
        ref={anchorRef}
        accessibilityRole="button"
        collapsable={false}
        style={props.style}
        onPress={open}
      >
        <View pointerEvents="none">{props.children}</View>
      </Pressable>
      <Modal
        visible={anchor !== null}
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        animationType="none"
        onRequestClose={close}
      >
        <View
          className="flex-1"
          onLayout={(event) => setRootHeight(event.nativeEvent.layout.height)}
        >
          <Pressable accessible={false} className="absolute inset-0" onPress={close} />
          {anchor === null || !placeable ? null : (
            <Animated.View
              entering={FadeIn.duration(120)}
              className="absolute overflow-hidden rounded-[12px] border border-border"
              style={{
                width: MENU_WIDTH,
                left,
                maxHeight,
                elevation: 16,
                shadowColor: "#000000",
                ...(opensDown
                  ? { top: anchor.y + anchor.height + ANCHOR_GAP }
                  : { bottom: (rootHeight ?? 0) - anchor.y + ANCHOR_GAP }),
              }}
            >
              {/* Frosted backdrop: blur of the app content behind the menu,
                  washed with the translucent card tone so rows keep contrast. */}
              <BlurView
                blurMethod="dimezisBlurView"
                blurTarget={appBlurTargetRef}
                intensity={40}
                tint={isDarkMode ? "dark" : "light"}
                style={StyleSheet.absoluteFill}
              />
              <View className="absolute inset-0 bg-card-translucent" />
              <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
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
                      className="min-h-11 flex-row items-center gap-2.5 px-3.5 py-2.5"
                      style={{ opacity: disabled ? 0.45 : 1 }}
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
      </Modal>
    </>
  );
}
