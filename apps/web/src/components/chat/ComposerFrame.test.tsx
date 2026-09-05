import { act, createRef, useCallback, useLayoutEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerFrame, type ComposerFrameLayout, type ComposerFrameMode } from "./ComposerFrame";
import { timelineContentOverflowsViewport } from "./timelineScrollAnchoring";

function createAnimation(duration: number, onStop: () => void) {
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    onStop();
    finish?.();
  };
  return {
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration }) },
    finished,
    cancel: vi.fn(stop),
    finish: stop,
  };
}

// The fixture models natural height and the animation's temporary height.
// Browser checks cover CSS geometry. These tests cover the frame's lifecycle.
function createElementFixture(naturalHeight: number) {
  const selectors = new Map<string, object>();
  const animations: ReturnType<typeof createAnimation>[] = [];
  const style = {
    height: "",
    removeProperty(property: string) {
      const key = property.replace(/-([a-z])/g, (_: string, letter: string) =>
        letter.toUpperCase(),
      );
      Reflect.set(style, key, "");
      return "";
    },
  };
  const element = {
    naturalHeight,
    animatedHeight: null as number | null,
    style,
    selectors,
    animations,
    getBoundingClientRect() {
      const height = style.height
        ? Number.parseFloat(style.height)
        : (element.animatedHeight ?? element.naturalHeight);
      return { top: 600 - height, bottom: 600, height };
    },
    querySelector: (selector: string) => selectors.get(selector) ?? null,
    querySelectorAll: () => [],
    animate: vi.fn((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      element.animatedHeight = Number.parseFloat(String(keyframes[0]?.height));
      const animation = createAnimation(Number(options.duration), () => {
        element.animatedHeight = null;
      });
      animations.push(animation);
      return animation;
    }),
  };
  return element;
}

class TestResizeObserver {
  static active = new Set<TestResizeObserver>();
  readonly targets = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.active.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  disconnect() {
    TestResizeObserver.active.delete(this);
  }

  static resize(...elements: ReturnType<typeof createElementFixture>[]) {
    for (const observer of TestResizeObserver.active) {
      const entries = elements
        .filter((element) => observer.targets.has(element as unknown as Element))
        .map((target) => ({ target })) as unknown as ResizeObserverEntry[];
      if (entries.length > 0) {
        observer.callback(entries, observer as unknown as ResizeObserver);
      }
    }
  }
}

interface FrameInput {
  mode: ComposerFrameMode;
  layoutKey: string;
  height: number;
  showContextStrip: boolean;
  isDraftHeroState: boolean;
}

let renderer: ReactTestRenderer | null;
let overlay: ReturnType<typeof createElementFixture>;
let main: ReturnType<typeof createElementFixture>;
let body: ReturnType<typeof createElementFixture>;
let onLayoutChange: ReturnType<typeof vi.fn<(layout: ComposerFrameLayout) => void>>;
let input: FrameInput;
let reducedMotion: boolean;
const restingControlsRef = createRef<HTMLDivElement>();

function CommitGeometry({ height }: { height: number }) {
  // Apply the fixture's DOM geometry before the frame's layout effect.
  useLayoutEffect(() => {
    overlay.naturalHeight = height;
    main.naturalHeight = height - 60;
  }, [height]);
  return null;
}

function FrameCommit({
  reportLayout = onLayoutChange,
  ...props
}: FrameInput & { reportLayout?: (layout: ComposerFrameLayout) => void }) {
  return (
    <>
      <CommitGeometry height={props.height} />
      <ComposerFrame
        {...props}
        headline={null}
        contextStrip={null}
        transitionGroupRef={null}
        composerAnchorRef={null}
        viewTransitionName={undefined}
        restingControlsRef={restingControlsRef}
        onLayoutChange={reportLayout}
      >
        <div data-chat-composer-main-surface="true" />
      </ComposerFrame>
    </>
  );
}

