import type { MenuAction, MenuComponentProps } from "@react-native-menu/menu";
import type { ReactNode } from "react";
import { use, useCallback, useEffect, useRef, useState } from "react";
import type { StyleProp, ViewInstance, ViewStyle } from "react-native";
import { BackHandler, Pressable, ScrollView, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";

import { deriveMenuHorizontalPlacement } from "../../lib/menu-placement";
import { WindowHingeContext } from "../../native/window-hinge-context";
import { OverlayPortal } from "./OverlayPortal";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { MenuPopup } from "./MenuPopup";

const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 6;

// Freeze both snapshots at opening so keyboard and screen reflows cannot flip menu direction.
type AnchorSnapshot = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly keyboardWasVisible: boolean;
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
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode | ((open: () => void) => ReactNode);
};

export function AndroidAnchoredMenu(props: AndroidAnchoredMenuProps) {
  const { scale, menuWidth: desiredMenuWidth } = useAndroidControlSizing();
  const [anchor, setAnchor] = useState<AnchorSnapshot | null>(null);
  const [path, setPath] = useState<readonly MenuAction[]>([]);
  const [rootHeight, setRootHeight] = useState<number | null>(null);
  const [overlay, setOverlay] = useState<OverlayFrame | null>(null);
  const windowHinge = use(WindowHingeContext);
  const anchorRef = useRef<ViewInstance>(null);
  const overlayRef = useRef<ViewInstance>(null);

  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const close = useCallback(() => {
    setAnchor(null);
    setPath([]);
    setOverlay(null);
    setRootHeight(null);
  }, []);

  const open = useCallback(() => {
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height, keyboardWasVisible: keyboardVisible });
    });
  }, [keyboardVisible]);

  const measureOverlay = useCallback(() => {
    overlayRef.current?.measureInWindow((x, y, width, height) => {
      setOverlay({ x, y, width, height });
      setRootHeight(height);
    });
  }, []);

  const submenuDepth = path.length;
  useEffect(() => {
    if (anchor === null || !anchor.keyboardWasVisible) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (submenuDepth > 0) {
        setPath((current) => current.slice(0, -1));
      } else {
        close();
      }
      return true;
    });
    return () => subscription.remove();
  }, [anchor, close, submenuDepth]);

  const parent = path[path.length - 1] ?? null;
  const levelActions = (parent?.subactions ?? props.actions).filter(
    (action) => !(action.attributes?.hidden ?? false),
  );

  const local =
    anchor === null || overlay === null
      ? null
      : {
          x: anchor.x - overlay.x,
          y: anchor.y - overlay.y,
          width: anchor.width,
          height: anchor.height,
        };
  const { left, width: menuWidth } =
    local === null || overlay === null
      ? { left: 0, width: desiredMenuWidth }
      : deriveMenuHorizontalPlacement({
          anchorX: local.x,
          anchorWidth: local.width,
          overlayWidth: overlay.width,
          desiredWidth: desiredMenuWidth,
          margin: SCREEN_MARGIN,
          hinge: windowHinge && { x: windowHinge.x - overlay.x, width: windowHinge.width },
        });
  // This in-window menu preserves keyboard focus; subtract the IME area so its items remain tappable.
  const usableBottom =
    overlay === null ? 0 : overlay.height - (keyboardVisible ? keyboardHeight : 0);
  const spaceBelow =
    local === null || overlay === null
      ? 0
      : usableBottom - (local.y + local.height) - ANCHOR_GAP - SCREEN_MARGIN;
  const spaceAbove = local === null ? 0 : local.y - ANCHOR_GAP - SCREEN_MARGIN;
  const opensDown = spaceBelow >= 280 || spaceBelow >= spaceAbove;
  const maxHeight = Math.min(opensDown ? spaceBelow : spaceAbove, 480);
  const placeable = local !== null && rootHeight !== null;

  const { onPressAction } = props;
  const onPressItem = useCallback(
    (action: MenuAction) => {
      if ((action.subactions?.length ?? 0) > 0) {
        setPath((current) => [...current, action]);
        return;
      }
      close();
      if (action.id !== undefined) {
        onPressAction?.({
          nativeEvent: { event: action.id },
        } as Parameters<NonNullable<MenuComponentProps["onPressAction"]>>[0]);
      }
    },
    [close, onPressAction],
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
            {!placeable || local === null ? null : !anchor.keyboardWasVisible ? (
              <MenuPopup
                // Compose aligns to the trigger's start if it fits; hinge-safe triggers keep menus on their side.
                anchor={windowHinge ? { ...local, x: left, width: menuWidth } : local}
                menuWidth={menuWidth}
                actions={levelActions}
                title={props.title}
                parent={parent}
                onPress={onPressItem}
                onBack={() => setPath((current) => current.slice(0, -1))}
                onClose={close}
              />
            ) : (
              <Animated.View
                entering={FadeIn.duration(120)}
                className="absolute overflow-hidden bg-card-alt shadow-md"
                style={{
                  left,
                  maxHeight,
                  width: menuWidth,
                  borderRadius: 4 * scale,
                  ...(opensDown
                    ? { top: local.y + local.height + ANCHOR_GAP }
                    : { bottom: (rootHeight ?? 0) - local.y + ANCHOR_GAP }),
                }}
              >
                {/* Compose DropdownMenu takes focus; in-window editor menus preserve the keyboard. */}

                {/* The first item tap must act while the keyboard is open. */}
                <ScrollView
                  contentContainerStyle={{ paddingVertical: 7 * scale }}
                  bounces={false}
                  keyboardShouldPersistTaps="always"
                  showsVerticalScrollIndicator={false}
                >
                  <MenuPopup
                    inline
                    anchor={local}
                    menuWidth={menuWidth}
                    actions={levelActions}
                    title={props.title}
                    parent={parent}
                    onPress={onPressItem}
                    onBack={() => setPath((current) => current.slice(0, -1))}
                    onClose={close}
                  />
                </ScrollView>
              </Animated.View>
            )}
          </View>
        </OverlayPortal>
      )}
    </>
  );
}
