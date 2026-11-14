import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  GestureTouchEvent,
  PanGestureActiveEvent,
  PanGestureBeginEvent,
  PanGestureDeactivateEvent,
  PanGestureFinalizeEvent,
} from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";

interface RegisteredPanConfig {
  enabled?: boolean;
  manualActivation?: boolean;
  maxPointers?: number;
  onTouchesDown?: (event: GestureTouchEvent) => void;
  onTouchesMove?: (event: GestureTouchEvent) => void;
  onActivate?: (event: PanGestureBeginEvent) => void;
  onUpdate?: (event: PanGestureActiveEvent) => void;
  onDeactivate?: (event: PanGestureDeactivateEvent) => void;
  onFinalize?: (event: PanGestureFinalizeEvent) => void;
}

const { createBoxSharedValue, rnghHarness } = vi.hoisted(() => ({
  createBoxSharedValue: <T,>(initial: T): SharedValue<T> => {
    const box = {
      value: initial,
      get() {
        return box.value;
      },
      set(next: T) {
        box.value = next;
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      modify: vi.fn(),
    };
    return box as unknown as SharedValue<T>;
  },
  rnghHarness: {
    activate: vi.fn<(handlerTag: number) => void>(),
    fail: vi.fn<(handlerTag: number) => void>(),
    gestures: [] as RegisteredPanConfig[],
    withTimingCalls: [] as number[],
  },
}));

vi.mock("react-native-gesture-handler", () => ({
  PointerType: {
    TOUCH: 0,
    STYLUS: 1,
    MOUSE: 2,
    KEY: 3,
    OTHER: 4,
  },
  GestureStateManager: {
    activate: (handlerTag: number) => rnghHarness.activate(handlerTag),
    fail: (handlerTag: number) => rnghHarness.fail(handlerTag),
    deactivate: vi.fn(),
  },
  usePanGesture: (config: RegisteredPanConfig) => {
    rnghHarness.gestures.push(config);
    return { handlerTag: rnghHarness.gestures.length, config };
  },
}));

vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return {
    Easing: {
      cubic: (t: number) => t,
      inOut: () => (t: number) => t,
    },
    ReduceMotion: {
      System: "system",
    },
    runOnJS: <Args extends unknown[]>(fn: (...args: Args) => void) => {
      return (...args: Args) => fn(...args);
    },
    useSharedValue: <T,>(initial: T): SharedValue<T> => {
      const ref = useRef<SharedValue<T> | null>(null);
      if (!ref.current) {
        ref.current = createBoxSharedValue(initial);
      }
      return ref.current;
    },
    withTiming: (toValue: number) => {
      rnghHarness.withTimingCalls.push(toValue);
      return toValue;
    },
  };
});

import { deriveSidebarSwipeCapabilities, SIDEBAR_FLOATING_SCRIM_OPACITY } from "./sidebar-swipe";
import { useSidebarSwipeGestures } from "./useSidebarSwipeGesture";

function createTouchEvent(params: {
  handlerTag?: number;
  x: number;
  y: number;
  pointerType?: number;
  numberOfTouches?: number;
}): GestureTouchEvent {
  return {
    handlerTag: params.handlerTag ?? 1,
    numberOfTouches: params.numberOfTouches ?? 1,
    state: 2,
    eventType: 1,
    pointerType: params.pointerType ?? 0,
    allTouches: [
      {
        id: 0,
        x: params.x,
        y: params.y,
        absoluteX: params.x,
        absoluteY: params.y,
      },
    ],
    changedTouches: [
      {
        id: 0,
        x: params.x,
        y: params.y,
        absoluteX: params.x,
        absoluteY: params.y,
      },
    ],
  } as GestureTouchEvent;
}

function createPanEvent(params: {
  handlerTag?: number;
  absoluteX: number;
  velocityX?: number;
  canceled?: boolean;
}) {
  return {
    handlerTag: params.handlerTag ?? 1,
    numberOfPointers: 1,
    pointerType: 0,
    x: params.absoluteX,
    y: 300,
    absoluteX: params.absoluteX,
    absoluteY: 300,
    translationX: 0,
    translationY: 0,
    changeX: 0,
    changeY: 0,
    velocityX: params.velocityX ?? 0,
    velocityY: 0,
    canceled: params.canceled ?? false,
    stylusData: { tiltX: 0, tiltY: 0, azimuthAngle: 0, altitudeAngle: 0, pressure: 0 },
  };
}

