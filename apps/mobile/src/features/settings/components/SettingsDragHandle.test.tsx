import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type PanEvent = { readonly translationY: number };
type PanHandlers = {
  onStart?: () => void;
  onUpdate?: (event: PanEvent) => void;
  onFinalize?: (event: PanEvent, success: boolean) => void;
};

const pans = vi.hoisted(() => [] as PanHandlers[]);

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: ({ children }: { children?: ReactNode }) => children,
  Gesture: {
    Pan: () => {
      const handlers: PanHandlers = {};
      pans.push(handlers);
      const pan = {
        minDistance: () => pan,
        shouldCancelWhenOutside: () => pan,
        runOnJS: () => pan,
        onStart: (callback: PanHandlers["onStart"]) => ((handlers.onStart = callback), pan),
        onUpdate: (callback: PanHandlers["onUpdate"]) => ((handlers.onUpdate = callback), pan),
        onFinalize: (callback: PanHandlers["onFinalize"]) => (
          (handlers.onFinalize = callback),
          pan
        ),
      };
      return pan;
    },
  },
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));

import { SettingsDragHandle } from "./SettingsDragHandle";

describe("SettingsDragHandle", () => {
  // The worklets Babel plugin copies values a gesture callback closes over when the gesture is
  // built, so a drop must not read a translation tracked in a local variable.
  it("reports the released translation when the pan ends", () => {
    pans.length = 0;
    const onEnd = vi.fn();
    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <SettingsDragHandle
          title="Built-in microphone"
          canMoveUp
          canMoveDown
          onStart={() => {}}
          onMove={() => {}}
          onEnd={onEnd}
          onStep={() => {}}
        />,
      ),
    );
    const pan = pans.at(-1)!;

    act(() => {
      pan.onStart?.();
      pan.onUpdate?.({ translationY: 64 });
      pan.onUpdate?.({ translationY: 130 });
      pan.onFinalize?.({ translationY: 130 }, true);
    });

    expect(onEnd).toHaveBeenCalledWith(130, false);
    act(() => root.unmount());
  });
});
