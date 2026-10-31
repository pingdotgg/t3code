import type { LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Haptics from "expo-haptics";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
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
  type ThreadDropDestination,
} from "./threadDragGap";
import { getThreadListV2OrderedSection, isThreadListV2ListItem } from "./threadListV2";
import { createThreadMovePlanner, threadDragAction, type ThreadDragSection } from "./threadOrder";

import { dragSection, draggableThreadKeys, snapshotRows } from "./thread-list-drag-logic";

// Long enough that a flick still scrolls, short enough to beat the long-press
// menu (~500ms on iOS): holding still opens the menu, moving after the hold
// lifts the row.
const HOLD_MS = 200;
const PRESS_SLOP = 10;
const LIFT_SLOP = 6;
const AUTO_SCROLL_EDGE = 56;

type ListItem = { readonly type: string; readonly key: string };

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
  // The controller outlives renders, so it reads the latest props on demand.
  const latestProps = useEffectEvent(() => props);

  const [{ controller, cancel }] = useState(() => {
    const insets = () => latestProps().edgeInsets ?? { top: 0, bottom: 0 };
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
      const list = latestProps().listRef.current;
      if (current === null || list === null) return;
      const state = list.getState();
      const { rows, offsets } = snapshotRows(
        state,
        latestProps().items,
        latestProps().estimatedRowHeight,
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
      const sourceHeight = source?.height ?? latestProps().estimatedRowHeight;
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
      const item = latestProps().items.find((item) => item.key === current.itemKey);
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
        const list = latestProps().listRef.current;
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
        latestProps()
          .listRef.current?.getNativeScrollRef()
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
        const list = latestProps().listRef.current;
        if (owner.get() !== itemKey || list === null || drag.current !== null) return;
        const state = list.getState();
        const source = snapshotRows(
          state,
          latestProps().items,
          latestProps().estimatedRowHeight,
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
            -(latestProps().edgeInsets?.scrollInsetTop ?? insets().top),
          ),
          canDrop: createDropPolicy(thread, source.section, latestProps().workingShelfEnabled),
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
        void latestProps()
          .onMoveThread(current.thread, current.destination)
          .finally(() => {
            if (drag.current === current) cancel();
          });
      },
    };
    return { controller, cancel };
  });

  // A rebuilt list invalidates the drag, including a remote pin or settle
  // that keeps the order but changes what the drop would do.
  const listVersion = props.items
    .map((item) => (isThreadListV2ListItem(item) ? `${item.key}:${dragSection(item)}` : item.key))
    .join("|");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A changed native list invalidates its active gesture and preview.
  useEffect(() => {
    cancel();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Section/order changes invalidate the gesture even when its controller is unchanged.
  }, [listVersion, cancel]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the native gesture and animation frame when its list unmounts.
  useEffect(() => cancel, [cancel]);

  const previewStyle = useAnimatedStyle(() => ({ transform: [{ translateY: previewTop.value }] }));
  const draggableKeys = useMemo(() => draggableThreadKeys(props.items), [props.items]);
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
 * Press-and-drag for one row. Render the row inside `ThreadListDragRow` and
 * call `onMenuOpen` when its long-press menu appears.
 */
export function useThreadListDragTarget(input: {
  readonly target: ThreadListDragTarget | undefined;
  readonly itemKey: string;
  readonly thread: EnvironmentThreadShell;
  readonly enabled: boolean;
}) {
  const fallbackLayout = useSharedValue<DragLayout | null>(null);
  const layout = input.target?.layout ?? fallbackLayout;
  const fallbackOwner = useSharedValue<string | null>(null);
  const owner = input.target?.owner ?? fallbackOwner;
  const enabled = input.enabled && input.target?.draggableKeys.has(input.itemKey) === true;
  const touch = useSharedValue({ startedAt: 0, x: 0, y: 0, grabY: 0, active: false });
  const menuOpen = useSharedValue(false);
  const itemKey = input.itemKey;

  // Gesture callbacks outlive renders, so they read the latest input on demand.
  const latestInput = useEffectEvent(() => input);
  const [{ prepare, start, move, finish }] = useState(() => {
    const controllerFor = () => latestInput().target?.controller ?? null;
    let press = { itemKey: "", thread: input.thread, active: false };
    return {
      prepare: (key: string) => {
        if (latestInput().itemKey !== key) return controllerFor()?.disarm(key);
        press = { itemKey: key, thread: latestInput().thread, active: false };
        controllerFor()?.arm(key);
      },
      start: (key: string, grabY: number, startY: number, absoluteY: number) => {
        if (press.itemKey !== key || latestInput().itemKey !== key) return;
        press.active = true;
        controllerFor()?.start(key, press.thread, grabY, startY);
        controllerFor()?.move(key, absoluteY);
      },
      move: (key: string, absoluteY: number) => controllerFor()?.move(key, absoluteY),
      finish: (key: string, success: boolean) => {
        if (press.itemKey !== key) return;
        if (press.active) controllerFor()?.end(key, !success);
        press.active = false;
        controllerFor()?.disarm(key);
      },
    };
  });

  const { gesture, release } = useMemo(() => {
    const release = () => finish(itemKey, false);
    // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a React component.
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
        owner.set(itemKey);
        menuOpen.set(false);
        touch.set({
          // oxlint-disable-next-line react/purity -- The native touch callback reads the clock after render.
          startedAt: Date.now(),
          x: point.absoluteX,
          y: point.absoluteY,
          // Row-relative, so the lifted card keeps the finger's grab point.
          grabY: point.y,
          active: false,
        });
        runOnJS(prepare)(itemKey);
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
        // oxlint-disable-next-line react/purity -- The native touch callback reads the clock after render.
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
        const state = touch.get();
        touch.set({ ...state, active: true });
        runOnJS(start)(itemKey, state.grabY, state.y, event.absoluteY);
      })
      .onUpdate((event) => runOnJS(move)(itemKey, event.absoluteY))
      .onFinalize((_event, success) => runOnJS(finish)(itemKey, success));
    return { gesture, release };
  }, [enabled, finish, itemKey, menuOpen, move, owner, prepare, start, touch]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release a native press when its row is recycled or unmounted.
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
  return { gesture, style, onMenuOpen };
}

/** The row's outer view, carrying its drag gesture and gap offset. */
export function ThreadListDragRow(props: {
  readonly drag: ReturnType<typeof useThreadListDragTarget>;
  readonly children: ReactNode;
}) {
  return (
    <GestureDetector gesture={props.drag.gesture}>
      <Reanimated.View collapsable={false} style={props.drag.style}>
        {props.children}
      </Reanimated.View>
    </GestureDetector>
  );
}
