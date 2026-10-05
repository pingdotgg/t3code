import type { LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { View, type ViewInstance } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Reanimated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { getPendingThreadOrder, threadDropBusyAtom } from "../../state/thread-order";
import { environmentThreadShells } from "../../state/threads";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import {
  completeThreadDragGeometry,
  resolveThreadDrop,
  threadDragGapOffset,
  threadDropInsertionOffset,
  type ThreadDragRow,
  type ThreadDropDestination,
} from "./threadDragGap";
import {
  getThreadListV2OrderedSection,
  isThreadListV2ListItem,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { createThreadMovePlanner, threadDragAction, type ThreadDragSection } from "./threadOrder";

// Long enough that a flick still scrolls, short enough to beat the long-press
// menu: holding still opens the menu, moving after the hold lifts the row.
const HOLD_MS = 200;
const PRESS_SLOP = 10;
const LIFT_SLOP = 6;
const AUTO_SCROLL_EDGE = 56;
// Matches the lists' estimatedItemSize for rows LegendList has not measured.
const ESTIMATED_ROW_HEIGHT = 72;

interface DragLayout {
  readonly sourceKey: string;
  readonly sourceOffset: number;
  readonly sourceHeight: number;
  readonly insertionOffset: number;
  readonly offsets: Readonly<Record<string, number>>;
}

interface Drag {
  readonly itemKey: string;
  readonly thread: EnvironmentThreadShell;
  readonly section: ThreadDragSection;
  readonly rows: readonly ThreadDragRow[];
  readonly offsets: Readonly<Record<string, number>>;
  readonly sourceOffset: number;
  readonly sourceHeight: number;
  readonly grabY: number;
  readonly startAbsoluteY: number;
  readonly startScroll: number;
  readonly canDrop: (destination: ThreadDropDestination) => boolean;
  absoluteY: number;
  scroll: number;
  destination: ThreadDropDestination | null;
}

interface DragPreview {
  readonly title: string;
  readonly height: number;
  readonly action: string | null;
}

interface ThreadListDragController {
  canStart(): boolean;
  arm(): void;
  disarm(): void;
  start(itemKey: string, thread: EnvironmentThreadShell, grabY: number, absoluteY: number): void;
  move(absoluteY: number): void;
  end(cancelled: boolean): void;
}

const ThreadListDragContext = createContext<{
  readonly controller: ThreadListDragController;
  readonly layout: SharedValue<DragLayout | null>;
} | null>(null);

function dragSection(item: ThreadListV2ListItem): ThreadDragSection | null {
  if (item.type === "v2-settled-shelf") return "settled";
  if (item.type !== "v2-thread") return null;
  if (item.item.snoozed) return "snoozed";
  if (item.item.variant === "slim") return "settled";
  return item.item.pinned ? "pinned" : "active";
}

/** Plan against the complete sections, exactly as the drop's `moveThread` will. */
function createDropPolicy(
  thread: EnvironmentThreadShell,
  section: ThreadDragSection,
  workingShelfEnabled: boolean,
) {
  const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const environmentsWith = (supported: (id: EnvironmentThreadShell["environmentId"]) => boolean) =>
    new Set([...configs.keys()].filter(supported));
  const capabilities = (id: EnvironmentThreadShell["environmentId"]) =>
    configs.get(id)?.environment.capabilities;
  const shared = {
    threads: shells,
    now: new Date().toISOString(),
    queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
    settlementEnvironmentIds: environmentsWith((id) => capabilities(id)?.threadSettlement === true),
    snoozeEnvironmentIds: environmentsWith((id) => capabilities(id)?.threadSnooze === true),
  };
  const planner = (destination: "pinned" | "active") =>
    createThreadMovePlanner({
      ordered: getThreadListV2OrderedSection({ ...shared, section: destination }),
      allThreads: shells,
      section: destination,
      // The Working beta orders Active by time, so only pins take a position.
      reorderableEnvironmentIds: environmentsWith((id) =>
        destination === "pinned"
          ? capabilities(id)?.threadPinReorder === true
          : !workingShelfEnabled && capabilities(id)?.threadActiveReorder === true,
      ),
    });
  const planners = { pinned: planner("pinned"), active: planner("active") };
  const own = capabilities(thread.environmentId);
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  return (destination: ThreadDropDestination) => {
    const target = destination.section;
    if (target === undefined) return false;
    if (target === "settled") return own?.threadSettlement === true;
    if (
      target !== section &&
      (target === "pinned" || section === "pinned") &&
      own?.threadPinning !== true
    )
      return false;
    return planners[target](threadKey, destination) !== null;
  };
}

/**
 * Hosts press-and-drag arrangement for a thread list. Rows join through
 * `useThreadListDragTarget`; hit testing uses the layout from when the drag
 * began while rows slide aside to show the insertion gap.
 */
export function ThreadListDragSurface(props: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly items: readonly { readonly type: string; readonly key: string }[];
  readonly workingShelfEnabled: boolean;
  /** Content hidden under translucent chrome, kept out of the auto-scroll edges. */
  readonly edgeInsets?: { readonly top: number; readonly bottom: number };
  readonly onMoveThread: (
    thread: EnvironmentThreadShell,
    destination: ThreadDropDestination,
  ) => Promise<boolean>;
  readonly children: (scrollEnabled: boolean) => ReactNode;
}) {
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const layout = useSharedValue<DragLayout | null>(null);
  const previewTop = useSharedValue(0);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const container = useRef<ViewInstance>(null);
  const geometry = useRef({ top: 0, height: 0 });
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const controller = useMemo<ThreadListDragController>(() => {
    const stopScrolling = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    const clear = () => {
      stopScrolling();
      drag.current = null;
      layout.set(null);
      setPreview(null);
    };
    const retarget = () => {
      const current = drag.current;
      if (current === null) return;
      const contentY =
        current.sourceOffset +
        current.grabY +
        current.absoluteY -
        current.startAbsoluteY +
        current.scroll -
        current.startScroll;
      const destination = resolveThreadDrop({
        rows: current.rows,
        contentY,
        source: {
          threadKey: scopedThreadKey(current.thread.environmentId, current.thread.id),
          section: current.section,
        },
        canDrop: current.canDrop,
      });
      if (
        destination?.section === current.destination?.section &&
        destination?.targetId === current.destination?.targetId &&
        destination?.placement === current.destination?.placement
      )
        return;
      current.destination = destination;
      layout.set({
        sourceKey: current.itemKey,
        sourceOffset: current.sourceOffset,
        sourceHeight: current.sourceHeight,
        insertionOffset: threadDropInsertionOffset(current.rows, destination, current.sourceOffset),
        offsets: current.offsets,
      });
      setPreview({
        title: current.thread.title,
        height: current.sourceHeight,
        action:
          destination?.section === undefined
            ? null
            : threadDragAction(current.section, destination.section),
      });
    };
    const autoScroll = () => {
      let last = performance.now();
      const tick = () => {
        const current = drag.current;
        const list = latest.current.listRef.current;
        if (current === null || list === null) return;
        const now = performance.now();
        const elapsed = Math.min(now - last, 32);
        last = now;
        const insets = latest.current.edgeInsets ?? { top: 0, bottom: 0 };
        const y = current.absoluteY - geometry.current.top;
        const top = insets.top + AUTO_SCROLL_EDGE;
        const bottom = geometry.current.height - insets.bottom - AUTO_SCROLL_EDGE;
        const speed =
          y < top
            ? -Math.min(1, (top - y) / AUTO_SCROLL_EDGE)
            : y > bottom
              ? Math.min(1, (y - bottom) / AUTO_SCROLL_EDGE)
              : 0;
        if (speed !== 0) {
          const state = list.getState();
          const maximum = Math.max(current.startScroll, state.contentLength - state.scrollLength);
          const scroll = Math.max(
            // iOS automatic insets rest the list at a negative offset.
            Math.min(current.startScroll, -insets.top),
            Math.min(maximum, current.scroll + speed * elapsed * 0.5),
          );
          if (scroll !== current.scroll) {
            current.scroll = scroll;
            list.scrollToOffset({ offset: scroll, animated: false });
            retarget();
          }
        }
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    };
    return {
      canStart: () =>
        drag.current === null &&
        getPendingThreadOrder() === null &&
        !appAtomRegistry.get(threadDropBusyAtom),
      arm: () => {
        setScrollEnabled(false);
        container.current?.measureInWindow((_x, y, _width, height) => {
          geometry.current = { top: y, height };
        });
      },
      disarm: () => setScrollEnabled(true),
      start: (itemKey, thread, grabY, absoluteY) => {
        const list = latest.current.listRef.current;
        if (list === null || drag.current !== null) return;
        const state = list.getState();
        const rows: ThreadDragRow[] = [];
        const offsets: Record<string, number> = {};
        const items = latest.current.items;
        const geometry = completeThreadDragGeometry(
          items.map((item, index) => state.positionByKey(item.key) ?? state.positionAtIndex(index)),
          items.map((item) => state.sizes.get(item.key)),
          ESTIMATED_ROW_HEIGHT,
        );
        items.forEach((item, index) => {
          const { offset, height } = geometry[index]!;
          offsets[item.key] = offset;
          if (!isThreadListV2ListItem(item)) return;
          rows.push({
            key: item.key,
            threadKey:
              item.type === "v2-thread"
                ? scopedThreadKey(item.item.thread.environmentId, item.item.thread.id)
                : null,
            section: dragSection(item),
            offset,
            height,
          });
        });
        const source = rows.find((row) => row.key === itemKey);
        if (source === undefined || (source.section !== "pinned" && source.section !== "active"))
          return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        drag.current = {
          itemKey,
          thread,
          section: source.section,
          rows,
          offsets,
          sourceOffset: source.offset,
          sourceHeight: source.height,
          grabY,
          startAbsoluteY: absoluteY,
          startScroll: state.scroll,
          canDrop: createDropPolicy(thread, source.section, latest.current.workingShelfEnabled),
          absoluteY,
          scroll: state.scroll,
          // Differs from any resolved value so the first retarget publishes.
          destination: { section: "settled", targetId: itemKey, placement: "before" },
        };
        retarget();
        autoScroll();
      },
      move: (absoluteY) => {
        const current = drag.current;
        if (current === null) return;
        current.absoluteY = absoluteY;
        // Keep the lifted card out from under translucent chrome.
        const insets = latest.current.edgeInsets ?? { top: 0, bottom: 0 };
        previewTop.set(
          Math.max(
            insets.top,
            Math.min(
              geometry.current.height - insets.bottom - current.sourceHeight,
              absoluteY - geometry.current.top - current.grabY,
            ),
          ),
        );
        retarget();
      },
      end: (cancelled) => {
        const current = drag.current;
        stopScrolling();
        if (current === null) return;
        if (cancelled || current.destination === null) {
          clear();
          return;
        }
        // Keep the gap until the saved order arrives, avoiding a flash back.
        void latest.current.onMoveThread(current.thread, current.destination).finally(() => {
          if (drag.current === current) clear();
        });
      },
    };
  }, [layout, previewTop]);
  const previewStyle = useAnimatedStyle(() => ({ transform: [{ translateY: previewTop.value }] }));

  // A reordered or rebuilt list invalidates the drag-start layout.
  // Sections count too: a remote pin keeps the order but changes the drop.
  const orderVersion = props.items
    .map((item) =>
      item.type === "v2-thread" && isThreadListV2ListItem(item)
        ? `${item.key}:${dragSection(item)}`
        : item.key,
    )
    .join("|");
  useEffect(() => {
    if (drag.current === null) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    layout.set(null);
    setPreview(null);
  }, [orderVersion, layout]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const context = useMemo(() => ({ controller, layout }), [controller, layout]);
  // Preview updates re-render only the surface; an unchanged element skips the list.
  const list = useMemo(() => props.children(scrollEnabled), [props.children, scrollEnabled]);
  return (
    <ThreadListDragContext value={context}>
      <View
        ref={container}
        collapsable={false}
        className="flex-1"
        onLayout={(event) => {
          geometry.current.height = event.nativeEvent.layout.height;
        }}
      >
        {list}
        {preview === null ? null : (
          <Reanimated.View
            pointerEvents="none"
            style={[
              { position: "absolute", top: 0, left: 12, right: 12, height: preview.height },
              previewStyle,
            ]}
          >
            <View className="flex-1 justify-center rounded-xl border border-border bg-screen px-4">
              <Text numberOfLines={preview.action ? 1 : 2} className="text-base font-t3-medium">
                {preview.title}
              </Text>
              {preview.action ? (
                <Text className="text-xs text-foreground-muted">{preview.action}</Text>
              ) : null}
            </View>
          </Reanimated.View>
        )}
      </View>
    </ThreadListDragContext>
  );
}

/**
 * Press-and-drag for one row. A short hold followed by movement lifts the
 * row; a quick flick scrolls and holding still leaves the long-press menu to
 * the row. Call `onMenuOpen` when that menu appears so the hold cannot lift.
 */
export function useThreadListDragTarget(input: {
  readonly itemKey: string;
  readonly thread: EnvironmentThreadShell;
  readonly enabled: boolean;
}) {
  const drag = use(ThreadListDragContext);
  const fallbackLayout = useSharedValue<DragLayout | null>(null);
  const layout = drag?.layout ?? fallbackLayout;
  const controller = drag?.controller ?? null;
  const enabled = input.enabled && controller !== null;
  const latest = useRef(input);
  latest.current = input;
  const menuOpen = useRef(false);
  const release = useRef(() => {});

  const press = useRef({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    armed: false,
    active: false,
    startX: 0,
    startY: 0,
    // The row this press began on; a recycled cell must not lift its new thread.
    itemKey: "",
    thread: input.thread,
  });
  const gesture = useMemo(() => {
    const state = press.current;
    const reset = () => {
      clearTimeout(state.timer);
      state.timer = undefined;
      if (state.armed) controller?.disarm();
      state.armed = false;
    };
    release.current = reset;
    return Gesture.Pan()
      .enabled(enabled)
      .manualActivation(true)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onTouchesDown((event, manager) => {
        const touch = event.allTouches[0];
        if (event.numberOfTouches !== 1 || touch === undefined || !controller?.canStart()) {
          manager.fail();
          return;
        }
        menuOpen.current = false;
        state.itemKey = latest.current.itemKey;
        state.thread = latest.current.thread;
        state.startX = touch.absoluteX;
        state.startY = touch.absoluteY;
        state.timer = setTimeout(() => {
          state.timer = undefined;
          if (menuOpen.current) return;
          state.armed = true;
          controller.arm();
        }, HOLD_MS);
      })
      .onTouchesMove((event, manager) => {
        const touch = event.allTouches[0];
        if (state.active || touch === undefined) return;
        const distance = Math.hypot(touch.absoluteX - state.startX, touch.absoluteY - state.startY);
        if (
          menuOpen.current ||
          event.numberOfTouches !== 1 ||
          (!state.armed && distance > PRESS_SLOP)
        ) {
          reset();
          manager.fail();
        } else if (state.armed && distance > LIFT_SLOP) {
          manager.activate();
        }
      })
      .onTouchesUp((_event, manager) => {
        if (state.active) return;
        reset();
        manager.fail();
      })
      .onTouchesCancelled((_event, manager) => {
        if (state.active) return;
        reset();
        manager.fail();
      })
      .onStart((event) => {
        state.active = true;
        // Anchor to where the finger went down so the lift never jumps.
        controller?.start(
          state.itemKey,
          state.thread,
          event.y - (event.absoluteY - state.startY),
          state.startY,
        );
        controller?.move(event.absoluteY);
      })
      .onUpdate((event) => controller?.move(event.absoluteY))
      .onFinalize((_event, success) => {
        if (state.active) controller?.end(!success);
        state.active = false;
        reset();
      });
  }, [controller, enabled]);

  const itemKey = input.itemKey;
  const style = useAnimatedStyle(() => {
    const value = layout.value;
    const offset = value?.offsets[itemKey];
    if (value == null || offset === undefined)
      return { opacity: 1, transform: [{ translateY: 0 }] };
    const shift = threadDragGapOffset(
      offset,
      value.sourceOffset,
      value.sourceHeight,
      value.insertionOffset,
    );
    return {
      opacity: value.sourceKey === itemKey ? 0 : 1,
      transform: [
        { translateY: withTiming(shift, { duration: 160, reduceMotion: ReduceMotion.System }) },
      ],
    };
  });

  // A press must not outlive its row: restore scrolling if the cell is
  // recycled or unmounted while held.
  useEffect(() => () => release.current(), [input.itemKey]);

  const onMenuOpen = useMemo(
    () => () => {
      menuOpen.current = true;
      release.current();
    },
    [],
  );
  return { gesture, style, onMenuOpen };
}
