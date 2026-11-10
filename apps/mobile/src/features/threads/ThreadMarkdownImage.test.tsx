import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type HandlerProps = Record<string, ((event: unknown) => void) | undefined>;
type GestureHandlers = Record<string, (event: unknown, manager?: unknown) => void>;
type Transform = [{ translateX: number }, { translateY: number }, { scale: number }];

const harness = vi.hoisted(() => ({
  failImage: () => {},
  loadImage: (_event: { source: { width: number; height: number } }) => {},
  Passthrough: ({ children }: { children?: unknown }) => children,
  pressable: {} as HandlerProps,
  gestures: {} as Record<string, GestureHandlers>,
  contentStyle: () => ({}) as { transform?: Transform },
}));

vi.mock("react-native", () => {
  const View = ({ children, style }: { children?: ReactNode; style?: unknown }) => (
    <div data-style={JSON.stringify(style)}>{children}</div>
  );
  return {
    Platform: { OS: "ios" },
    Pressable: (props: HandlerProps & { children?: ReactNode; style?: unknown }) => {
      harness.pressable = props;
      return <View style={props.style}>{props.children}</View>;
    },
    StyleSheet: { absoluteFill: {} },
    View,
  };
});
vi.mock("react-native-gesture-handler", () => {
  // Records each gesture's callbacks so a test can drive the worklets with native-shaped events.
  const builder = (kind: string) => () => {
    const handlers: GestureHandlers = {};
    harness.gestures[kind] = handlers;
    const gesture: object = new Proxy(
      {},
      {
        get: (_target, name) => (callback: GestureHandlers[string]) => {
          if (typeof name === "string" && name.startsWith("on")) handlers[name] = callback;
          return gesture;
        },
      },
    );
    return gesture;
  };
  return {
    Gesture: { Pinch: builder("pinch"), Pan: builder("pan"), Simultaneous: () => ({}) },
    GestureDetector: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("react-native-reanimated", async () => {
  const { useState } = await import("react");
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    runOnJS: (callback: () => void) => callback,
    // Reads the UI-thread style on demand, as Reanimated would after a gesture frame.
    useAnimatedStyle: (updater: () => { transform?: Transform }) => {
      harness.contentStyle = updater;
      return {};
    },
    useSharedValue: <T,>(initial: T) =>
      useState(() => {
        let value = initial;
        return { get: () => value, set: (next: T) => void (value = next) };
      })[0],
  };
});
vi.mock("expo-image", () => ({
  Image: (props: {
    onError: () => void;
    onLoad: (event: { source: { width: number; height: number } }) => void;
  }) => {
    harness.failImage = props.onError;
    harness.loadImage = props.onLoad;
    return <img alt="" />;
  },
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("react-native-svg", () => ({ parse: vi.fn(), SvgAst: () => null }));
vi.mock("@t3tools/client-runtime/state/assets", () => ({ MISSING_FILE_ACCESS_MESSAGE: "" }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (source: unknown) => source,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/MediaActionsMenu", () => ({ MediaActionsMenu: harness.Passthrough }));
vi.mock("../../components/ui/NativePresentation", () => ({
  PresentationSource: harness.Passthrough,
}));
vi.mock("../../state/mediaActions", () => ({ useMediaActions: () => ({ actions: [] }) }));
vi.mock("../../state/assets", () => ({ useAssetUrlState: vi.fn() }));

import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { fetch } from "expo/fetch";
import { parse } from "react-native-svg";

import { MarkdownImageAvailableWidthContext, ThreadMarkdownImageView } from "./ThreadMarkdownImage";

it("keeps the frame size when the same image reports a different decoded width", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const frameSize = () =>
    [...container.querySelectorAll<HTMLElement>("div[data-style]")]
      .map((element) => JSON.parse(element.dataset.style ?? "null") as Record<string, unknown>)
      .find((style) => typeof style?.width === "number");
  try {
    await act(async () =>
      root.render(
        <MarkdownImageAvailableWidthContext value={345}>
          <ThreadMarkdownImageView
            uri="https://example.test/hero.png"
            sourceKey="workspace:hero.png"
            unavailable={false}
            alt={null}
            knownSize={{ width: 1000, height: 585 }}
            onPressPreview={() => {}}
          />
        </MarkdownImageAvailableWidthContext>,
      ),
    );
    // Android reports the bitmap downsampled for the current frame, so the same file
    // alternates between widths (969 and 970 of 1000) as the frame changes size.
    await act(async () => harness.loadImage({ source: { width: 970, height: 567 } }));
    const first = frameSize();
    expect(first).toBeDefined();

    await act(async () => harness.loadImage({ source: { width: 969, height: 567 } }));
    expect(frameSize()).toEqual(first);
  } finally {
    await act(async () => root.unmount());
  }
});

it("retries a failed image once its URI comes back through null", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const view = (uri: string | null) => (
    <ThreadMarkdownImageView
      uri={uri}
      sourceKey="attachment:a"
      unavailable={false}
      alt={null}
      onPressPreview={() => {}}
    />
  );
  try {
    await act(async () => root.render(view("https://example.test/a.png")));
    await act(async () => harness.failImage());
    expect(container.textContent).toContain("Image unavailable");

    await act(async () => root.render(view(null)));
    await act(async () => root.render(view("https://example.test/a.png")));
    expect(container.textContent).not.toContain("Image unavailable");
    expect(container.querySelector("img")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("fetches a failed SVG again on the next mount but keeps a parsed one", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Microtask scheduling lets act() flush an unmounted atom's removal before the next render.
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      queueMicrotask(task);
      return () => {};
    },
  });
  const fetchSvg = vi.mocked(fetch);
  vi.mocked(parse).mockReturnValue({ props: {} } as ReturnType<typeof parse>);
  const container = document.createElement("div");
  const root = createRoot(container);
  const uri = "https://example.test/a.svg";
  const view = (mounted: boolean) => (
    <RegistryContext.Provider value={registry}>
      {mounted ? (
        <ThreadMarkdownImageView
          uri={uri}
          sourceKey="attachment:svg"
          unavailable={false}
          alt={null}
          format="svg"
          onPressPreview={() => {}}
        />
      ) : null}
    </RegistryContext.Provider>
  );
  try {
    fetchSvg.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(view(true)));
    await vi.waitFor(() => expect(container.textContent).toContain("Image unavailable"));

    await act(async () => root.render(view(false)));
    fetchSvg.mockResolvedValue({ ok: true, status: 200, text: async () => "<svg />" } as never);
    await act(async () => root.render(view(true)));
    await vi.waitFor(() => expect(container.textContent).not.toContain("Image unavailable"));
    expect(fetchSvg).toHaveBeenCalledTimes(2);

    await act(async () => root.render(view(false)));
    await act(async () => root.render(view(true)));
    expect(container.textContent).not.toContain("Image unavailable");
    expect(fetchSvg).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
  }
});

it("does not parse an obsolete SVG response after its last reader unmounts", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      queueMicrotask(task);
      return () => {};
    },
  });
  const root = createRoot(document.createElement("div"));
  const fetchSvg = vi.mocked(fetch);
  const parseSvg = vi.mocked(parse);
  fetchSvg.mockReset();
  parseSvg.mockClear();
  const body = Promise.withResolvers<string>();
  fetchSvg.mockResolvedValue({ ok: true, status: 200, text: () => body.promise } as never);
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ThreadMarkdownImageView
            uri="https://example.test/obsolete.svg"
            sourceKey="attachment:obsolete"
            unavailable={false}
            alt={null}
            format="svg"
            onPressPreview={() => {}}
          />
        </RegistryContext.Provider>,
      ),
    );
    expect(fetchSvg).toHaveBeenCalledOnce();
    const signal = fetchSvg.mock.calls[0]![1]!.signal!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => body.resolve("<svg />"));
    expect(parseSvg).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
  }
});

