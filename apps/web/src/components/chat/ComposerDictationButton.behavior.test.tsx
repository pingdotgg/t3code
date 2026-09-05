import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerDictationButton } from "./ComposerDictationButton";

vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  void act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.unstubAllGlobals();
});

function renderButton(props: {
  phase: "idle" | "requesting" | "recording" | "transcribing";
  disabled: boolean;
  onToggle: () => void;
}) {
  void act(() => {
    renderer = create(<ComposerDictationButton {...props} />);
  });
  return renderer!.root;
}

describe("ComposerDictationButton behavior", () => {
  it("calls onToggle when the idle button is pressed", () => {
    const onToggle = vi.fn();
    const root = renderButton({ phase: "idle", disabled: false, onToggle });
    void act(() => {
      root.findByType("button").props.onClick();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps the recording button pressable with the stop label", () => {
    const onToggle = vi.fn();
    const root = renderButton({ phase: "recording", disabled: false, onToggle });
    const button = root.findByType("button");
    expect(button.props["aria-label"]).toBe("Stop recording and transcribe");
    expect(button.props["aria-pressed"]).toBe(true);
    void act(() => {
      button.props.onClick();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("disables the button while requesting the microphone", () => {
    const root = renderButton({ phase: "requesting", disabled: false, onToggle: () => {} });
    expect(root.findByType("button").props.disabled).toBe(true);
  });
});
