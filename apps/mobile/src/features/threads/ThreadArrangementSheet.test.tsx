import {
  act,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";

type GestureEvent = { translationY: number };
type Pan = {
  start: () => void;
  update: (event: GestureEvent) => void;
  end: (event: GestureEvent) => void;
  finalize: (event: GestureEvent, success: boolean) => void;
};
type Row = { key: string; offset: number; height: number; thread?: EnvironmentThreadShell };
type ListProps = {
  ref: Ref<{ scrollToOffset: (input: { offset: number; animated: boolean }) => void }>;
  data: Row[];
  renderItem: (input: { item: Row }) => ReactNode;
  onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
};
type Layout = (event: { nativeEvent: { layout: { height: number } } }) => void;

const native = vi.hoisted(() => ({
  atoms: {
    threads: Symbol(),
    environments: Symbol(),
    configs: Symbol(),
    queued: Symbol(),
    pending: Symbol(),
    busy: Symbol(),
    open: Symbol(),
  },
  values: new Map<symbol, unknown>(),
  listeners: new Set<() => void>(),
  gestures: [] as Pan[],
  layout: null as Layout | null,
  list: null as ListProps | null,
  close: () => {},
  scroll: vi.fn<(input: { offset: number; animated: boolean }) => void>(),
  move: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

function Children({ children }: { children?: ReactNode }) {
  return children;
}
function NativeView({ children, onLayout }: { children?: ReactNode; onLayout?: Layout }) {
  if (onLayout) native.layout = onLayout;
  return children;
}
function NativeList({ ref: listRef, data, renderItem, onScroll }: ListProps) {
  useLayoutEffect(() => {
    native.list = { ref: listRef, data, renderItem, onScroll };
  });
  useImperativeHandle(listRef, () => ({ scrollToOffset: native.scroll }));
  return data.map((item) => <FragmentRow key={item.key}>{renderItem({ item })}</FragmentRow>);
}
function FragmentRow({ children }: { children: ReactNode }) {
  return children;
}

vi.mock("react-native", () => ({
  View: NativeView,
  useWindowDimensions: () => ({ fontScale: 1 }),
  Modal: Children,
  Pressable: Children,
  FlatList: NativeList,
  Animated: {
    View: Children,
    Value: class {
      setValue() {}
    },
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: Children },
  ReduceMotion: { System: "system" },
  useAnimatedStyle: () => ({}),
  withTiming: (value: number) => value,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: Children,
  SafeAreaView: Children,
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: Children,
  GestureDetector: ({ gesture, children }: { gesture: Pan; children: ReactNode }) => {
    useLayoutEffect(() => {
      native.gestures.push(gesture);
    }, [gesture]);
    return children;
  },
  Gesture: {
    Pan: () => ({
      start: () => {},
      update: (_: GestureEvent) => {},
      end: (_: GestureEvent) => {},
      finalize: (_: GestureEvent, _success: boolean) => {},
      enabled() {
        return this;
      },
      minDistance() {
        return this;
      },
      shouldCancelWhenOutside() {
        return this;
      },
      runOnJS() {
        return this;
      },
      onStart(fn: Pan["start"]) {
        this.start = fn;
        return this;
      },
      onUpdate(fn: Pan["update"]) {
        this.update = fn;
        return this;
      },
      onEnd(fn: Pan["end"]) {
        this.end = fn;
        return this;
      },
      onFinalize(fn: Pan["finalize"]) {
        this.finalize = fn;
        return this;
      },
    }),
  },
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/SheetHeader", () => ({
  SheetHeader: ({ onClose }: { onClose: () => void }) => {
    native.close = onClose;
    return null;
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: symbol) =>
    useSyncExternalStore(
      (listener) => {
        native.listeners.add(listener);
        return () => {
          native.listeners.delete(listener);
        };
      },
      () => native.values.get(atom),
    ),
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { navigationThreadShellsAtom: native.atoms.threads },
}));
vi.mock("../../state/presentation", () => ({
  threadListEnvironmentsAtom: native.atoms.environments,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 14 } }),
}));
vi.mock("./use-thread-list-now", () => ({ useThreadListNow: () => Date.UTC(2026, 0, 1) }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: native.atoms.configs }));
vi.mock("../../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: native.atoms.queued }));
vi.mock("../../state/thread-order", () => ({
  pendingThreadOrderAtom: native.atoms.pending,
  threadDropBusyAtom: native.atoms.busy,
  threadArrangementOpenAtom: native.atoms.open,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    set: (atom: symbol, value: unknown) => {
      native.values.set(atom, value);
      native.listeners.forEach((listener) => listener());
    },
  },
}));
vi.mock("../../state/olderSettledShelf", () => ({
  useOlderSettledShelf: () => ({ isListed: () => true, unloadedCount: () => 0 }),
  useOlderSettledShelfGrowth: () => {},
}));
vi.mock("../home/useThreadListActions", () => ({
  useThreadListActions: () => ({ moveThread: native.move }),
}));
vi.mock("./use-thread-list-v2-shelf-preferences", () => ({
  useThreadListV2ShelfPreferences: () => ({ workingShelfEnabled: false }),
}));

