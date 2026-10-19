import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { shouldUseRestingComposerLayout } from "../composerFooterLayout";
import { useComposerFocusState } from "./useComposerFocusState";

let root: Root;
let composer: ReturnType<typeof useComposerFocusState>;
let isResting: boolean;

function ComposerProbe() {
  const state = useComposerFocusState();
  useLayoutEffect(() => {
    composer = state;
    isResting = shouldUseRestingComposerLayout({
      isExistingThread: true,
      isMobileViewport: false,
      isScrollCollapsed: state.isComposerScrollCollapsed,
      hasExpandedChrome: false,
      hasMultilinePrompt: false,
      timelineOverflows: true,
    });
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  await act(() => root.render(<ComposerProbe />));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("composer focus state", () => {
  it("stays expanded when the composer loses focus", async () => {
    await act(() => composer.setIsComposerFocused(true));
    expect(isResting).toBe(false);

    await act(() => composer.setIsComposerFocused(false));
    expect(isResting).toBe(false);
  });

  it("can collapse again on the next scroll after returning to the end", async () => {
    await act(() => composer.setIsComposerScrollCollapsed(true));
    expect(isResting).toBe(true);

    await act(() => composer.restoreAfterTimelineReachedEnd());
    expect(isResting).toBe(false);

    await act(() => composer.setIsComposerScrollCollapsed(true));
    expect(isResting).toBe(true);
  });

  it("does not move focus into the composer when the timeline reaches the end", async () => {
    await act(() => composer.setIsComposerScrollCollapsed(true));
    await act(() => composer.restoreAfterTimelineReachedEnd());
    expect(isResting).toBe(false);
    expect(composer.isComposerFocused).toBe(false);
  });
});
