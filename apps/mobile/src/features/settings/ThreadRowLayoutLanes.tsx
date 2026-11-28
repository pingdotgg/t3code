import {
  SIDEBAR_ROW_ITEMS,
  findSidebarRowToken,
  moveSidebarRowToken,
  type SidebarRowLayout,
  type SidebarRowLine,
  type SidebarRowToken,
} from "@t3tools/client-runtime/thread-row-layout";
import * as Haptics from "expo-haptics";
import { useGT, useMessages } from "gt-react-native";
import { useEffectEvent, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { threadRowItemNode, type ThreadRowItemContent } from "../threads/thread-list-v2-items";

const LINES = ["top", "middle", "bottom", "hidden"] as const;
// How far past the first or last line a drop still lands on it.
const DROP_SLOP = 48;

type ViewRef = ComponentRef<typeof View>;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DropTarget {
  readonly line: SidebarRowLine;
  /** The item the dragged one goes before, or null for the end of the line. */
  readonly beforeKey: string | null;
  readonly index: number;
}

function measure(view: ViewRef | undefined) {
  return new Promise<Rect | null>((resolve) => {
    if (!view) return resolve(null);
    view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

/**
 * The thread row lines as lanes of chips. Touch and hold a chip to drag it to another line or
 * position; screen readers get the same moves as actions on each chip.
 */
export function ThreadRowLayoutLanes(props: {
  readonly layout: SidebarRowLayout;
  readonly disabled: boolean;
  readonly edit: (change: (current: SidebarRowLayout) => SidebarRowLayout) => void;
  /** The sample thread each chip shows its item from. */
  readonly sample: ThreadRowItemContent;
  readonly onDragActiveChange: (active: boolean) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { layout, edit } = props;
  const lineLabels: Record<SidebarRowLine, string> = {
    top: gt("Top", { $context: "thread row line" }),
    middle: gt("Middle", { $context: "thread row line" }),
    bottom: gt("Bottom", { $context: "thread row line" }),
    hidden: gt("Hidden", { $context: "thread row item that is not shown" }),
  };
  const itemLabel = (token: SidebarRowToken) =>
    m(SIDEBAR_ROW_ITEMS.find((item) => item.id === token.id)?.label ?? SIDEBAR_ROW_ITEMS[0].label);
  // The thread list does not track terminals.
  const shown = (line: SidebarRowLine) => layout[line].filter((token) => token.id !== "terminals");

  const container = useRef<ViewRef>(null);
  const lanes = useRef(new Map<SidebarRowLine, ViewRef>());
  const chips = useRef(new Map<string, ViewRef>());
  // Measured once when a drag starts; the lanes keep their places until it ends.
  const [rects, setRects] = useState<{
    readonly container: Rect;
    readonly lanes: ReadonlyArray<readonly [SidebarRowLine, Rect]>;
    readonly chips: ReadonlyMap<string, Rect>;
  } | null>(null);
  const [drag, setDrag] = useState<{
    readonly key: string;
    readonly target: DropTarget | null;
  } | null>(null);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const liftedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { rotate: "-2deg" },
      { scale: 1.05 },
    ],
  }));

  const dropTarget = (key: string, dx: number, dy: number): DropTarget | null => {
    const measured = rects;
    const start = measured?.chips.get(key);
    const found = findSidebarRowToken(layout, key);
    if (!measured || !start || !found) return null;
    const point = { x: start.x + start.width / 2 + dx, y: start.y + start.height / 2 + dy };
    let nearest: { line: SidebarRowLine; distance: number } | null = null;
    for (const [line, rect] of measured.lanes) {
      const distance = Math.max(0, rect.y - point.y, point.y - (rect.y + rect.height));
      if (!nearest || distance < nearest.distance) nearest = { line, distance };
    }
    if (!nearest || nearest.distance > DROP_SLOP) return null;
    const line = nearest.line;
    if (line === "hidden" && found.token.id === "title") return null;
    const others = shown(line).filter((token) => token.key !== key);
    const index = others.filter((token) => {
      const rect = measured.chips.get(token.key);
      if (!rect) return false;
      return (
        rect.y + rect.height <= point.y || (point.y >= rect.y && rect.x + rect.width / 2 < point.x)
      );
    }).length;
    return { line, index, beforeKey: others[index]?.key ?? null };
  };

  const startDrag = (key: string) => {
    if (props.disabled) return;
    translateX.set(0);
    translateY.set(0);
    setRects(null);
    setDrag({ key, target: null });
    props.onDragActiveChange(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void Promise.all([
      measure(container.current ?? undefined),
      Promise.all(
        LINES.map(async (line) => [line, await measure(lanes.current.get(line))] as const),
      ),
      Promise.all(
        [...chips.current].map(async ([chipKey, view]) => [chipKey, await measure(view)] as const),
      ),
    ]).then(([containerRect, laneRects, chipRects]) => {
      if (!containerRect) return;
      setRects({
        container: containerRect,
        lanes: laneRects.flatMap(([line, rect]) => (rect ? [[line, rect] as const] : [])),
        chips: new Map(chipRects.flatMap(([chipKey, rect]) => (rect ? [[chipKey, rect]] : []))),
      });
    });
  };
  const moveDrag = (key: string, dx: number, dy: number) => {
    translateX.set(dx);
    translateY.set(dy);
    const target = dropTarget(key, dx, dy);
    setDrag((current) => {
      if (current === null || current.key !== key) return current;
      const previous = current.target;
      const same =
        previous === null || target === null
          ? previous === target
          : previous.line === target.line && previous.index === target.index;
      return same ? current : { key, target };
    });
  };
  const endDrag = (key: string, dx: number, dy: number, cancelled: boolean) => {
    // A touch that never became a drag still finalizes.
    if (drag?.key !== key) return;
    const target = cancelled ? null : dropTarget(key, dx, dy);
    setDrag(null);
    setRects(null);
    props.onDragActiveChange(false);
    if (!target) return;
    edit((current) => {
      const others = current[target.line].filter((token) => token.key !== key);
      const index =
        target.beforeKey === null
          ? others.length
          : others.findIndex((token) => token.key === target.beforeKey);
      return moveSidebarRowToken(current, key, target.line, index === -1 ? others.length : index);
    });
  };

  const dragged = drag ? findSidebarRowToken(layout, drag.key)?.token : undefined;
  const draggedRect = drag ? rects?.chips.get(drag.key) : undefined;
  const slot = draggedRect ? (
    <View
      className="rounded-full border border-dashed border-primary"
      style={{ width: draggedRect.width, height: draggedRect.height }}
    />
  ) : null;

  return (
    <View ref={container}>
      {LINES.map((line, lineIndex) => {
        const tokens = shown(line);
        const target = drag?.target?.line === line ? drag.target : null;
        const others = drag ? tokens.filter((token) => token.key !== drag.key) : tokens;
        return (
          <View
            key={line}
            ref={(view) => {
              if (view) lanes.current.set(line, view);
              else lanes.current.delete(line);
            }}
            className={cn(
              "flex-row gap-2.5 py-3 pl-4 pr-3.5",
              lineIndex > 0 && "border-t border-border-subtle",
              target && "bg-primary/10",
            )}
          >
            <Text className="w-[58px] pt-1.5 text-sm text-foreground-muted">
              {lineLabels[line]}
            </Text>
            <View className="min-w-0 flex-1 flex-row flex-wrap gap-1.5">
              {tokens.length === 0 && !target ? (
                <Text className="py-1.5 text-sm text-foreground-tertiary">
                  {line === "hidden"
                    ? gt("Drag an item here to hide it.")
                    : gt("Drag an item here.", { $context: "empty thread row line" })}
                </Text>
              ) : null}
              {tokens.map((token) => {
                const found = findSidebarRowToken(layout, token.key);
                const index = found?.index ?? 0;
                const label = itemLabel(token);
                const lifted = drag?.key === token.key;
                const lineMoves = (["top", "middle", "bottom"] as const).filter(
                  (other) => other !== line,
                );
                const canHide = line !== "hidden" && token.id !== "title";
                const slotHere = target && others[target.index]?.key === token.key && !lifted;
                return [
                  slotHere ? <View key="slot">{slot}</View> : null,
                  <LaneChip
                    key={token.key}
                    onView={(view) => {
                      if (view) chips.current.set(token.key, view);
                      else chips.current.delete(token.key);
                    }}
                    lifted={lifted}
                    accessibilityLabel={label}
                    accessibilityValue={lineLabels[line]}
                    accessibilityActions={[
                      ...(line !== "hidden" && index > 0
                        ? [{ name: "earlier", label: gt("Move {item} earlier", { item: label }) }]
                        : []),
                      ...(line !== "hidden" && index < layout[line].length - 1
                        ? [{ name: "later", label: gt("Move {item} later", { item: label }) }]
                        : []),
                      ...lineMoves.map((other) => ({
                        name: other,
                        label: gt("Move {item} to {line}", {
                          item: label,
                          line: lineLabels[other],
                        }),
                      })),
                      ...(canHide
                        ? [
                            {
                              name: "hidden",
                              label:
                                token.id === "spacer"
                                  ? gt("Remove {item}", { item: label })
                                  : gt("Hide {item}", { item: label }),
                            },
                          ]
                        : []),
                    ]}
                    onAccessibilityAction={(action) => {
                      if (props.disabled || !found) return;
                      if (action === "earlier" || action === "later") {
                        edit((current) =>
                          moveSidebarRowToken(
                            current,
                            token.key,
                            line,
                            index + (action === "earlier" ? -1 : 1),
                          ),
                        );
                        return;
                      }
                      if (LINES.some((other) => other === action)) {
                        edit((current) =>
                          moveSidebarRowToken(
                            current,
                            token.key,
                            action as SidebarRowLine,
                            Number.POSITIVE_INFINITY,
                          ),
                        );
                      }
                    }}
                    onDragStart={() => startDrag(token.key)}
                    onDragMove={(dx, dy) => moveDrag(token.key, dx, dy)}
                    onDragEnd={(dx, dy, cancelled) => endDrag(token.key, dx, dy, cancelled)}
                  >
                    <LayoutChip token={token} content={props.sample} />
                  </LaneChip>,
                ];
              })}
              {target && target.beforeKey === null ? slot : null}
            </View>
          </View>
        );
      })}
      {dragged && draggedRect && rects ? (
        <Reanimated.View
          pointerEvents="none"
          className="absolute flex-row items-center gap-2"
          style={[
            {
              left: draggedRect.x - rects.container.x,
              top: draggedRect.y - rects.container.y,
            },
            liftedStyle,
          ]}
        >
          <View className="rounded-full bg-grouped-card shadow-md">
            <LayoutChip token={dragged} content={props.sample} />
          </View>
          <View className="rounded-full bg-foreground px-2.5 py-1 shadow-md">
            <Text className="text-xs font-t3-bold text-screen">{itemLabel(dragged)}</Text>
          </View>
        </Reanimated.View>
      ) : null}
    </View>
  );
}

function LaneChip(props: {
  readonly onView: (view: ViewRef | null) => void;
  readonly lifted: boolean;
  readonly accessibilityLabel: string;
  readonly accessibilityValue: string;
  readonly accessibilityActions: ReadonlyArray<{ readonly name: string; readonly label: string }>;
  readonly onAccessibilityAction: (action: string) => void;
  readonly onDragStart: () => void;
  readonly onDragMove: (dx: number, dy: number) => void;
  readonly onDragEnd: (dx: number, dy: number, cancelled: boolean) => void;
  readonly children: ReactNode;
}) {
  const { onView } = props;
  const onStart = useEffectEvent(() => props.onDragStart());
  const onMove = useEffectEvent((dx: number, dy: number) => props.onDragMove(dx, dy));
  const onEnd = useEffectEvent((dx: number, dy: number, cancelled: boolean) =>
    props.onDragEnd(dx, dy, cancelled),
  );
  // The worklets plugin copies the values these callbacks close over when the gesture is built,
  // so the drop reads its translation from the final event rather than a tracked variable.
  const [gesture] = useState(() =>
    Gesture.Pan()
      .activateAfterLongPress(300)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onStart(() => onStart())
      .onUpdate((event) => onMove(event.translationX, event.translationY))
      .onFinalize((event, success) => onEnd(event.translationX, event.translationY, !success)),
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        ref={onView}
        collapsable={false}
        accessible
        accessibilityLabel={props.accessibilityLabel}
        accessibilityValue={{ text: props.accessibilityValue }}
        accessibilityActions={props.accessibilityActions}
        onAccessibilityAction={({ nativeEvent }) =>
          props.onAccessibilityAction(nativeEvent.actionName)
        }
        className={cn("rounded-full", props.lifted && "border border-dashed border-border")}
        style={{ opacity: props.lifted ? 0.45 : 1 }}
      >
        {props.children}
      </View>
    </GestureDetector>
  );
}

/** A small copy of what the item shows in the sample row. */
function LayoutChip(props: {
  readonly token: SidebarRowToken;
  readonly content: ThreadRowItemContent;
}) {
  const gt = useGT();
  const { token, content } = props;
  if (token.id === "spacer") {
    return (
      <View className="h-[30px] flex-row items-center gap-1 rounded-full border border-dashed border-border px-3">
        <SymbolView
          name="arrow.left.arrow.right"
          size={14}
          tintColorClassName="accent-foreground-tertiary"
        />
        <Text className="text-sm text-foreground-muted">
          {gt("Spacer", { $context: "flexible empty space in a layout" })}
        </Text>
      </View>
    );
  }
  return (
    <View className="h-[30px] min-w-10 items-center justify-center rounded-full bg-subtle px-3">
      {token.id === "title" ? (
        <Text
          className="font-t3-medium text-foreground"
          numberOfLines={1}
          style={{ maxWidth: 170 }}
        >
          {content.title}
        </Text>
      ) : (
        <View className="flex-row items-center" style={{ maxWidth: 150 }}>
          {threadRowItemNode(token, content)}
        </View>
      )}
    </View>
  );
}