async function renderFrame(update: Partial<FrameInput> = {}) {
  input = { ...input, ...update };
  await act(async () => {
    if (renderer) {
      renderer.update(<FrameCommit {...input} />);
    } else {
      renderer = create(<FrameCommit {...input} />, {
        createNodeMock: () => overlay,
      });
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  reducedMotion = false;
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: reducedMotion }),
  });
  overlay = createElementFixture(240);
  main = createElementFixture(180);
  body = createElementFixture(132);
  overlay.selectors.set('[data-chat-composer-main-surface="true"]', main);
  main.selectors.set('[data-chat-composer-surface="true"]', createElementFixture(180));
  main.selectors.set('[data-chat-composer-body="true"]', body);
  onLayoutChange = vi.fn();
  renderer = null;
  input = {
    mode: "expanded",
    layoutKey: "thread-a",
    height: 240,
    showContextStrip: false,
    isDraftHeroState: false,
  };
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  expect(TestResizeObserver.active.size).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ComposerFrame", () => {
  it("settles initial timeline overflow without animating a new thread", async () => {
    function TimelineProbe({
      composerInset,
      onOverflowChange,
    }: {
      composerInset: number;
      onOverflowChange: (overflows: boolean) => void;
    }) {
      useLayoutEffect(() => {
        onOverflowChange(
          timelineContentOverflowsViewport(
            {
              data: ["message"],
              scroll: 0,
              scrollLength: 800,
              positionAtIndex: () => 0,
              sizeAtIndex: () => 650,
            },
            { composerInset, anchorOffset: 24 },
          ),
        );
      }, [composerInset, onOverflowChange]);
      return null;
    }

    function OverflowFeedback() {
      const [layout, setLayout] = useState<ComposerFrameLayout>({
        mode: "expanded",
        visibleHeight: 0,
        reservedHeight: 0,
      });
      const [overflows, setOverflows] = useState(false);
      const reportLayout = useCallback((next: ComposerFrameLayout) => {
        onLayoutChange(next);
        setLayout(next);
      }, []);
      const height = overflows ? 120 : 240;
      return (
        <>
          <TimelineProbe composerInset={layout.reservedHeight} onOverflowChange={setOverflows} />
          <FrameCommit
            {...input}
            mode={overflows ? "resting" : "expanded"}
            height={height}
            reportLayout={reportLayout}
          />
        </>
      );
    }

    await act(async () => {
      renderer = create(<OverflowFeedback />, { createNodeMock: () => overlay });
    });
    expect(onLayoutChange).toHaveBeenLastCalledWith({
      mode: "resting",
      visibleHeight: 120,
      reservedHeight: 240,
    });
    expect(main.animate).not.toHaveBeenCalled();
    expect(overlay.style.height).toBe("");
  });

  it("publishes mode and destination together without per-frame updates", async () => {
    await renderFrame();
    onLayoutChange.mockClear();

    await renderFrame({ mode: "resting", height: 120, showContextStrip: true });
    expect(onLayoutChange.mock.calls).toEqual([
      [{ mode: "resting", visibleHeight: 120, reservedHeight: 240 }],
    ]);
    expect(overlay.style.height).toBe("120px");

    main.animatedHeight = 140;
    await act(() => TestResizeObserver.resize(main, overlay));
    main.animatedHeight = 90;
    await act(() => TestResizeObserver.resize(main, overlay));
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    await act(() => main.animations[0]?.finish());
    expect(overlay.style.height).toBe("");
    await act(() => TestResizeObserver.resize(overlay));
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    await renderFrame({ mode: "expanded", height: 240 });
    expect(onLayoutChange).toHaveBeenLastCalledWith({
      mode: "expanded",
      visibleHeight: 240,
      reservedHeight: 240,
    });
  });

  it("drops the desktop reservation at the phone breakpoint even if height is unchanged", async () => {
    await renderFrame({ mode: "resting", height: 120 });
    expect(onLayoutChange).toHaveBeenLastCalledWith({
      mode: "resting",
      visibleHeight: 120,
      reservedHeight: 214,
    });

    await renderFrame({ mode: "mobile-collapsed" });
    expect(onLayoutChange).toHaveBeenLastCalledWith({
      mode: "mobile-collapsed",
      visibleHeight: 120,
      reservedHeight: 120,
    });
    expect(main.animate).not.toHaveBeenCalled();
  });

  it("cancels the old thread's transition and starts a new reservation", async () => {
    await renderFrame({ height: 450 });
    await renderFrame({ mode: "resting", height: 120 });
    const interrupted = main.animations[0];
    expect(interrupted).toBeDefined();
    onLayoutChange.mockClear();

    await renderFrame({ layoutKey: "thread-b", height: 100 });
    expect(interrupted?.cancel).toHaveBeenCalledOnce();
    expect(overlay.style.height).toBe("");
    expect(main.animations).toHaveLength(1);
    expect(onLayoutChange.mock.calls).toEqual([
      [{ mode: "resting", visibleHeight: 100, reservedHeight: 194 }],
    ]);
  });

  it("retargets a changing body and context strip with one coherent reservation", async () => {
    await renderFrame();
    await renderFrame({ mode: "resting", height: 120 });
    const first = main.animations[0];
    onLayoutChange.mockClear();

    overlay.naturalHeight = 260;
    main.naturalHeight = 200;
    await act(() => TestResizeObserver.resize(body));
    expect(first?.cancel).toHaveBeenCalledOnce();
    expect(onLayoutChange.mock.calls).toEqual([
      [{ mode: "resting", visibleHeight: 260, reservedHeight: 354 }],
    ]);
    expect(overlay.style.height).toBe("260px");

    await renderFrame({ height: 290, showContextStrip: true });
    expect(onLayoutChange).toHaveBeenLastCalledWith({
      mode: "resting",
      visibleHeight: 290,
      reservedHeight: 384,
    });
    expect(overlay.style.height).toBe("290px");
  });

  it("updates natural height without animation for reduced motion", async () => {
    reducedMotion = true;
    await renderFrame();
    await renderFrame({ mode: "resting", height: 120 });
    expect(main.animate).not.toHaveBeenCalled();
    expect(overlay.style.height).toBe("");

    await renderFrame({ mode: "expanded", height: 240 });
    onLayoutChange.mockClear();
    overlay.naturalHeight = 280.2;
    await act(() => TestResizeObserver.resize(overlay));
    overlay.naturalHeight = 280.4;
    await act(() => TestResizeObserver.resize(overlay));
    expect(onLayoutChange.mock.calls).toEqual([
      [{ mode: "expanded", visibleHeight: 281, reservedHeight: 281 }],
    ]);
  });

  it("releases a pin when the document timeline stops or the frame unmounts", async () => {
    await renderFrame();
    await renderFrame({ mode: "resting", height: 120 });
    await act(() => vi.runAllTimers());
    expect(overlay.style.height).toBe("");
    expect(main.animations[0]?.cancel).toHaveBeenCalledOnce();

    await renderFrame({ mode: "expanded", height: 240 });
    expect(overlay.style.height).toBe("240px");
    await act(() => renderer?.unmount());
    renderer = null;
    expect(overlay.style.height).toBe("");
    expect(main.animations[1]?.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