const zoom = () => {
  const [{ translateX }, { translateY }, { scale }] = harness.contentStyle().transform!;
  // Clamping at fit can yield -0, which is the same position.
  return { scale, x: translateX + 0, y: translateY + 0 };
};
const pinch = (phase: "onStart" | "onUpdate", focalX: number, focalY: number, scale: number) =>
  act(async () => harness.gestures.pinch![phase]!({ focalX, focalY, scale, numberOfPointers: 2 }));
const endPinch = () => act(async () => harness.gestures.pinch!.onFinalize!({}));
const layout = (width: number, height: number) =>
  act(async () => harness.pressable.onLayout?.({ nativeEvent: { layout: { width, height } } }));
const markdownImage = (sourceKey: string, onPressPreview: () => void = () => {}) => (
  <MarkdownImageAvailableWidthContext value={345}>
    <ThreadMarkdownImageView
      uri={`https://example.test/${sourceKey}.png`}
      sourceKey={sourceKey}
      unavailable={false}
      alt={null}
      knownSize={{ width: 1000, height: 585 }}
      onPressPreview={onPressPreview}
    />
  </MarkdownImageAvailableWidthContext>
);

it("does not open the preview when a touch on the inline image pinches or pans it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const onPressPreview = vi.fn();
  const touch = (fingers: number) =>
    act(async () =>
      harness.pressable.onTouchStart?.({
        nativeEvent: { touches: Array.from({ length: fingers }, () => ({})) },
      }),
    );
  const release = () =>
    act(async () => harness.pressable.onPress?.({ nativeEvent: { identifier: 1 } }));
  try {
    await act(async () => root.render(markdownImage("hero", onPressPreview)));
    await touch(1);
    await touch(2);
    await release();
    expect(onPressPreview).not.toHaveBeenCalled();

    await touch(1);
    await act(async () => harness.gestures.pan!.onStart!({ translationX: 5, translationY: 0 }));
    await release();
    expect(onPressPreview).not.toHaveBeenCalled();

    await touch(1);
    await release();
    expect(onPressPreview).toHaveBeenCalledOnce();

    // VoiceOver activation has no touch, so an earlier pinch must not swallow it.
    await touch(2);
    await act(async () => harness.pressable.onPress?.({ nativeEvent: {} }));
    expect(onPressPreview).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});

