import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "./usePreviewPanelInlineSize";

let renderer: ReactTestRenderer;
let result: PreviewPanelInlineSize;

function Panel(props: { containerWidth: number; open?: boolean; enabled?: boolean }) {
  const size = usePreviewPanelInlineSize(undefined, props);
  useLayoutEffect(() => {
    result = size;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const events = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  await act(() => {
    renderer = create(<Panel containerWidth={1_256} />);
  });
});

afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("usePreviewPanelInlineSize", () => {
  it("keeps the chat column width when the caller's row widens", async () => {
    expect(result.width).toBe(540);
    // App sidebar collapses: the 256px it frees goes to the panel.
    await act(() => renderer.update(<Panel containerWidth={1_512} />));
    expect(result.width).toBe(796);
  });

  it("has no viewport cap, so wide rows still go to the panel", async () => {
    await act(() => renderer.update(<Panel containerWidth={6_000} />));
    expect(result.width).toBe(5_284);
    await act(() => renderer.update(<Panel containerWidth={1_256} />));
    expect(result.width).toBe(540);
  });

  it.each([
    ["closed", { open: false }],
    ["maximized", { enabled: false }],
  ])("does not track the row while %s", async (_state, props) => {
    await act(() => renderer.update(<Panel containerWidth={1_256} {...props} />));
    await act(() => renderer.update(<Panel containerWidth={1_512} {...props} />));
    await act(() => renderer.update(<Panel containerWidth={1_512} />));
    expect(result.width).toBe(540);
  });
});
