import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { LayoutChangeEvent } from "react-native";
import { expect, it, vi } from "vite-plus/test";

interface KeyboardStart {
  readonly height: number;
  readonly duration: number;
  readonly progress: number;
  readonly target: number;
}

const FEED_TAG = 7;
const FEED_INPUT_TAG = 21;
const COMPOSER_TAG = 22;
const VIEWPORT = 678;
const KEYBOARD = 300;
const COMPOSER = 80;
const HEADER = 80;

const native = vi.hoisted(() => ({
  onStart: (_event: KeyboardStart) => {},
  input: {
    value: null as {
      target: number;
      parentScrollViewTarget: number;
      layout: { contentY: number };
    } | null,
  },
  scroll: { value: 0 },
  layout: { value: { width: 466, height: 0 } },
  size: { value: { width: 466, height: 0 } },
}));

// Exercises the patched hook source with Reanimated and its native inputs replaced.
vi.mock("react-native-reanimated", () => ({
  useSharedValue: <T,>(initial: T) => useRef({ value: initial }).current,
  interpolate: (value: number) => value,
}));
vi.mock("react-native-keyboard-controller/src/hooks", () => ({
  useKeyboardHandler: (handlers: { onStart: (event: KeyboardStart) => void }) => {
    native.onStart = handlers.onStart;
  },
  useReanimatedFocusedInput: () => ({ input: native.input }),
}));
vi.mock("react-native-keyboard-controller/src/utils/findNodeHandle", () => ({
  findNodeHandle: () => FEED_TAG,
}));
vi.mock("react-native-keyboard-controller/src/components/hooks/useScrollState", () => ({
  default: () => ({
    layout: native.layout,
    size: native.size,
    offset: native.scroll,
    onLayout: () => {},
    onContentSizeChange: () => {},
  }),
}));

// Metro bundles the library source; a literal import would make tsc check that
// source against this app's React Native types, which it does not satisfy.
const chatKeyboardSource =
  "react-native-keyboard-controller/src/components/KeyboardChatScrollView/useChatKeyboard/index.ios";
const { useChatKeyboard } = (await import(
  chatKeyboardSource
)) as typeof import("react-native-keyboard-controller/lib/typescript/components/KeyboardChatScrollView/useChatKeyboard/index.ios");

function renderFeed(contentHeight: number) {
  native.layout.value = { width: 466, height: VIEWPORT };
  native.size.value = { width: 466, height: contentHeight };
  native.scroll.value = contentHeight - VIEWPORT + COMPOSER;
  native.input.value = null;

  let contentOffsetY: { value: number } | undefined;
  function Feed() {
    const chat = useChatKeyboard({ current: null } as never, {
      inverted: false,
      keyboardLiftBehavior: "whenAtEnd",
      freeze: { value: false } as never,
      offset: 0,
      blankSpace: { value: 0 } as never,
      extraContentPadding: { value: COMPOSER } as never,
      adjustedInsetCompensation: 0,
      adjustedStartInsetCompensation: 0,
      obscuredStartInset: HEADER,
    });
    chat.onLayout({ nativeEvent: { layout: { height: VIEWPORT } } } as LayoutChangeEvent);
    contentOffsetY = chat.contentOffsetY;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Feed />));

  // Runs a keyboard transition and lets the scroll view take the offset the hook asked for.
  const keyboard = (height: number, target: number) => {
    native.onStart({ height, duration: 250, progress: height > 0 ? 1 : 0, target });
    native.scroll.value = contentOffsetY?.value ?? Number.NaN;
    return native.scroll.value;
  };
  const focusFeedInput = (screenY: number) => {
    native.input.value = {
      target: FEED_INPUT_TAG,
      parentScrollViewTarget: FEED_TAG,
      layout: { contentY: native.scroll.value + screenY },
    };
    return keyboard(KEYBOARD, FEED_INPUT_TAG);
  };
  const focusComposer = () => {
    native.input.value = {
      target: COMPOSER_TAG,
      parentScrollViewTarget: -1,
      layout: { contentY: 0 },
    };
    return keyboard(KEYBOARD, COMPOSER_TAG);
  };
  const dismiss = () => {
    native.input.value = null;
    return keyboard(0, -1);
  };
  const grow = (by: number) => {
    native.size.value = { width: 466, height: native.size.value.height + by };
    native.scroll.value += by;
  };

  return {
    focusFeedInput,
    focusComposer,
    dismiss,
    grow,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("lifts a feed at its end only until the focused feed input reaches the header", () => {
  using feed = renderFeed(2000);
  const rest = 2000 - VIEWPORT + COMPOSER;

  // The full keyboard lift would carry an input 200 pt down the viewport 100 pt above it.
  expect(feed.focusFeedInput(200)).toBe(rest + 200 - HEADER);
  expect(feed.dismiss()).toBe(rest);

  // An input that stays clear of the header rides the full lift, as the composer does.
  expect(feed.focusFeedInput(468)).toBe(rest + KEYBOARD);
  expect(feed.dismiss()).toBe(rest);
  expect(feed.focusComposer()).toBe(rest + KEYBOARD);
  expect(feed.dismiss()).toBe(rest);
});

it("measures the feed input again on every keyboard open", () => {
  using feed = renderFeed(2000);
  const rest = 2000 - VIEWPORT + COMPOSER;

  expect(feed.focusFeedInput(200)).toBe(rest + 200 - HEADER);
  // Focus moving to the composer with the keyboard up takes back the withheld lift.
  expect(feed.focusComposer()).toBe(rest + KEYBOARD);
  expect(feed.dismiss()).toBe(rest);

  // Content grows while the feed follows its end, so the same input keeps its screen position.
  feed.grow(400);
  expect(feed.focusFeedInput(468)).toBe(rest + 400 + KEYBOARD);
  expect(feed.dismiss()).toBe(rest + 400);
  expect(feed.focusFeedInput(200)).toBe(rest + 400 + 200 - HEADER);
  expect(feed.dismiss()).toBe(rest + 400);
});