interface HarnessProps {
  viewportWidth?: number;
  safeAreaLeft?: number;
  safeAreaRight?: number;
  sidebarSlotWidth?: number;
  sidebarFloats?: boolean;
  primarySidebarVisible?: boolean;
  usesSplitView?: boolean;
  primarySidebarPinned?: boolean;
  renderedSidebarWidth: SharedValue<number>;
  scrimOpacity: SharedValue<number>;
  onCommitVisibility: (visible: boolean) => void;
}

interface HarnessInstanceProps extends HarnessProps {
  readonly onReady: (gestures: ReturnType<typeof useSidebarSwipeGestures>) => void;
}

function Harness({ onReady, ...props }: HarnessInstanceProps) {
  const capabilities = deriveSidebarSwipeCapabilities({
    usesSplitView: props.usesSplitView ?? true,
    nativeWorkspace: false,
    workspacePage: false,
    primarySidebarPinned: props.primarySidebarPinned ?? false,
    primarySidebarVisible: props.primarySidebarVisible ?? false,
    sidebarFloats: props.sidebarFloats ?? true,
    railOverlay: false,
    inspectorSheetOpen: false,
    sidebarSlotWidth: props.sidebarSlotWidth ?? 320,
  });
  const gestures = useSidebarSwipeGestures({
    capabilities,
    viewportWidth: props.viewportWidth ?? 716,
    safeAreaLeft: props.safeAreaLeft ?? 0,
    safeAreaRight: props.safeAreaRight ?? 0,
    sidebarSlotWidth: props.sidebarSlotWidth ?? 320,
    sidebarFloats: props.sidebarFloats ?? true,
    primarySidebarVisible: props.primarySidebarVisible ?? false,
    renderedSidebarWidth: props.renderedSidebarWidth,
    scrimOpacity: props.scrimOpacity,
    onCommitVisibility: props.onCommitVisibility,
  });
  React.useEffect(() => {
    onReady(gestures);
  }, [gestures, onReady]);
  return null;
}

