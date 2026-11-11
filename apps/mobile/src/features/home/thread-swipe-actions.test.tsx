import type { ReactNode } from "react";
import { act } from "react";
import type { AccessibilityActionEvent } from "react-native";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => {
  const View = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return { View, Pressable: View };
});
vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    default: { View },
    cancelAnimation: () => undefined,
    Easing: { out: () => undefined, cubic: undefined },
    Extrapolation: { CLAMP: "clamp" },
    ReduceMotion: { System: "system" },
    interpolate: () => 0,
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    runOnUI: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedReaction: () => undefined,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => ({ value, get: () => value, set: () => undefined }),
    withTiming: (value: unknown) => value,
  };
});
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({
  default: (props: {
    readonly children?: ReactNode;
    readonly renderRightActions: (
      progress: unknown,
      translation: unknown,
      methods: unknown,
    ) => ReactNode;
  }) => {
    const translation = { value: 0, get: () => 0, set: () => undefined };
    const methods = { close: () => undefined, reset: () => undefined };
    return (
      <div>
        {props.children}
        {props.renderRightActions(translation, translation, methods)}
      </div>
    );
  },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Medium: "medium" },
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ children }: { readonly children?: ReactNode }) => children,
}));

import { withThreadDismissal } from "./thread-dismissal";
import { ThreadSwipeable, type ThreadSwipeAccessibility } from "./thread-swipe-actions";

function renderSwipeRow(
  children: (close: () => void, swipeAccessibility: ThreadSwipeAccessibility) => ReactNode,
) {
  const onSettle = vi.fn();
  const onSnooze = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <ThreadSwipeable
        backgroundColor="white"
        fullSwipeWidth={360}
        onDelete={() => undefined}
        primaryAction={{
          accessibilityLabel: "Settle Fix login",
          icon: "checkmark",
          label: "Settle",
          onPress: onSettle,
        }}
        secondaryAction={{
          accessibilityLabel: "Choose when to snooze Fix login",
          icon: "clock",
          label: "Snooze",
          menu: {
            actions: [
              { id: "snooze:tomorrow", title: "Tomorrow" },
              { id: "snooze:next-week", title: "Next week" },
            ],
            onPressAction: onSnooze,
            title: "Snooze until",
          },
          onPress: () => undefined,
        }}
        threadKey="thread-1"
        threadTitle="Fix login"
      >
        {children}
      </ThreadSwipeable>,
    ),
  );
  return {
    onSettle,
    onSnooze,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("exposes the swipe actions to screen readers as row accessibility actions", () => {
  let swipeAccessibility: ThreadSwipeAccessibility | undefined;
  using row = renderSwipeRow((_close, accessibility) => {
    swipeAccessibility = accessibility;
    return null;
  });

  expect(swipeAccessibility?.accessibilityActions).toEqual([
    expect.objectContaining({ label: expect.stringContaining("Settle") }),
    expect.objectContaining({ label: expect.stringContaining("Tomorrow") }),
    expect.objectContaining({ label: expect.stringContaining("Next week") }),
  ]);
  const [settle, , nextWeek] = swipeAccessibility!.accessibilityActions;
  const invoke = (actionName: string) =>
    act(() =>
      swipeAccessibility!.onAccessibilityAction({
        nativeEvent: { actionName },
      } as AccessibilityActionEvent),
    );
  invoke(settle!.name);
  invoke(nextWeek!.name);
  expect(row.onSettle).toHaveBeenCalledTimes(1);
  expect(row.onSnooze).toHaveBeenCalledTimes(1);
  expect(row.onSnooze).toHaveBeenCalledWith({ nativeEvent: { event: "snooze:next-week" } });

  act(() => {
    void withThreadDismissal("thread-1", () => Promise.resolve(true), Boolean);
  });
  invoke(settle!.name);
  expect(row.onSettle, "a dismissing row ignores screen-reader actions").toHaveBeenCalledTimes(1);
});
