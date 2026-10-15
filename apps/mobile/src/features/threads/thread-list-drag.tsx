import type { LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { View, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  ReduceMotion,
  runOnJS,
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
// menu (~500ms on iOS): holding still opens the menu, moving after the hold
// lifts the row.
const HOLD_MS = 200;
const PRESS_SLOP = 10;
const LIFT_SLOP = 6;
const AUTO_SCROLL_EDGE = 56;

type ListItem = { readonly type: string; readonly key: string };
type ListState = ReturnType<LegendListRef["getState"]>;

/** Published to rows so they can slide aside for the insertion gap. */
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
  readonly grabY: number;
  /** The finger's content Y is `anchor + absoluteY + scroll`. */
  readonly anchor: number;
  readonly minimumScroll: number;
  readonly canDrop: (destination: ThreadDropDestination) => boolean;
  absoluteY: number;
  /** Undefined until the first resolution is published. */
  destination: ThreadDropDestination | null | undefined;
}

export interface ThreadListDragListProps {
  readonly alwaysRender?: { readonly keys: string[] };
}

interface Controller {
  arm(itemKey: string): void;
  disarm(itemKey: string): void;
  start(itemKey: string, thread: EnvironmentThreadShell, grabY: number, absoluteY: number): void;
  move(itemKey: string, absoluteY: number): void;
  end(itemKey: string, cancelled: boolean): void;
}

/** Handed to each row of a list that uses `useThreadListDrag`. */
export interface ThreadListDragTarget {
  readonly controller: Controller;
  readonly layout: SharedValue<DragLayout | null>;
  readonly owner: SharedValue<string | null>;
  readonly draggableKeys: ReadonlySet<string>;
}

function dragSection(item: ThreadListV2ListItem): ThreadDragSection | null {
  if (item.type === "v2-settled-shelf") return "settled";
  if (item.type !== "v2-thread") return null;
  if (item.item.snoozed) return "snoozed";
  if (item.item.variant === "slim") return "settled";
  return item.item.pinned ? "pinned" : "active";
}

/** The list's untransformed layout. The gap is a transform, so hit testing
 * never sees it. LegendList only reports sizes for measured rows. */
function snapshotRows(state: ListState, items: readonly ListItem[], estimatedRowHeight: number) {
  const rows: ThreadDragRow[] = [];
  const offsets: Record<string, number> = {};
  let cursor = 0;
  let liveBlock = true;
  items.forEach((item, index) => {
    const position = state.positionAtIndex(index);
    const offset = Number.isFinite(position) ? position : cursor;
    const next = state.positionAtIndex(index + 1);
    const height =
      state.sizes.get(item.key) ??
      (Number.isFinite(next) && next > offset ? next - offset : estimatedRowHeight);
    cursor = offset + height;
    offsets[item.key] = offset;
    if (item.type !== "v2-thread") liveBlock = false;
    if (!isThreadListV2ListItem(item)) return;
    rows.push({
      key: item.key,
      threadKey:
        item.type === "v2-thread"
          ? scopedThreadKey(item.item.thread.environmentId, item.item.thread.id)
          : null,
      section: item.type === "v2-thread" && !liveBlock ? null : dragSection(item),
      offset,
      height,
    });
  });
  return { rows, offsets };
}

/** Plan against the complete sections, exactly as the drop's `moveThread` will. */
function createDropPolicy(
  thread: EnvironmentThreadShell,
  section: ThreadDragSection,
  workingShelfEnabled: boolean,
) {
  const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const capabilities = (id: EnvironmentThreadShell["environmentId"]) =>
    configs.get(id)?.environment.capabilities;
  const environmentsWhere = (supported: (id: EnvironmentThreadShell["environmentId"]) => boolean) =>
    new Set([...configs.keys()].filter(supported));
  const planner = (destination: "pinned" | "active") =>
    createThreadMovePlanner({
      ordered: getThreadListV2OrderedSection({
        threads: shells,
        section: destination,
        now: new Date().toISOString(),
        queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
        settlementEnvironmentIds: environmentsWhere((id) => !!capabilities(id)?.threadSettlement),
        snoozeEnvironmentIds: environmentsWhere((id) => !!capabilities(id)?.threadSnooze),
      }),
      allThreads: shells,
      section: destination,
      // The Working beta orders Active by time, so only pins take a position.
      reorderableEnvironmentIds: environmentsWhere((id) =>
        destination === "pinned"
          ? !!capabilities(id)?.threadPinReorder
          : !workingShelfEnabled && !!capabilities(id)?.threadActiveReorder,
      ),
    });
  const planners = { pinned: planner("pinned"), active: planner("active") };
  const own = capabilities(thread.environmentId);
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  return (destination: ThreadDropDestination) => {
    const target = destination.section;
    if (target === undefined) return false;
    if (target === "settled") return !!own?.threadSettlement;
    const pinChange = target !== section && (target === "pinned" || section === "pinned");
    if (pinChange && !own?.threadPinning) return false;
    return planners[target](threadKey, destination) !== null;
  };
}

/**
 * Press-and-drag arrangement for a thread list. Spread `listProps` onto the
 * list, render `overlay` beside it, and pass `target` to each row.
 */
export function useThreadListDrag(props: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly estimatedRowHeight: number;
  readonly items: readonly ListItem[];
  readonly workingShelfEnabled: boolean;
  /** Content under translucent chrome, kept out of the auto-scroll edges. */
  readonly edgeInsets?:
    | { readonly top: number; readonly bottom: number; readonly scrollInsetTop?: number }
    | undefined;
  readonly onMoveThread: (
    thread: EnvironmentThreadShell,
    destination: ThreadDropDestination,
  ) => Promise<boolean>;
}) {
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    title: string;
    height: number;
    action: string | null;
  }>();
  const layout = useSharedValue<DragLayout | null>(null);
  const owner = useSharedValue<string | null>(null);
  const previewTop = useSharedValue(0);
  const viewport = useRef({ top: 0, height: 0 });
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const { controller, cancel } = useMemo(() => {
    const insets = () => latest.current.edgeInsets ?? { top: 0, bottom: 0 };
    const cancel = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      drag.current = null;
      owner.set(null);
      setHeldKey(null);
      layout.set(null);
      setPreview(undefined);
    };
    // Rows are measured as auto-scroll reveals them, so each resolution reads
    // LegendList's current layout and the scroll offset it actually applied.
    const retarget = () => {
      const current = drag.current;
      const list = latest.current.listRef.current;
      if (current === null || list === null) return;
      const state = list.getState();
      const { rows, offsets } = snapshotRows(
        state,
        latest.current.items,
        latest.current.estimatedRowHeight,
      );
      const destination = resolveThreadDrop({
        rows,
        contentY: current.anchor + current.absoluteY + state.scroll,
        source: {
          threadKey: scopedThreadKey(current.thread.environmentId, current.thread.id),
          section: current.section,
        },
        canDrop: current.canDrop,
      });
      current.destination = destination;
      const source = rows.find((row) => row.key === current.itemKey);
      const sourceOffset = source?.offset ?? 0;
      const sourceHeight = source?.height ?? latest.current.estimatedRowHeight;
      const insertionOffset = threadDropInsertionOffset(rows, destination, sourceOffset);
      const previous = layout.get();
      if (
        previous === null ||
        previous.sourceOffset !== sourceOffset ||
        previous.sourceHeight !== sourceHeight ||
        previous.insertionOffset !== insertionOffset ||
        rows.some((row) => previous.offsets[row.key] !== row.offset)
      ) {
        layout.set({
          sourceKey: current.itemKey,
          sourceOffset,
          sourceHeight,
          insertionOffset,
          offsets,
        });
      }
      const item = latest.current.items.find((item) => item.key === current.itemKey);
      const title =
        item && isThreadListV2ListItem(item) && item.type === "v2-thread"
          ? item.item.thread.title
          : current.thread.title;
      const action = destination?.section
        ? threadDragAction(current.section, destination.section)
        : null;
      setPreview((previous) =>
        previous?.title === title && previous.height === sourceHeight && previous.action === action
          ? previous
          : { title, height: sourceHeight, action },
      );
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
        const y = current.absoluteY - viewport.current.top;
        const top = insets().top + AUTO_SCROLL_EDGE;
        const bottom = viewport.current.height - insets().bottom - AUTO_SCROLL_EDGE;
        const speed =
          y < top
            ? -Math.min(1, (top - y) / AUTO_SCROLL_EDGE)
            : y > bottom
              ? Math.min(1, (y - bottom) / AUTO_SCROLL_EDGE)
              : 0;
        if (speed !== 0) {
          const state = list.getState();
          const maximum = Math.max(state.scroll, state.contentLength - state.scrollLength);
          const scroll = Math.max(
            current.minimumScroll,
            Math.min(maximum, state.scroll + speed * elapsed * 0.5),
          );
          // LegendList's scrollToOffset clamps the negative offset iOS
          // automatic insets rest at; the native view does not.
          if (Math.abs(scroll - state.scroll) >= 0.5)
            list.getNativeScrollRef()?.scrollTo({ y: scroll, animated: false });
        }
        retarget();
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    };
    const controller: Controller = {
      arm: (itemKey) => {
        if (owner.get() !== itemKey) return;
        if (
          drag.current !== null ||
          getPendingThreadOrder() !== null ||
          appAtomRegistry.get(threadDropBusyAtom)
        ) {
          owner.set(null);
          return;
        }
        setHeldKey(itemKey);
        latest.current.listRef.current
          ?.getNativeScrollRef()
          ?.measureInWindow((_x: number, y: number, _width: number, height: number) => {
            viewport.current = { top: y, height };
          });
      },
      disarm: (itemKey) => {
        if (owner.get() !== itemKey || drag.current !== null) return;
        owner.set(null);
        setHeldKey(null);
      },
      start: (itemKey, thread, grabY, absoluteY) => {
        const list = latest.current.listRef.current;
        if (owner.get() !== itemKey || list === null || drag.current !== null) return;
        const state = list.getState();
        const source = snapshotRows(
          state,
          latest.current.items,
          latest.current.estimatedRowHeight,
        ).rows.find((row) => row.key === itemKey);
        if (source?.section !== "pinned" && source?.section !== "active") return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        drag.current = {
          itemKey,
          thread,
          section: source.section,
          grabY,
          anchor: source.offset + grabY - absoluteY - state.scroll,
          minimumScroll: Math.min(
            state.scroll,
            -(latest.current.edgeInsets?.scrollInsetTop ?? insets().top),
          ),
          canDrop: createDropPolicy(thread, source.section, latest.current.workingShelfEnabled),
          absoluteY,
          destination: undefined,
        };
        retarget();
        autoScroll();
      },
      move: (itemKey, absoluteY) => {
        const current = drag.current;
        if (owner.get() !== itemKey || current?.itemKey !== itemKey) return;
        current.absoluteY = absoluteY;
        // The lifted card stays clear of translucent chrome.
        const { top, height } = viewport.current;
        previewTop.set(
          Math.max(
            insets().top,
            Math.min(
              height - insets().bottom - (layout.get()?.sourceHeight ?? 0),
              absoluteY - top - current.grabY,
            ),
          ),
        );
        retarget();
      },
      end: (itemKey, cancelled) => {
        const current = drag.current;
        if (owner.get() !== itemKey || current?.itemKey !== itemKey) return;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        if (current === null) return;
        if (cancelled || !current.destination) return cancel();
        // Keep the gap until the saved order arrives, avoiding a flash back.
        void latest.current.onMoveThread(current.thread, current.destination).finally(() => {
          if (drag.current === current) cancel();
        });
      },
    };
    return { controller, cancel };
  }, [layout, owner, previewTop]);

  // A rebuilt list invalidates the drag, including a remote pin or settle
  // that keeps the order but changes what the drop would do.
  const listVersion = props.items
    .map((item) => (isThreadListV2ListItem(item) ? `${item.key}:${dragSection(item)}` : item.key))
    .join("|");
  useEffect(() => {
    cancel();
  }, [listVersion, cancel]);
  useEffect(() => cancel, [cancel]);

  const previewStyle = useAnimatedStyle(() => ({ transform: [{ translateY: previewTop.value }] }));
  const draggableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of props.items) {
      if (!isThreadListV2ListItem(item) || item.type !== "v2-thread") break;
      const section = dragSection(item);
      if (section !== "pinned" && section !== "active") break;
      keys.add(item.key);
    }
    return keys;
  }, [props.items]);
  const target = useMemo(
    () => ({ controller, layout, owner, draggableKeys }),
    [controller, layout, owner, draggableKeys],
  );
  const listProps = useMemo<ThreadListDragListProps>(
    () =>
      // Recycling the held cell would cancel its gesture mid-drag.
      heldKey === null ? {} : { alwaysRender: { keys: [heldKey] } },
    [heldKey],
  );
  const overlay = preview ? (
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
  ) : null;
  return { target, listProps, overlay };
}