function mountSwipeHarness(initialProps: HarnessProps) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let latest: ReturnType<typeof useSidebarSwipeGestures> | null = null;
  const handleReady = (gestures: ReturnType<typeof useSidebarSwipeGestures>) => {
    latest = gestures;
  };

  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness {...initialProps} onReady={handleReady} />));

  const getConfigs = () => {
    const content = latest!.contentSwipeGesture as unknown as {
      handlerTag: number;
      config: RegisteredPanConfig;
    };
    const scrim = latest!.scrimSwipeGesture as unknown as {
      handlerTag: number;
      config: RegisteredPanConfig;
    };
    return { content, scrim };
  };

  return {
    getConfigs,
    update(nextProps: Partial<HarnessProps>) {
      act(() => root.render(<Harness {...initialProps} {...nextProps} onReady={handleReady} />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

describe("useSidebarSwipeGestures", () => {
  beforeEach(() => {
    rnghHarness.activate.mockReset();
    rnghHarness.fail.mockReset();
    rnghHarness.gestures.length = 0;
    rnghHarness.withTimingCalls.length = 0;
  });

  it("activates on a center swipe right on an unfolded foldable and tracks sidebar + scrim smoothly", () => {
    const renderedSidebarWidth = createBoxSharedValue(0);
    const scrimOpacity = createBoxSharedValue(0);
    const onCommitVisibility = vi.fn();

    using harness = mountSwipeHarness({
      renderedSidebarWidth,
      scrimOpacity,
      onCommitVisibility,
    });

    const { content, scrim } = harness.getConfigs();
    expect(content.config.enabled).toBe(true);
    expect(content.config.manualActivation).toBe(true);
    expect(scrim.config.enabled).toBe(false);

    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 358, y: 400 }),
    );
    expect(rnghHarness.fail).not.toHaveBeenCalled();

    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 376, y: 402 }),
    );
    expect(rnghHarness.activate).toHaveBeenCalledWith(content.handlerTag);

    content.config.onActivate?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 376 }) as PanGestureBeginEvent,
    );
    content.config.onUpdate?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 500 }) as PanGestureActiveEvent,
    );

    expect(renderedSidebarWidth.value).toBe(124);
    expect(scrimOpacity.value).toBeCloseTo(SIDEBAR_FLOATING_SCRIM_OPACITY * (124 / 320));

    content.config.onDeactivate?.(
      createPanEvent({
        handlerTag: content.handlerTag,
        absoluteX: 500,
        velocityX: 0,
      }) as PanGestureDeactivateEvent,
    );
    content.config.onFinalize?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 500 }) as PanGestureFinalizeEvent,
    );

    expect(onCommitVisibility).toHaveBeenCalledWith(true);
  });

  it("reverts smoothly on UI thread without committing when open swipe stops below threshold or cancels", () => {
    const renderedSidebarWidth = createBoxSharedValue(0);
    const scrimOpacity = createBoxSharedValue(0);
    const onCommitVisibility = vi.fn();

    using harness = mountSwipeHarness({
      renderedSidebarWidth,
      scrimOpacity,
      onCommitVisibility,
    });
    const { content } = harness.getConfigs();

    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 300, y: 300 }),
    );
    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 320, y: 300 }),
    );
    content.config.onActivate?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 320 }) as PanGestureBeginEvent,
    );
    content.config.onUpdate?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 380 }) as PanGestureActiveEvent,
    );

    expect(renderedSidebarWidth.value).toBe(60);

    content.config.onDeactivate?.(
      createPanEvent({
        handlerTag: content.handlerTag,
        absoluteX: 380,
        velocityX: 0,
      }) as PanGestureDeactivateEvent,
    );
    expect(onCommitVisibility).not.toHaveBeenCalled();
    expect(renderedSidebarWidth.value).toBe(0);
    expect(scrimOpacity.value).toBe(0);

    // Cancelled swipe beyond threshold also reverts cleanly.
    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 300, y: 300 }),
    );
    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 320, y: 300 }),
    );
    content.config.onActivate?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 320 }) as PanGestureBeginEvent,
    );
    content.config.onUpdate?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 520 }) as PanGestureActiveEvent,
    );
    expect(renderedSidebarWidth.value).toBe(200);

    content.config.onDeactivate?.(
      createPanEvent({
        handlerTag: content.handlerTag,
        absoluteX: 520,
        canceled: true,
      }) as PanGestureDeactivateEvent,
    );
    expect(onCommitVisibility).not.toHaveBeenCalled();
    expect(renderedSidebarWidth.value).toBe(0);
    expect(scrimOpacity.value).toBe(0);
  });

  it("fails touches in Android/iOS left and right system edge zones immediately", () => {
    const renderedSidebarWidth = createBoxSharedValue(0);
    const scrimOpacity = createBoxSharedValue(0);

    using harness = mountSwipeHarness({
      viewportWidth: 716,
      safeAreaLeft: 0,
      safeAreaRight: 0,
      renderedSidebarWidth,
      scrimOpacity,
      onCommitVisibility: vi.fn(),
    });
    const { content } = harness.getConfigs();

    // Left edge (Android/One UI Back zone).
    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 18, y: 400 }),
    );
    expect(rnghHarness.fail).toHaveBeenCalledWith(content.handlerTag);
    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 80, y: 400 }),
    );
    expect(rnghHarness.activate).not.toHaveBeenCalled();

    rnghHarness.fail.mockReset();

    // Right edge (Android/One UI Back & Edge Panel zone).
    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 690, y: 400 }),
    );
    expect(rnghHarness.fail).toHaveBeenCalledWith(content.handlerTag);
    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 640, y: 400 }),
    );
    expect(rnghHarness.activate).not.toHaveBeenCalled();
  });

  it("fails mouse drags, multi-touch, and diagonal vertical scrolls, while allowing stylus swipes", () => {
    const renderedSidebarWidth = createBoxSharedValue(0);
    const scrimOpacity = createBoxSharedValue(0);

    using harness = mountSwipeHarness({
      renderedSidebarWidth,
      scrimOpacity,
      onCommitVisibility: vi.fn(),
    });
    const { content } = harness.getConfigs();

    // Mouse pointer fails immediately.
    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 350, y: 300, pointerType: 2 }),
    );
    expect(rnghHarness.fail).toHaveBeenCalledTimes(1);

    // Multi-touch fails immediately.
    rnghHarness.fail.mockReset();
    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 350, y: 300, numberOfTouches: 2 }),
    );
    expect(rnghHarness.fail).toHaveBeenCalledTimes(1);

    // Vertical/diagonal scroll drift fails without activating sidebar swipe.
    rnghHarness.fail.mockReset();
    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 350, y: 300 }),
    );
    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 368, y: 313 }),
    );
    expect(rnghHarness.activate).not.toHaveBeenCalled();
    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 374, y: 316 }),
    );
    expect(rnghHarness.fail).toHaveBeenCalledWith(content.handlerTag);
    expect(rnghHarness.activate).not.toHaveBeenCalled();

    // Stylus (S Pen on Fold) activates cleanly.
    rnghHarness.fail.mockReset();
    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 350, y: 300, pointerType: 1 }),
    );
    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 370, y: 302, pointerType: 1 }),
    );
    expect(rnghHarness.fail).not.toHaveBeenCalled();
    expect(rnghHarness.activate).toHaveBeenCalledWith(content.handlerTag);
  });

  it("switches seamlessly to scrim close on medium and content close on expanded", () => {
    const renderedSidebarWidth = createBoxSharedValue(320);
    const scrimOpacity = createBoxSharedValue(SIDEBAR_FLOATING_SCRIM_OPACITY);
    const onCommitVisibility = vi.fn();

    using harness = mountSwipeHarness({
      sidebarFloats: true,
      primarySidebarVisible: true,
      renderedSidebarWidth,
      scrimOpacity,
      onCommitVisibility,
    });

    const mediumConfigs = harness.getConfigs();
    expect(mediumConfigs.content.config.enabled).toBe(false);
    expect(mediumConfigs.scrim.config.enabled).toBe(true);

    mediumConfigs.scrim.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: mediumConfigs.scrim.handlerTag, x: 560, y: 300 }),
    );
    mediumConfigs.scrim.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: mediumConfigs.scrim.handlerTag, x: 538, y: 300 }),
    );
    expect(rnghHarness.activate).toHaveBeenCalledWith(mediumConfigs.scrim.handlerTag);

    mediumConfigs.scrim.config.onActivate?.(
      createPanEvent({
        handlerTag: mediumConfigs.scrim.handlerTag,
        absoluteX: 538,
      }) as PanGestureBeginEvent,
    );
    mediumConfigs.scrim.config.onUpdate?.(
      createPanEvent({
        handlerTag: mediumConfigs.scrim.handlerTag,
        absoluteX: 400,
      }) as PanGestureActiveEvent,
    );
    expect(renderedSidebarWidth.value).toBe(182);
    expect(scrimOpacity.value).toBeCloseTo(SIDEBAR_FLOATING_SCRIM_OPACITY * (182 / 320));

    mediumConfigs.scrim.config.onDeactivate?.(
      createPanEvent({
        handlerTag: mediumConfigs.scrim.handlerTag,
        absoluteX: 400,
        velocityX: -100,
      }) as PanGestureDeactivateEvent,
    );
    expect(onCommitVisibility).toHaveBeenCalledWith(false);

    // Expanded mode disables scrim close and enables content close without altering scrimOpacity.
    onCommitVisibility.mockReset();
    rnghHarness.activate.mockReset();
    renderedSidebarWidth.value = 320;
    scrimOpacity.value = 0;

    harness.update({
      sidebarFloats: false,
      primarySidebarVisible: true,
      renderedSidebarWidth,
      scrimOpacity,
      onCommitVisibility,
    });

    const expandedConfigs = harness.getConfigs();
    expect(expandedConfigs.content.config.enabled).toBe(true);
    expect(expandedConfigs.scrim.config.enabled).toBe(false);

    expandedConfigs.content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: expandedConfigs.content.handlerTag, x: 560, y: 300 }),
    );
    expandedConfigs.content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: expandedConfigs.content.handlerTag, x: 538, y: 300 }),
    );
    expandedConfigs.content.config.onActivate?.(
      createPanEvent({
        handlerTag: expandedConfigs.content.handlerTag,
        absoluteX: 538,
      }) as PanGestureBeginEvent,
    );
    expandedConfigs.content.config.onUpdate?.(
      createPanEvent({
        handlerTag: expandedConfigs.content.handlerTag,
        absoluteX: 400,
      }) as PanGestureActiveEvent,
    );
    expect(renderedSidebarWidth.value).toBe(182);
    expect(scrimOpacity.value).toBe(0);

    expandedConfigs.content.config.onDeactivate?.(
      createPanEvent({
        handlerTag: expandedConfigs.content.handlerTag,
        absoluteX: 400,
        velocityX: -500,
      }) as PanGestureDeactivateEvent,
    );
    expect(onCommitVisibility).toHaveBeenCalledWith(false);
  });

  it("commits short high-velocity flicks in either direction and disables gestures when ineligible", () => {
    const renderedSidebarWidth = createBoxSharedValue(0);
    const scrimOpacity = createBoxSharedValue(0);
    const onCommitVisibility = vi.fn();

    using harness = mountSwipeHarness({
      renderedSidebarWidth,
      scrimOpacity,
      onCommitVisibility,
    });

    // Short flick right (24dp travel after activation < 35% width, but velocityX > 420).
    const initialConfigs = harness.getConfigs();
    initialConfigs.content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: initialConfigs.content.handlerTag, x: 300, y: 300 }),
    );
    initialConfigs.content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: initialConfigs.content.handlerTag, x: 320, y: 300 }),
    );
    initialConfigs.content.config.onActivate?.(
      createPanEvent({
        handlerTag: initialConfigs.content.handlerTag,
        absoluteX: 320,
      }) as PanGestureBeginEvent,
    );
    initialConfigs.content.config.onUpdate?.(
      createPanEvent({
        handlerTag: initialConfigs.content.handlerTag,
        absoluteX: 344,
      }) as PanGestureActiveEvent,
    );
    initialConfigs.content.config.onDeactivate?.(
      createPanEvent({
        handlerTag: initialConfigs.content.handlerTag,
        absoluteX: 344,
        velocityX: 500,
      }) as PanGestureDeactivateEvent,
    );
    expect(onCommitVisibility).toHaveBeenCalledWith(true);

    // Pinned sidebar disables both gestures.
    harness.update({ primarySidebarPinned: true, primarySidebarVisible: true });
    const pinnedConfigs = harness.getConfigs();
    expect(pinnedConfigs.content.config.enabled).toBe(false);
    expect(pinnedConfigs.scrim.config.enabled).toBe(false);

    // Compact / non-split mode disables both gestures.
    harness.update({
      usesSplitView: false,
      primarySidebarPinned: false,
      primarySidebarVisible: false,
    });
    const compactConfigs = harness.getConfigs();
    expect(compactConfigs.content.config.enabled).toBe(false);
    expect(compactConfigs.scrim.config.enabled).toBe(false);
  });

  it("snaps back if an active swipe terminates via onFinalize without onDeactivate", () => {
    const renderedSidebarWidth = createBoxSharedValue(0);
    const scrimOpacity = createBoxSharedValue(0);
    const onCommitVisibility = vi.fn();

    using harness = mountSwipeHarness({
      renderedSidebarWidth,
      scrimOpacity,
      onCommitVisibility,
    });
    const { content } = harness.getConfigs();

    content.config.onTouchesDown?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 300, y: 300 }),
    );
    content.config.onTouchesMove?.(
      createTouchEvent({ handlerTag: content.handlerTag, x: 320, y: 300 }),
    );
    content.config.onActivate?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 320 }) as PanGestureBeginEvent,
    );
    content.config.onUpdate?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 460 }) as PanGestureActiveEvent,
    );
    expect(renderedSidebarWidth.value).toBe(140);

    content.config.onFinalize?.(
      createPanEvent({ handlerTag: content.handlerTag, absoluteX: 460 }) as PanGestureFinalizeEvent,
    );
    expect(onCommitVisibility).not.toHaveBeenCalled();
    expect(renderedSidebarWidth.value).toBe(0);
    expect(scrimOpacity.value).toBe(0);
  });
});
