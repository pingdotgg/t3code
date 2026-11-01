import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useIncrementalTimelineEntries } from "./useIncrementalTimelineEntries";

let renderer: Root | undefined;
let entries: ReturnType<typeof useIncrementalTimelineEntries>;
function Probe({ threadKey }: { threadKey: string }) {
  // oxlint-disable-next-line t3code/no-manual-memo -- Exercise fresh caller inputs rather than compiler-stabilized references.
  "use no memo";
  const [ready, setReady] = useState(false);
  // Fresh equivalent inputs must converge even without compiler memoization.
  const value = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: [],
    optimisticMessages: [],
    anchoredMessages: [],
    attachmentUrlById: new Map(),
  });
  if (!ready) setReady(true);
  useLayoutEffect(() => {
    entries = value;
  });
  return null;
}
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("converges with fresh input collections during render retries and reuses committed rows", async () => {
  await act(() => {
    renderer = createRoot(document.createElement("div"));
    renderer.render(<Probe threadKey="first" />);
  });
  expect(entries).toEqual([]);
  const first = entries;
  await act(() => renderer!.render(<Probe threadKey="first" />));
  expect(entries).toBe(first);
  await act(() => renderer!.render(<Probe threadKey="second" />));
  expect(entries).toEqual([]);
  expect(entries).not.toBe(first);
});