/**
 * Press-and-drag for one row. Attach `ref`, `gesture`, and `style` to the
 * row's outer view and call `onMenuOpen` when its long-press menu appears.
 */
export function useThreadListDragTarget(input: {
  readonly target: ThreadListDragTarget | undefined;
  readonly itemKey: string;
  readonly thread: EnvironmentThreadShell;
  readonly enabled: boolean;
}) {
  const fallbackLayout = useSharedValue<DragLayout | null>(null);
  const layout = input.target?.layout ?? fallbackLayout;
  const controller = input.target?.controller ?? null;
  const fallbackOwner = useSharedValue<string | null>(null);
  const owner = input.target?.owner ?? fallbackOwner;
  const enabled = input.enabled && input.target?.draggableKeys.has(input.itemKey) === true;
  const row = useRef<ViewInstance>(null);
  const latest = useRef(input);
  latest.current = input;
  const press = useRef({ itemKey: "", thread: input.thread, startY: 0, rowTop: 0, active: false });
  const touch = useSharedValue({ startedAt: 0, x: 0, y: 0, active: false });
  const menuOpen = useSharedValue(false);
  const itemKey = input.itemKey;

  const { gesture, release } = useMemo(() => {
    const prepare = (key: string, startY: number) => {
      if (latest.current.itemKey !== key) return controller?.disarm(key);
      Object.assign(press.current, {
        itemKey: key,
        thread: latest.current.thread,
        startY,
        active: false,
      });
      // Measure at touch-down, before the UI-thread hold can activate.
      row.current?.measureInWindow((_x, y) => {
        press.current.rowTop = y;
      });
      controller?.arm(key);
    };
    const start = (key: string, absoluteY: number) => {
      const state = press.current;
      if (state.itemKey !== key || latest.current.itemKey !== key) return;
      state.active = true;
      controller?.start(key, state.thread, state.startY - state.rowTop, state.startY);
      controller?.move(key, absoluteY);
    };
    const move = (key: string, absoluteY: number) => controller?.move(key, absoluteY);
    const finish = (key: string, success: boolean) => {
      if (press.current.itemKey !== key) return;
      if (press.current.active) controller?.end(key, !success);
      press.current.active = false;
      controller?.disarm(key);
    };
    const release = () => finish(itemKey, false);
    const gesture = Gesture.Pan()
      .enabled(enabled)
      .manualActivation(true)
      // Only the worklet below may activate; quick flicks belong to scrolling.
      .minDistance(Number.MAX_SAFE_INTEGER)
      .maxPointers(1)
      .shouldCancelWhenOutside(false)
      .onTouchesDown((event, manager) => {
        const point = event.allTouches[0];
        if (event.numberOfTouches !== 1 || point === undefined || owner.value !== null)
          return manager.fail();
        owner.value = itemKey;
        menuOpen.value = false;
        touch.value = {
          startedAt: Date.now(),
          x: point.absoluteX,
          y: point.absoluteY,
          active: false,
        };
        runOnJS(prepare)(itemKey, point.absoluteY);
      })
      .onTouchesMove((event, manager) => {
        const point = event.allTouches[0];
        if (
          owner.value !== itemKey ||
          menuOpen.value ||
          event.numberOfTouches !== 1 ||
          point === undefined
        )
          return manager.fail();
        const state = touch.value;
        if (state.active) return;
        const distance = Math.hypot(point.absoluteX - state.x, point.absoluteY - state.y);
        if (Date.now() - state.startedAt < HOLD_MS) {
          if (distance > PRESS_SLOP) manager.fail();
        } else if (distance > LIFT_SLOP) {
          // Activate before the native scroll recognizer sees this movement.
          manager.activate();
        }
      })
      .onTouchesUp((_event, manager) => {
        if (!touch.value.active) manager.fail();
      })
      .onTouchesCancelled((_event, manager) => manager.fail())
      .onStart((event) => {
        touch.value = { ...touch.value, active: true };
        runOnJS(start)(itemKey, event.absoluteY);
      })
      .onUpdate((event) => runOnJS(move)(itemKey, event.absoluteY))
      .onFinalize((_event, success) => runOnJS(finish)(itemKey, success));
    return { gesture, release };
  }, [controller, enabled, itemKey, latest, menuOpen, owner, press, row, touch]);

  // A recycled or unmounted row must release its own press only.
  useEffect(() => release, [release]);

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

  const onMenuOpen = useMemo(
    () => () => {
      menuOpen.set(true);
      release();
    },
    [menuOpen, release],
  );
  return { ref: row, gesture, style, onMenuOpen };
}

/** The row's outer view, carrying its drag gesture and gap offset. */
export function ThreadListDragRow(props: {
  readonly drag: ReturnType<typeof useThreadListDragTarget>;
  readonly children: ReactNode;
}) {
  return (
    <GestureDetector gesture={props.drag.gesture}>
      <Reanimated.View ref={props.drag.ref} collapsable={false} style={props.drag.style}>
        {props.children}
      </Reanimated.View>
    </GestureDetector>
  );
}
