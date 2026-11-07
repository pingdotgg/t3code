import { act } from "react";
import { createRoot } from "react-dom/client";
import type { LayoutChangeEvent } from "react-native";
import type { KeyboardChatScrollViewProps, NativeEvent } from "react-native-keyboard-controller";
import { expect, it, vi } from "vite-plus/test";

const FEED_TAG = 7;
const INPUT_TAG = 42;
const COMPOSER_TAG = 43;

type Shared<T> = { value: T };
type FocusedInput = {
  target: number;
  parentScrollViewTarget: number;
  layout: { absoluteY: number; height: number };
};
type KeyboardHandler = {
  onStart: (event: NativeEvent) => void;
  onEnd: (event: NativeEvent) => void;
};

const native = vi.hoisted(() => ({
  handler: null as KeyboardHandler | null,
  input: { value: null } as Shared<FocusedInput | null>,
  scroll: { value: 0 } as Shared<number>,
}));

// Exercises the patched iOS hook with only Reanimated and native measurement replaced.
vi.mock("react-native-reanimated", () => ({
  useSharedValue: <T,>(value: T): Shared<T> => ({ value }),
  measure: () => ({ pageY: 0 }),
  interpolate: () => 0,
}));
vi.mock("react-native-keyboard-controller/src/hooks", () => ({
  useKeyboardHandler: (handler: KeyboardHandler) => {
    native.handler = handler;
  },
  useReanimatedFocusedInput: () => ({ input: native.input }),
}));
vi.mock("react-native-keyboard-controller/src/utils/findNodeHandle", () => ({
  findNodeHandle: () => FEED_TAG,
}));
vi.mock("react-native-keyboard-controller/src/components/hooks/useScrollState", () => ({
  default: () => ({
    layout: { value: { width: 466, height: 678 } },
    size: { value: { width: 466, height: 2000 } },
    offset: native.scroll,
    onLayout: () => {},
    onContentSizeChange: () => {},
  }),
}));

// Metro bundles the library source; a literal import would also make tsc check
// that source against this app's React Native types, which it does not satisfy.
const chatKeyboardSource =
  "react-native-keyboard-controller/src/components/KeyboardChatScrollView/useChatKeyboard/index.ios";
const { useChatKeyboard } = (await import(
  chatKeyboardSource
)) as typeof import("react-native-keyboard-controller/lib/typescript/components/KeyboardChatScrollView/useChatKeyboard/index.ios");

type LiftBehavior = NonNullable<KeyboardChatScrollViewProps["keyboardLiftBehavior"]>;

// Header inset 80, composer padding 80, and a 300pt keyboard over a 678pt feed.
// The feed input sits at `inputTop` on screen while the feed rests at `restOffset`.
function renderFeed(
  restOffset: number,
  inputTop: number,
  keyboardLiftBehavior: LiftBehavior = "whenAtEnd",
) {
  native.scroll.value = restOffset;
  let focused = INPUT_TAG;
  let contentOffsetY: Shared<number> | undefined;
  function Feed() {
    const chat = useChatKeyboard({ current: null } as never, {
      inverted: false,
      keyboardLiftBehavior,
      freeze: { value: false } as never,
      offset: 0,
      initialContentOffsetY: restOffset,
      blankSpace: { value: 0 } as never,
      extraContentPadding: { value: 80 } as never,
      adjustedInsetCompensation: 0,
      adjustedStartInsetCompensation: 80,
    });
    chat.onLayout({} as LayoutChangeEvent);
    contentOffsetY = chat.contentOffsetY;
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Feed />));

  // Native applies each target offset before the next keyboard event.
  const transition = (height: number) => {
    native.input.value =
      focused === INPUT_TAG
        ? {
            target: INPUT_TAG,
            parentScrollViewTarget: FEED_TAG,
            layout: { absoluteY: inputTop + restOffset - native.scroll.value, height: 40 },
          }
        : {
            target: COMPOSER_TAG,
            parentScrollViewTarget: -1,
            layout: { absoluteY: 600, height: 40 },
          };
    const event = { height, duration: 250, progress: height > 0 ? 1 : 0, target: focused };
    native.handler?.onStart(event);
    native.scroll.value = contentOffsetY?.value ?? Number.NaN;
    native.handler?.onEnd(event);
    return native.scroll.value;
  };
  return {
    open: (target = INPUT_TAG) => {
      focused = target;
      return transition(300);
    },
    hide: () => transition(0),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

const liftBehaviors: LiftBehavior[] = ["whenAtEnd", "always", "never", "persistent"];

it.each(liftBehaviors)(
  "returns the feed to its offset when hiding the keyboard for a covered input away from the end (%s)",
  (behavior) => {
    using feed = renderFeed(500, 500, behavior);

    expect([feed.open(), feed.hide()]).toEqual([742, 500]);
  },
);

it.each(liftBehaviors)(
  "returns the feed to its offset after moving a partly hidden input down below the header (%s)",
  (behavior) => {
    using feed = renderFeed(1322, 60, behavior);

    expect([feed.open(), feed.hide()]).toEqual([1302, 1322]);
  },
);

it("returns the feed to its offset when focus moves from an unlifted composer to a feed input", () => {
  using feed = renderFeed(500, 500);

  expect([feed.open(COMPOSER_TAG), feed.open(), feed.hide()]).toEqual([500, 742, 500]);
});

it("undoes the feed input shift before lifting for the composer at the end", () => {
  using feed = renderFeed(1322, 500);

  expect([feed.open(), feed.open(COMPOSER_TAG), feed.hide()]).toEqual([1564, 1622, 1322]);
});

it("lifts for the composer and returns to the end after a feed input moved the feed down", () => {
  using feed = renderFeed(1322, 40);

  expect([feed.open(), feed.open(COMPOSER_TAG), feed.hide()]).toEqual([1282, 1622, 1322]);
});
