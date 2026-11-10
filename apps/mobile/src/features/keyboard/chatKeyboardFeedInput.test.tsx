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
type Header = Pick<KeyboardChatScrollViewProps, "contentInset" | "obscuredStartInset">;

// The header props ThreadFeed passes: a native top inset on iOS 26+, a list-header spacer before.
const nativeInset = (top: number): Header => ({ contentInset: { top }, obscuredStartInset: top });
const headerSpacer = (top: number): Header => ({ obscuredStartInset: top });

// Composer padding 80 and a 300pt keyboard over a 678pt feed.
// The feed input sits at `inputTop` on screen while the feed rests at `restOffset`.
function renderFeed(
  restOffset: number,
  inputTop: number,
  keyboardLiftBehavior: LiftBehavior = "whenAtEnd",
  header: Header = nativeInset(80),
) {
  native.scroll.value = restOffset;
  let focused = INPUT_TAG;
  let contentOffsetY: Shared<number> | undefined;
  const freeze: Shared<boolean> = { value: false };
  function Feed() {
    const chat = useChatKeyboard({ current: null } as never, {
      inverted: false,
      keyboardLiftBehavior,
      freeze: freeze as never,
      offset: 0,
      initialContentOffsetY: restOffset,
      blankSpace: { value: 0 } as never,
      extraContentPadding: { value: 80 } as never,
      adjustedInsetCompensation: 0,
      adjustedStartInsetCompensation: 0,
      ...header,
    });
    chat.onLayout({} as LayoutChangeEvent);
    contentOffsetY = chat.contentOffsetY;
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Feed />));

  // Native applies each target offset before the next keyboard event.
  const transition = (height: number, refreshInput = true) => {
    if (refreshInput)
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
    // Native refreshes the focused input's layout on focus and edits, not on scroll.
    resize: (height: number) => transition(height, false),
    hide: () => transition(0),
    setFrozen: (frozen: boolean) => {
      freeze.value = frozen;
    },
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

it.each([
  ...[nativeInset(80), headerSpacer(80)].map((header) => ({
    name: `moves a partly hidden input below the header (${header.contentInset ? "native inset" : "header spacer"})`,
    behavior: "whenAtEnd" as const,
    header,
    restOffset: 1322,
    inputTop: 60,
    expected: [1302, 1322],
  })),
  {
    name: "leaves a feed resting at its top inset alone for an input in view",
    behavior: "whenAtEnd" as const,
    header: nativeInset(100),
    restOffset: -100,
    inputTop: 150,
    expected: [-100, -100],
  },
])("$name, then returns the feed to its offset", (row) => {
  using feed = renderFeed(row.restOffset, row.inputTop, row.behavior, row.header);

  expect([feed.open(), feed.hide()]).toEqual(row.expected);
});

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

it("keeps a lifted feed input in view when the keyboard resizes before native re-measures it", () => {
  using feed = renderFeed(500, 500);

  expect([feed.open(), feed.resize(340), feed.hide()]).toEqual([742, 782, 500]);
});

it("keeps the feed where it rests after the keyboard closed while frozen", () => {
  using feed = renderFeed(500, 500);

  feed.open();
  feed.setFrozen(true);
  feed.hide();
  feed.setFrozen(false);

  expect(feed.open(COMPOSER_TAG)).toBe(742);
});