it("zooms the inline image around the pinch and keeps it until the source or frame changes", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const touchPan = () => {
    const manager = { fail: vi.fn() };
    harness.gestures.pan!.onTouchesDown!({}, manager);
    return manager;
  };
  try {
    await act(async () => root.render(markdownImage("a")));
    // The frame center is (172.5, 101); the pinch is off center.
    await layout(345, 202);
    await pinch("onStart", 300, 150, 1);
    await pinch("onUpdate", 300, 150, 2);
    expect(zoom()).toEqual({ scale: 2, x: -127.5, y: -49 });
    await pinch("onUpdate", 280, 140, 2);
    expect(zoom()).toEqual({ scale: 2, x: -147.5, y: -59 });
    await act(async () =>
      harness.gestures.pinch!.onUpdate!({ focalX: 90, focalY: 90, scale: 2, numberOfPointers: 1 }),
    );
    expect(zoom()).toEqual({ scale: 2, x: -147.5, y: -59 });
    await endPinch();

    await act(async () => harness.loadImage({ source: { width: 1000, height: 585 } }));
    await act(async () => root.render(markdownImage("a")));
    await layout(345, 202);
    expect(zoom()).toEqual({ scale: 2, x: -147.5, y: -59 });

    await pinch("onStart", 100, 50, 1);
    await pinch("onUpdate", 100, 50, 1.5);
    expect(zoom()).toEqual({ scale: 3, x: -185, y: -63 });
    await pinch("onUpdate", 100, 50, 10);
    expect(zoom().scale).toBe(6);
    await endPinch();

    const zoomedPan = touchPan();
    await act(async () => harness.gestures.pan!.onStart!({ translationX: 5, translationY: 0 }));
    await act(async () =>
      harness.gestures.pan!.onUpdate!({ translationX: 5000, translationY: -5000 }),
    );
    expect(zoomedPan.fail).not.toHaveBeenCalled();
    expect(zoom()).toEqual({ scale: 6, x: 862.5, y: -505 });

    await pinch("onStart", 172, 100, 1);
    await pinch("onUpdate", 172, 100, 0.01);
    await endPinch();
    expect(zoom()).toEqual({ scale: 1, x: 0, y: 0 });
    expect(touchPan().fail).toHaveBeenCalledOnce();

    await pinch("onStart", 300, 150, 1);
    await pinch("onUpdate", 300, 150, 2);
    await endPinch();
    await layout(300, 175);
    expect(zoom()).toEqual({ scale: 1, x: 0, y: 0 });

    await pinch("onStart", 300, 150, 1);
    await pinch("onUpdate", 300, 150, 2);
    await endPinch();
    await act(async () => root.render(markdownImage("b")));
    expect(zoom()).toEqual({ scale: 1, x: 0, y: 0 });

    for (const panFirst of [true, false]) {
      await act(async () => root.render(markdownImage(`handoff-${panFirst}`)));
      await layout(300, 200);
      await pinch("onStart", 150, 100, 1);
      await pinch("onUpdate", 150, 100, 2);
      await endPinch();
      await act(async () => harness.gestures.pan!.onStart!({ translationX: 0, translationY: 0 }));
      await pinch("onStart", 150, 100, 1);
      const panUpdate = () =>
        act(async () => harness.gestures.pan!.onUpdate!({ translationX: 10, translationY: 0 }));
      if (panFirst) await panUpdate();
      await pinch("onUpdate", 150, 100, 1.5);
      if (!panFirst) await panUpdate();
      await endPinch();
      await act(async () => harness.gestures.pan!.onUpdate!({ translationX: 20, translationY: 0 }));
      expect(zoom()).toEqual({ scale: 3, x: 10, y: 0 });
    }
  } finally {
    await act(async () => root.unmount());
  }
});
