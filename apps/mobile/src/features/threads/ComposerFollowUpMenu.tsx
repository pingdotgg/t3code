import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";
import * as Haptics from "expo-haptics";
import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { OverlayPortal } from "../../components/OverlayPortal";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import type { ComposerSendPresentation } from "./composerSendPresentation";

const MENU_WIDTH = 260;
const MENU_MARGIN = 12;

/** iOS send choices stay in the editor's window so presenting them preserves keyboard focus. */
export function ComposerFollowUpMenu(props: {
  readonly accessibilityLabel: string;
  readonly icon: ComposerSendPresentation["icon"];
  readonly actions: ReadonlyArray<{
    readonly id: ActiveTurnComposerAction;
    readonly title: string;
    readonly subtitle: string;
  }>;
  readonly selectedAction: ActiveTurnComposerAction;
  readonly onSend: (action?: ActiveTurnComposerAction) => void;
}) {
  const anchorRef = useRef<View>(null);
  const overlayRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null);
  const [overlay, setOverlay] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const close = useCallback(() => {
    setAnchor(null);
    setOverlay(null);
  }, []);
  useFocusEffect(useCallback(() => close, [close]));
  const open = useCallback(() => {
    anchorRef.current?.measureInWindow((x, y, width) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setAnchor({ right: x + width, top: y });
    });
  }, []);

  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <ComposerActionButton
          accessibilityLabel={props.accessibilityLabel}
          icon={props.icon}
          variant="primary"
          onPress={() => props.onSend()}
          onLongPress={open}
        />
      </View>
      {anchor === null ? null : (
        <OverlayPortal>
          <View
            ref={overlayRef}
            collapsable={false}
            className="absolute inset-0"
            onLayout={() =>
              overlayRef.current?.measureInWindow((x, y, width, height) =>
                setOverlay({ x, y, width, height }),
              )
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss send choices"
              className="absolute inset-0"
              onPress={close}
            />
            {overlay === null ? null : (
              <View
                accessibilityViewIsModal
                onAccessibilityEscape={close}
                className="absolute overflow-hidden rounded-2xl border border-border bg-card-alt shadow-lg"
                style={{
                  width: Math.min(MENU_WIDTH, overlay.width - MENU_MARGIN * 2),
                  left: Math.max(
                    MENU_MARGIN,
                    Math.min(
                      anchor.right - overlay.x - MENU_WIDTH,
                      overlay.width - MENU_WIDTH - MENU_MARGIN,
                    ),
                  ),
                  bottom: overlay.height - (anchor.top - overlay.y) + 6,
                }}
              >
                {props.actions.map((action) => (
                  <Pressable
                    key={action.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${action.title}. ${action.subtitle}`}
                    className="flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
                    onPress={() => {
                      close();
                      props.onSend(action.id);
                    }}
                  >
                    <View className="w-4">
                      {action.id === props.selectedAction ? (
                        <SymbolView
                          name="checkmark"
                          size={16}
                          tintColorClassName="accent-foreground"
                        />
                      ) : null}
                    </View>
                    <View className="flex-1 gap-1">
                      <Text className="text-sm font-t3-medium text-foreground">{action.title}</Text>
                      <Text className="text-xs text-foreground-muted">{action.subtitle}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        </OverlayPortal>
      )}
    </>
  );
}
