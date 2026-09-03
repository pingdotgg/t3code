import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TERMINAL_RUNNING_ACCESSIBILITY_LABEL } from "./terminalRunningStatus";
import { TerminalRunningIndicator } from "./TerminalRunningIndicator";

const renderedComponents = vi.hoisted(() => ({
  StatusPulse: (props: { readonly children: ReactNode }) => props.children,
  SymbolView: (_props: Record<string, unknown>) => null,
  View: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("react-native", () => ({ View: renderedComponents.View }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: renderedComponents.SymbolView }));
vi.mock("../../components/StatusPulse", () => ({ StatusPulse: renderedComponents.StatusPulse }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let rendered: ReactTestRenderer | undefined;

function renderIndicator(selected: boolean) {
  act(() => {
    rendered = create(<TerminalRunningIndicator selected={selected} />);
  });
  if (rendered === undefined) {
    throw new Error("Expected the indicator to render");
  }
  return {
    container: rendered.root.findByType(renderedComponents.View),
    pulse: rendered.root.findByType(renderedComponents.StatusPulse),
    symbol: rendered.root.findByType(renderedComponents.SymbolView),
  };
}

describe("TerminalRunningIndicator", () => {
  afterEach(() => {
    act(() => rendered?.unmount());
    rendered = undefined;
  });

  it("renders the terminal glyph with an announced running state", () => {
    const { container, symbol } = renderIndicator(false);

    expect(container.props).toMatchObject({
      accessibilityLabel: TERMINAL_RUNNING_ACCESSIBILITY_LABEL,
      accessibilityRole: "image",
    });
    expect(symbol.props).toMatchObject({
      name: "terminal",
      size: 13,
      tintColorClassName: "accent-terminal-active",
      type: "monochrome",
    });
  });

  it("uses the selected-row foreground token on selected backgrounds", () => {
    const { pulse, symbol } = renderIndicator(true);

    expect(symbol.props.tintColorClassName).toBe("accent-user-bubble-foreground");
    expect(pulse.props.minimumOpacity).toBe(0.6);
  });
});