import { ThreadArrangementHost } from "./ThreadArrangementSheet";

function setup(count = 30) {
  native.values.clear();
  native.listeners.clear();
  native.gestures = [];
  native.layout = null;
  native.list = null;
  native.scroll.mockClear();
  native.move.mockReset();
  native.move.mockResolvedValue(undefined);
  const threads = Array.from({ length: count }, (_, index) =>
    makeThreadShellFixture({
      id: ThreadId.make(`thread-${index}`),
      title: `Thread ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, count - index)).toISOString(),
      settledAt: null,
      settledOverride: null,
    }),
  );
  native.values.set(native.atoms.threads, threads);
  native.values.set(
    native.atoms.configs,
    new Map([
      [
        threads[0]!.environmentId,
        {
          environment: {
            capabilities: {
              threadSettlement: true,
              threadSnooze: true,
              threadPinning: true,
              threadPinReorder: true,
              threadActiveReorder: true,
            },
          },
        },
      ],
    ]),
  );
  native.values.set(native.atoms.environments, {
    pinReorderEnvironmentIds: new Set([threads[0]!.environmentId]),
    activeReorderEnvironmentIds: new Set([threads[0]!.environmentId]),
  });
  native.values.set(native.atoms.queued, new Set());
  native.values.set(native.atoms.pending, null);
  native.values.set(native.atoms.busy, false);
  native.values.set(native.atoms.open, true);

  // All native hosts render children or null; this container only supplies React's event root.
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let time = 0,
    id = 0,
    delivered = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
    frames.delete(frame);
  });
  const root = createRoot(container as unknown as HTMLElement);
  act(() => root.render(<ThreadArrangementHost />));
  let gesture: Pan | undefined;
  let translation = 0;
  const harness = {
    threads,
    frames,
    get delivered() {
      return delivered;
    },
    get rows() {
      return native.list!.data;
    },
    layout(height: number) {
      act(() => native.layout!({ nativeEvent: { layout: { height } } }));
    },
    scroll(offset: number) {
      act(() => native.list!.onScroll({ nativeEvent: { contentOffset: { y: offset } } }));
    },
    start(index = 2) {
      gesture = native.gestures[index]!;
      act(() => gesture!.start());
    },
    move(value: number) {
      translation = value;
      act(() => gesture!.update({ translationY: value }));
    },
    end(success: boolean) {
      act(() => {
        if (success) gesture!.end({ translationY: translation });
        gesture!.finalize({ translationY: translation }, success);
      });
    },
    advance(dt = 16) {
      time += dt;
      const pending = [...frames.entries()];
      act(() => {
        for (const [frame, callback] of pending) {
          frames.delete(frame);
          delivered++;
          callback(time);
        }
      });
      expect(frames.size).toBeLessThanOrEqual(1);
    },
    elapse(dt: number) {
      time += dt;
    },
    invalidateOrder() {
      act(() => {
        native.values.set(
          native.atoms.threads,
          threads.map((thread) => ({ ...thread, activeOrderKey: "changed" })),
        );
        native.listeners.forEach((listener) => listener());
      });
    },
    close() {
      act(() => native.close());
    },
    unmount() {
      act(() => root.unmount());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      clock.mockRestore();
      vi.unstubAllGlobals();
    },
  };
  harness.layout(500);
  return harness;
}

it.each(["neutral", "top", "bottom", "short"] as const)(
  "does not keep frames during a %s hold",
  (hold) => {
    using sheet = setup(hold === "short" ? 3 : 30);
    const maximum = sheet.rows.at(-1)!.offset + sheet.rows.at(-1)!.height - 500;
    if (hold === "bottom") sheet.scroll(maximum);
    sheet.start(hold === "top" ? 0 : hold === "bottom" ? 29 : 2);
    if (hold === "top") sheet.move(-124);
    if (hold === "bottom") sheet.move(60);
    if (hold === "short") sheet.move(250);
    for (let frame = 0; frame < 300; frame++) sheet.advance();
    expect(sheet.delivered).toBe(0);
    expect(sheet.frames.size).toBe(0);
    expect(native.scroll).not.toHaveBeenCalled();
  },
);

it("arms on edge entry, stops on leaving, and resets the baseline on re-entry", () => {
  using sheet = setup();
  sheet.start();
  sheet.elapse(10_000);
  sheet.move(250); // Source center 236 -> 486, 34px into the lower edge.
  sheet.move(250);
  expect(sheet.frames.size).toBe(1);
  sheet.advance();
  expect(native.scroll).toHaveBeenLastCalledWith({ offset: (34 / 48) * 8, animated: false });
  sheet.elapse(10);
  sheet.scroll((34 / 48) * 8);
  sheet.scroll((34 / 48) * 8);
  expect(sheet.frames.size).toBe(1);
  sheet.advance(6);
  expect(native.scroll).toHaveBeenLastCalledWith({ offset: (34 / 48) * 16, animated: false });
  sheet.advance(100);
  expect(native.scroll).toHaveBeenLastCalledWith({ offset: (34 / 48) * 32, animated: false });
  sheet.move(0);
  sheet.advance();
  expect(sheet.frames.size).toBe(0);
  const offset = native.scroll.mock.lastCall![0].offset;
  sheet.elapse(10_000);
  sheet.move(250);
  sheet.advance();
  expect(native.scroll).toHaveBeenLastCalledWith({
    offset: offset + (34 / 48) * 8,
    animated: false,
  });
});

it("scrolls at the upper edge until clamped, then leaves no frame outstanding", () => {
  using sheet = setup();
  sheet.scroll(20);
  sheet.start();
  sheet.move(-200); // Source center 236 - offset 20 - translation 200 = 16.
  sheet.advance();
  sheet.advance(100);
  sheet.advance();
  expect(native.scroll.mock.calls.map(([input]) => input)).toEqual([
    { offset: 20 - (32 / 48) * 8, animated: false },
    { offset: 20 - (32 / 48) * 8 - (32 / 48) * 16, animated: false },
    { offset: 0, animated: false },
  ]);
  expect(sheet.frames.size).toBe(0);
});

it("restarts from layout and native scroll geometry under a stationary finger", () => {
  using sheet = setup(3);
  sheet.start(); // A short list cannot scroll even with a finger at its lower edge.
  sheet.layout(236);
  expect(sheet.frames.size).toBe(1);
  for (let frame = 0; frame < 20; frame++) sheet.advance();
  expect(native.scroll).toHaveBeenLastCalledWith({ offset: 76, animated: false });
  expect(sheet.frames.size).toBe(0);
  sheet.elapse(10_000);
  sheet.scroll(60); // Delayed native delivery moves geometry away from the clamp.
  expect(sheet.frames.size).toBe(1);
  sheet.advance();
  expect(native.scroll).toHaveBeenLastCalledWith({ offset: 68, animated: false });
  sheet.scroll(76);
  sheet.advance();
  expect(sheet.frames.size).toBe(0);
});

it("corrects a stale out-of-range offset after layout even with a neutral finger", () => {
  using sheet = setup();
  sheet.scroll(200);
  sheet.start(4); // Source center 348 -> viewport y 148.
  sheet.layout(2000);
  sheet.advance();
  expect(native.scroll).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  expect(sheet.frames.size).toBe(0);
});

it.each([true, false])(
  "stops scheduling on finalization (successful drop: %s)",
  async (success) => {
    using sheet = setup();
    let finish = () => {};
    native.move.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    sheet.start();
    sheet.move(250);
    sheet.advance();
    sheet.end(success);
    expect(sheet.frames.size).toBe(0);
    const calls = native.scroll.mock.calls.length;
    sheet.scroll(0);
    sheet.layout(400);
    sheet.advance();
    expect(native.scroll).toHaveBeenCalledTimes(calls);
    if (success) {
      expect(native.move).toHaveBeenCalledExactlyOnceWith(sheet.threads[2], {
        section: "active",
        targetId: sheet.rows.find((row) => row.thread?.id === sheet.threads[7]!.id)!.key,
        placement: "before",
      });
      await act(async () => {
        finish();
      });
    } else expect(native.move).not.toHaveBeenCalled();
  },
);

it.each(["order", "close", "unmount"] as const)("cancels the outstanding frame on %s", (event) => {
  using sheet = setup();
  sheet.start();
  sheet.move(250);
  expect(sheet.frames.size).toBe(1);
  if (event === "order") sheet.invalidateOrder();
  else if (event === "close") sheet.close();
  else sheet.unmount();
  expect(sheet.frames.size).toBe(0);
  sheet.advance();
  expect(native.scroll).not.toHaveBeenCalled();
  expect(native.move).not.toHaveBeenCalled();
});
