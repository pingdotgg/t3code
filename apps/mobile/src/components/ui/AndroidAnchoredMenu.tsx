import type { MenuAction, MenuComponentProps } from "@react-native-menu/menu";
import type { ReactNode } from "react";
import { use, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { StyleProp, ViewInstance, ViewStyle } from "react-native";
import { BackHandler, Pressable, ScrollView, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";

import type { VerticalHinge } from "../../lib/layout";
import { deriveMenuHorizontalPlacement } from "../../lib/menu-placement";
import { WindowHingeContext } from "../../native/window-hinge-context";
import { OverlayPortal } from "./OverlayPortal";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { MenuPopup } from "./MenuPopup";

const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 6;

// Both snapshots are taken at open time so later reflows (keyboard show/hide,
// screen transitions) can't flip an opens-up menu to opens-down
// mid-presentation. The anchor and hinge are re-measured together once the
// workspace panes stop moving, since a hinge change moves the anchor with its pane.
type AnchorSnapshot = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hinge: VerticalHinge | null;
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
  const { hinge: windowHinge, panesSettled } = use(WindowHingeContext);
  const anchorRef = useRef<ViewInstance>(null);
  const overlayRef = useRef<ViewInstance>(null);
  const measuringAnchor = useRef(false);
  const remeasurePending = useRef(false);
  // Closing invalidates measurements still in flight, so a late one can't reopen the menu.
  const presentation = useRef(0);

  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const close = useCallback(() => {
    presentation.current += 1;
    measuringAnchor.current = false;
    remeasurePending.current = false;
    setAnchor(null);
    setPath([]);
    setOverlay(null);
    setRootHeight(null);
  }, []);

  const measureAnchor = useCallback(
    (keyboardWasVisible: boolean) => {
      measuringAnchor.current = true;
      const measuredFor = presentation.current;
      anchorRef.current?.measureInWindow((x, y, width, height) => {
        if (measuredFor !== presentation.current) return;
        measuringAnchor.current = false;
        setAnchor({ x, y, width, height, hinge: windowHinge, keyboardWasVisible });
      });
    },
    [windowHinge],
  );
  const open = useCallback(() => measureAnchor(keyboardVisible), [measureAnchor, keyboardVisible]);

  const remeasureAnchor = useEffectEvent(() => {
    if (anchor !== null) measureAnchor(anchor.keyboardWasVisible);
    // A menu opened just before the panes settled is still measuring against the old hinge.
    else if (measuringAnchor.current) remeasurePending.current = true;
  });
  // Only a pane settle triggers this; the effect event reads the current anchor and hinge.
  useEffect(() => remeasureAnchor(), [panesSettled]);
  const flushPendingRemeasure = useEffectEvent(() => {
    if (anchor === null || !remeasurePending.current) return;
    remeasurePending.current = false;
    measureAnchor(anchor.keyboardWasVisible);
  });
  useEffect(() => flushPendingRemeasure(), [anchor]);

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

  const hinge = anchor?.hinge ?? null;
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
          hinge: hinge && { x: hinge.x - overlay.x, width: hinge.width },
        });
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
            {!placeable || local === null ? null : !anchor.keyboardWasVisible ? (
              <MenuPopup
                // Compose aligns its dropdown to the trigger's start whenever it fits, so a
                // trigger at the hinge-safe position keeps the menu on the anchor's side.
                anchor={hinge ? { ...local, x: left, width: menuWidth } : local}
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
                {/* Compose DropdownMenu takes popup focus in the pinned Expo UI version.
                    Keep editor menus in-window so opening one preserves the keyboard. */}

                {/* keyboardShouldPersistTaps: the menu often opens over an
                  active editor; the first item tap must act, not just
                  dismiss the keyboard. */}
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
